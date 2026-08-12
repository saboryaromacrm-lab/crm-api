import {
  Body, Controller, Get, Inject, Injectable, Module, BadRequestException,
  ForbiddenException, NotFoundException, Param, ParseIntPipe, Post, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength,
  ValidateNested,
} from 'class-validator';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  comprobantes, comprobanteItems, comprobantePercepciones, facturaArchivos, facturaLecturas, proveedorArticulos,
  productoProveedores, productos, proveedores, proveedorImputaciones, proveedorPagos, sucursales, usuarios,
} from '../db/schema';
/* "Factura A 0115-00193307" — la misma etiqueta en la tabla, el detalle, el error
 * y ahora también en Pagos. Vive en `common` y no acá porque `pagos` la necesita
 * y este módulo ya importa de `pagos`: exportarla desde acá cerraba el ciclo. */
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { tienePermiso } from '../auth/auth.guard';
import { etiquetaDoc } from '../common/documentos';
import { normalizarPuntoVenta } from '../facturas/facturas.module';
import { InventarioModule } from '../inventario/inventario.module';
import { InventarioService } from '../inventario/inventario.service';
import { PreciosModule, PreciosService } from '../precios/precios.module';
import { PagosModule, PagosProveedorService } from '../pagos/pagos.module';

const TIPOS = ['orden_compra', 'remito', 'factura', 'liquidacion', 'nota_credito', 'nota_debito'] as const;

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** Para que los mensajes de error se lean como los diría una persona. */
const NOMBRE_TIPO: Record<(typeof TIPOS)[number], string> = {
  orden_compra: 'la orden de compra',
  remito: 'el remito',
  factura: 'la factura',
  liquidacion: 'la liquidación',
  nota_credito: 'la nota de crédito',
  nota_debito: 'la nota de débito',
};

/*
 * QUÉ HACE CADA TIPO — las tres preguntas que definen el circuito.
 * ============================================================================
 *                  ¿mueve stock?   ¿genera deuda?   ¿es fiscal?
 *   orden_compra         no              no             no
 *   remito          sí (recepción)       no             no
 *   factura         sí (recepción)       sí             SÍ
 *   liquidacion     sí (recepción)       sí             no      ← la mitad negra
 *   nota_credito    sí (devolución)   resta            SÍ
 *   nota_debito          no            suma            SÍ
 *
 * LA LIQUIDACIÓN aparece en las tres listas de "genera deuda" y "mueve stock" y
 * en NINGUNA de las fiscales. Las listas son explícitas a propósito —se leen y
 * se auditan— pero eso significa que **un tipo nuevo hay que agregarlo en todas**
 * o se cuela un documento que mueve mercadería y no aparece en lo que se debe.
 * Están todas marcadas con el comentario "LISTA DE TIPOS" para poder encontrarlas.
 */

/** Un comprobante no fiscal no discrimina IVA ni lleva percepciones. */
const esFiscal = (tipo: string) => tipo !== 'liquidacion';

/** Una percepción del pie de la factura (RG 5329, IIBB…). */
class PercepcionDto {
  @IsString() nombre!: string;
  @IsOptional() @IsNumber() alicuota?: number;
  @IsOptional() @IsIn(['neto', 'total']) base?: 'neto' | 'total';
  /** El del papel. Si no viene, se calcula con la alícuota. */
  @IsOptional() @IsNumber() importe?: number;
}

class ComprobanteItemDto {
  @IsInt() productoId!: number;
  @IsOptional() @IsInt() presentacionId?: number;
  @IsNumber() cantidad!: number;
  @IsOptional() @IsNumber() costoUnitario?: number;
  @IsOptional() @IsNumber() descuento?: number;
  @IsOptional() @IsNumber() iva?: number;
  /**
   * El código del artículo COMO LO IMPRIME LA FACTURA del proveedor, cuando el
   * renglón vino de la lectura del PDF. No se guarda en el ítem: alimenta el
   * mapeo aprendido (proveedor, código) → producto, que es lo que hace que la
   * próxima factura reconozca el artículo sola.
   */
  @IsOptional() @IsString() @MaxLength(40) codigoProveedor?: string;
  /** La descripción del papel, para poder auditar el mapeo después. */
  @IsOptional() @IsString() @MaxLength(200) descripcionPapel?: string;
}

/**
 * Costo que el comprobante deja como nuevo costo de catálogo. La factura ES la
 * lista de precios nueva del proveedor; sin esto, el costo cargado se queda
 * viejo en silencio y se vende con el margen equivocado.
 */
class ActualizarCostoDto {
  @IsInt() productoId!: number;
  /** Costo DEL BULTO, como viene en el papel. */
  @IsNumber() costo!: number;
  /**
   * Kg (granel) o unidades (entero) del bulto de ESTA entrega. Viaja junto con
   * el costo porque son un solo hecho — "la bolsa de 20 kg sale $40.000" — y
   * actualizar el precio con los kilos viejos dejaría el $/kg (que es lo que
   * fija la góndola) mintiendo.
   */
  @IsOptional() @IsNumber() cantidad?: number;
  @IsOptional() @IsNumber() descuento?: number;
  @IsOptional() @IsNumber() flete?: number;
}

/**
 * Pago que se registra EN EL MISMO ACTO de cargar el comprobante: el "contado"
 * de verdad. Hasta ahora `condicionPago: 'contado'` era solo una etiqueta —no
 * movía plata—, así que una factura pagada en efectivo seguía figurando como
 * deuda del proveedor.
 *
 * `cajaSesionId` decide de dónde sale: con turno, la plata sale de la caja de
 * esa sucursal y el arqueo lo muestra; sin turno, es plata de administración
 * que no pasa por ninguna caja (una transferencia del negocio).
 */
class PagoContadoDto {
  @IsNumber() importe!: number;
  @IsOptional() @IsIn(['efectivo', 'transferencia', 'tarjeta_debito', 'tarjeta_credito', 'cheque', 'qr', 'otro'])
  medio?: string;
  @IsOptional() @IsInt() cajaSesionId?: number;
  @IsOptional() @IsString() referencia?: string;
}

/** Pago de sucursal YA registrado que este comprobante toma (total o parcial). */
class TomarPagoDto {
  @IsInt() pagoId!: number;
  @IsNumber() importe!: number;
}

class CreateComprobanteDto {
  @IsIn(TIPOS as unknown as string[]) tipo!: (typeof TIPOS)[number];
  @IsOptional() @IsIn(['A', 'B', 'C', 'X']) letra?: 'A' | 'B' | 'C' | 'X';
  @IsOptional() @IsString() puntoVenta?: string;
  @IsOptional() @IsInt() numero?: number;
  @IsInt() proveedorId!: number;
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsIn(['borrador', 'confirmado', 'anulado']) estado?: 'borrador' | 'confirmado' | 'anulado';
  @IsOptional() @IsIn(['contado', 'cuenta_corriente']) condicionPago?: 'contado' | 'cuenta_corriente';
  @IsOptional() @IsBoolean() recepcion?: boolean;
  /** El descuento de PIE ("Bonif. 21,38 %"), aparte de los de cada renglón. */
  @IsOptional() @IsNumber() bonificacion?: number;
  /** Su importe tal como lo imprime la factura; si viene, gana sobre el %. */
  @IsOptional() @IsNumber() bonificacionImporte?: number;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PercepcionDto)
  percepciones?: PercepcionDto[];
  @IsOptional() @IsInt() refComprobanteId?: number;
  @IsOptional() @IsString() observaciones?: string;
  @IsOptional() @IsInt() usuarioId?: number;
  /** El CAE del papel. Viene del QR, no se tipea. */
  @IsOptional() @IsString() cae?: string;
  /**
   * La factura de la bandeja que este comprobante viene a cerrar. Se marca
   * `cargada` en la MISMA transacción: si el comprobante no queda, la factura
   * tampoco se da por procesada.
   */
  @IsOptional() @IsInt() lecturaId?: number;
  @IsOptional() @IsString() fecha?: string;
  @IsOptional() @IsString() fechaCarga?: string;
  @IsOptional() @IsString() vencimientoPago?: string;
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => ComprobanteItemDto)
  items!: ComprobanteItemDto[];
  /** Los que el usuario tildó en "diferencias de costo" al cargar el comprobante. */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ActualizarCostoDto)
  actualizarCostos?: ActualizarCostoDto[];
  /**
   * Productos cuyo proveedor activo pasa a ser el de este comprobante. Es una
   * decisión explícita del usuario en la recepción: cambia qué costo manda el
   * precio de venta, así que no puede ser automático.
   */
  @IsOptional() @IsArray() @IsInt({ each: true })
  activarProveedor?: number[];

  /** El resto que se paga ahora (contado). Ver `PagoContadoDto`. */
  @IsOptional() @ValidateNested() @Type(() => PagoContadoDto)
  pagoContado?: PagoContadoDto;

  /**
   * Pagos que la cajera hizo desde la sucursal y este comprobante toma. Es la
   * forma en que se "aplica" un pago: al cargar la factura, no con un botón
   * suelto en la bandeja.
   */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TomarPagoDto)
  tomarPagos?: TomarPagoDto[];
}

@Injectable()
export class ComprobantesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly inv: InventarioService,
    private readonly precios: PreciosService,
    /** El pago es del proveedor, no del comprobante: acá solo se lo invoca. */
    private readonly pagos: PagosProveedorService,
  ) {}

  private async withItems(c: any) {
    const items = await this.db.select().from(comprobanteItems).where(eq(comprobanteItems.comprobanteId, c.id));
    return { ...c, items };
  }

  /**
   * LAS NOTAS QUE AJUSTAN CADA FACTURA, en una consulta para todas.
   * ============================================================================
   * Una nota de crédito o de débito casi nunca vive sola: nace de UNA factura —
   * la mercadería que se devolvió de esa entrega, el flete que se olvidaron de
   * cobrar en ese remito. `refComprobanteId` guarda de cuál.
   *
   * Sin esto, la NC solo restaba de la deuda TOTAL del proveedor y la factura
   * seguía ofreciendo su importe entero para pagar: el que paga factura por
   * factura le pagaba de más, aunque la cuenta del proveedor cerrara bien.
   *
   * Signo: la **ND suma** (el proveedor cobra más por esa factura) y la
   * **NC resta**. Devuelve un Map por el id de la FACTURA referenciada.
   */
  private async ajustesDe(idsFactura: number[]) {
    const porFactura = new Map<number, { ajuste: number; notas: any[] }>();
    if (!idsFactura.length) return porFactura;

    const notas = await this.db.select({
      id: comprobantes.id,
      tipo: comprobantes.tipo,
      letra: comprobantes.letra,
      puntoVenta: comprobantes.puntoVenta,
      numero: comprobantes.numero,
      fecha: comprobantes.fecha,
      total: comprobantes.total,
      observaciones: comprobantes.observaciones,
      refComprobanteId: comprobantes.refComprobanteId,
    }).from(comprobantes).where(and(
      inArray(comprobantes.refComprobanteId, idsFactura),
      inArray(comprobantes.tipo, ['nota_credito', 'nota_debito']),
      eq(comprobantes.estado, 'confirmado'),
    )).orderBy(comprobantes.id);

    for (const n of notas) {
      const ref = n.refComprobanteId!;
      const acc = porFactura.get(ref) ?? { ajuste: 0, notas: [] };
      const signo = n.tipo === 'nota_debito' ? 1 : -1;
      acc.ajuste = r2(acc.ajuste + signo * n.total);
      acc.notas.push({ ...n, signo });
      porFactura.set(ref, acc);
    }
    return porFactura;
  }

  /**
   * El saldo de VERDAD de un comprobante: lo que dice el papel, más lo que sus
   * notas de débito le agregaron, menos lo que sus notas de crédito le
   * descontaron, menos lo que ya se pagó.
   */
  private saldoReal(c: { total: number; pagado: number }, ajuste = 0) {
    return r2(c.total + ajuste - c.pagado);
  }

  /**
   * De dónde salió la plata de estos comprobantes, en UNA consulta para todos.
   *
   * Es lo que hace identificable en la tabla que una factura se pagó con plata
   * que salió de la caja de una sucursal: viaja el nombre de la sucursal, el
   * turno y el cajero. Devuelve un Map por comprobanteId.
   */
  private async pagosDe(ids: number[]) {
    const porId = new Map<number, any[]>();
    if (!ids.length) return porId;

    const filas = await this.db.select({
      comprobanteId: proveedorImputaciones.comprobanteId,
      importe: proveedorImputaciones.importe,
      pagoId: proveedorPagos.id,
      fecha: proveedorPagos.fecha,
      medio: proveedorPagos.medio,
      concepto: proveedorPagos.concepto,
      cajaSesionId: proveedorPagos.cajaSesionId,
      sucursalId: proveedorPagos.sucursalId,
      sucursalNombre: sucursales.nombre,
      usuarioNombre: usuarios.nombre,
    })
      .from(proveedorImputaciones)
      .innerJoin(proveedorPagos, eq(proveedorPagos.id, proveedorImputaciones.pagoId))
      .leftJoin(sucursales, eq(sucursales.id, proveedorPagos.sucursalId))
      .leftJoin(usuarios, eq(usuarios.id, proveedorPagos.usuarioId))
      .where(and(
        inArray(proveedorImputaciones.comprobanteId, ids),
        eq(proveedorPagos.estado, 'activo'),
      ))
      .orderBy(proveedorImputaciones.id);

    for (const f of filas) {
      const arr = porId.get(f.comprobanteId!) ?? [];
      arr.push(f);
      porId.set(f.comprobanteId!, arr);
    }
    return porId;
  }

  async list(q: { proveedorId?: number; tipo?: string; estado?: string; verLiquidaciones?: boolean }) {
    const conds: any[] = [];
    if (q.proveedorId) conds.push(eq(comprobantes.proveedorId, Number(q.proveedorId)));
    if (q.tipo) conds.push(eq(comprobantes.tipo, q.tipo as any));
    if (q.estado) conds.push(eq(comprobantes.estado, q.estado as any));
    /*
     * SIN el permiso `liquidaciones`, la mitad no facturada no viaja — ni
     * pidiéndola por `?tipo=liquidacion`. El `ne` corre igual que el filtro de
     * arriba, así que la combinación "pedí liquidaciones y no puedo verlas"
     * devuelve vacío en vez de todo.
     */
    if (!q.verLiquidaciones) conds.push(ne(comprobantes.tipo, 'liquidacion' as any));
    const where = conds.length ? and(...conds) : undefined;
    const rows = await this.db.select().from(comprobantes).where(where).orderBy(desc(comprobantes.id));
    if (!rows.length) return [];

    /*
     * Ítems y pagos de TODOS los comprobantes en dos consultas, no una por
     * fila. Antes esto hacía un SELECT de ítems por comprobante: con seis
     * facturas no se nota, con las miles de un año son miles de viajes por
     * cada vez que se abre la pantalla.
     */
    const ids = rows.map((c) => c.id);
    const [items, pagos, percs, ajustes] = await Promise.all([
      this.db.select().from(comprobanteItems).where(inArray(comprobanteItems.comprobanteId, ids)),
      this.pagosDe(ids),
      this.db.select().from(comprobantePercepciones).where(inArray(comprobantePercepciones.comprobanteId, ids)),
      this.ajustesDe(ids),
    ]);
    const itemsPorId = new Map<number, any[]>();
    for (const it of items) {
      const arr = itemsPorId.get(it.comprobanteId) ?? [];
      arr.push(it);
      itemsPorId.set(it.comprobanteId, arr);
    }
    const percsPorId = new Map<number, any[]>();
    for (const p of percs) {
      const arr = percsPorId.get(p.comprobanteId) ?? [];
      arr.push(p);
      percsPorId.set(p.comprobanteId, arr);
    }

    /*
     * La etiqueta de la factura que ajusta cada nota, para que la tabla pueda
     * decir "NC de la Factura A 0115-193307" sin pedir el detalle.
     *
     * Se piden las referenciadas que NO están en el resultado: con el filtro
     * puesto en "notas de crédito", la factura de la que salen no viene en
     * `rows` y la etiqueta quedaba vacía justo donde más se necesita.
     */
    const etiquetas = new Map<number, string>(rows.map((c) => [c.id, etiquetaDoc(c)]));
    const refsFaltantes = [...new Set(
      rows.map((c) => c.refComprobanteId).filter((x): x is number => !!x && !etiquetas.has(x)),
    )];
    if (refsFaltantes.length) {
      const refs = await this.db.select({
        id: comprobantes.id, tipo: comprobantes.tipo, letra: comprobantes.letra,
        puntoVenta: comprobantes.puntoVenta, numero: comprobantes.numero,
      }).from(comprobantes).where(inArray(comprobantes.id, refsFaltantes));
      for (const r of refs) etiquetas.set(r.id, etiquetaDoc(r));
    }

    return rows.map((c) => {
      const aj = ajustes.get(c.id);
      return {
        ...c,
        items: itemsPorId.get(c.id) ?? [],
        percepciones: percsPorId.get(c.id) ?? [],
        pagos: pagos.get(c.id) ?? [],
        // Lo que sus notas le sumaron o restaron, y cuáles fueron.
        ajuste: aj?.ajuste ?? 0,
        notas: aj?.notas ?? [],
        // Si ESTA fila es una nota: a qué factura pertenece.
        refEtiqueta: c.refComprobanteId ? (etiquetas.get(c.refComprobanteId) ?? '') : '',
        saldo: this.saldoReal(c, aj?.ajuste ?? 0),
      };
    });
  }

  /**
   * Un comprobante con lo mismo que devuelve el listado: ítems, los pagos que
   * lo cancelaron (con su sucursal y turno) y el saldo. La forma es idéntica
   * para que el detalle y la tabla lean el mismo objeto y no haya un campo que
   * exista en una pantalla y falte en la otra.
   */
  async get(id: number) {
    const [c] = await this.db.select().from(comprobantes).where(eq(comprobantes.id, id)).limit(1);
    if (!c) throw new NotFoundException('Comprobante inexistente.');
    const [conItems, pagos, percepciones, papeles] = await Promise.all([
      this.withItems(c),
      this.pagosDe([id]),
      this.db.select().from(comprobantePercepciones).where(eq(comprobantePercepciones.comprobanteId, id)),
      /* El papel del que salió esta factura, si entró por la bandeja o si
       * alguien lo engachó después. Es lo que se mira cuando el total no cierra
       * seis meses más tarde. Solo los metadatos: los bytes se piden por URL. */
      this.db.select({
        id: facturaArchivos.id, nombre: facturaArchivos.nombre, mime: facturaArchivos.mime,
      }).from(facturaArchivos)
        .innerJoin(facturaLecturas, eq(facturaLecturas.id, facturaArchivos.lecturaId))
        .where(eq(facturaLecturas.comprobanteId, id))
        .orderBy(facturaArchivos.id),
    ]);

    /* Las dos puntas del vínculo con las notas: si es una FACTURA, cuáles la
     * ajustan; si es una NOTA, de qué factura salió. El detalle tiene que poder
     * explicar el total sin que nadie cruce dos pantallas. */
    const ajustes = await this.ajustesDe([id]);
    const aj = ajustes.get(id);
    let ref: any = null;
    if (c.refComprobanteId) {
      const [r] = await this.db.select().from(comprobantes)
        .where(eq(comprobantes.id, c.refComprobanteId)).limit(1);
      if (r) ref = { id: r.id, etiqueta: etiquetaDoc(r), fecha: r.fecha, total: r.total };
    }

    return {
      ...conItems,
      percepciones,
      papeles,
      pagos: pagos.get(id) ?? [],
      ajuste: aj?.ajuste ?? 0,
      notas: aj?.notas ?? [],
      ref,
      refEtiqueta: ref?.etiqueta ?? '',
      saldo: this.saldoReal(c, aj?.ajuste ?? 0),
    };
  }

  /**
   * LAS FACTURAS QUE UNA NOTA PUEDE AJUSTAR.
   * ============================================================================
   * Alimenta el selector del paso 3 al cargar una NC o una ND. Solo facturas
   * confirmadas del MISMO proveedor: una nota no puede ajustar la factura de
   * otro, ni un remito (que no genera deuda), ni otra nota.
   *
   * Cada una viene con su saldo REAL —descontando lo pagado y lo que ya le
   * ajustaron otras notas— porque es el número contra el que el usuario decide.
   */
  async referenciables(proveedorId: number) {
    const facturas = await this.db.select().from(comprobantes).where(and(
      eq(comprobantes.proveedorId, proveedorId),
      eq(comprobantes.tipo, 'factura'),
      eq(comprobantes.estado, 'confirmado'),
    )).orderBy(desc(comprobantes.fecha), desc(comprobantes.id));
    if (!facturas.length) return [];

    const ajustes = await this.ajustesDe(facturas.map((f) => f.id));
    return facturas.map((f) => {
      const aj = ajustes.get(f.id);
      return {
        id: f.id,
        etiqueta: etiquetaDoc(f),
        fecha: f.fecha,
        total: f.total,
        pagado: f.pagado,
        ajuste: aj?.ajuste ?? 0,
        notas: (aj?.notas ?? []).length,
        saldo: this.saldoReal(f, aj?.ajuste ?? 0),
      };
    });
  }

  /**
   * Lo que ya no se trae NO entra por una factura de compra. Vale para
   * discontinuado y archivado: si el producto volvió, la decisión es
   * reactivarlo (un clic, conserva precios e historial), no cargarlo como si
   * nunca se hubiera dado de baja — así el estado no miente.
   */
  private async validarProductosComprables(items: Array<{ productoId: number }>) {
    const ids = [...new Set((items ?? []).map((it) => it.productoId).filter(Boolean))];
    if (!ids.length) return;
    const dados = await this.db.select({ nombre: productos.nombre, estado: productos.estado })
      .from(productos).where(and(inArray(productos.id, ids), ne(productos.estado, 'activo')));
    if (dados.length) {
      const nombres = dados.map((d) => `${d.nombre} (${d.estado})`).join(', ');
      throw new BadRequestException(
        `Estos productos ya no se compran: ${nombres}. Si volvés a traerlos, reactivalos en Compras › Productos y cargá la factura de nuevo.`,
      );
    }
  }

  async create(dto: CreateComprobanteDto, opciones: { puedeTocarPrecios?: boolean; sucursalSesion: number }) {
    /*
     * RECIBIR MERCADERÍA Y TOCAR PRECIOS SON DOS PERMISOS DISTINTOS.
     *
     * Estos dos bloques del alta llaman al servicio de precios por adentro, así
     * que sin este corte alcanzaba `compras.facturacion` para reescribir el
     * costo de catálogo —y con él el precio de góndola— salteando el
     * `@Permiso('precios')` que cierra su controller.
     *
     * Se RECHAZA en vez de ignorar en silencio: quien recibe la mercadería tildó
     * "actualizar costos" y tiene que enterarse de que eso no se aplicó, no
     * descubrirlo la semana que viene mirando un margen que nunca cambió.
     */
    if (!opciones.puedeTocarPrecios && (dto.actualizarCostos?.length || dto.activarProveedor?.length)) {
      throw new ForbiddenException(
        'Para actualizar costos o cambiar el proveedor activo hace falta el permiso de precios. '
        + 'Registrá el comprobante sin esa parte y pedile a quien maneja precios que la haga.',
      );
    }

    const [prov] = await this.db.select().from(proveedores).where(eq(proveedores.id, dto.proveedorId)).limit(1);
    if (!prov) throw new BadRequestException('Proveedor inválido.');
    if (!dto.items?.length) throw new BadRequestException('Agregá al menos un ítem.');
    await this.validarProductosComprables(dto.items);

    // Un proveedor monotributista o exento NO discrimina IVA: asumir 21% inflaría
    // el total del comprobante y ensuciaría el libro de IVA compras.
    const discrimina = prov.condicionIva === 'responsable_inscripto';
    const ivaDefault = discrimina ? 21 : 0;

    /* ------------------------- EL PIE DE LA FACTURA -------------------------
     * En el mismo orden en que lo lee el papel: los renglones dan el bruto, la
     * bonificación general lo baja, el IVA se calcula sobre el neto YA
     * bonificado (si se calculara antes, el IVA quedaría más alto que el de la
     * factura) y las percepciones se suman al final — no son IVA, son pago a
     * cuenta de otro impuesto.
     */
    let bruto = 0;
    const items = dto.items.map((it) => {
      const cantidad = Number(it.cantidad) || 0;
      const costo = Number(it.costoUnitario) || 0;
      const desc = Number(it.descuento) || 0;
      const ivaP = it.iva != null ? Number(it.iva) : ivaDefault;
      const neto = cantidad * costo * (1 - desc / 100);
      bruto += neto;
      return { ...it, iva: ivaP, subtotal: neto };
    });

    // La bonificación llega como % o como importe: el IMPORTE manda cuando
    // viene, porque el proveedor redondea a su manera y el total tiene que dar
    // igual al del papel, al centavo.
    const bonifPct = Number(dto.bonificacion) || 0;
    if (bonifPct < 0 || bonifPct >= 100) {
      if (bonifPct !== 0) throw new BadRequestException('La bonificación tiene que estar entre 0 y 100%.');
    }
    let bonificacionImporte = dto.bonificacionImporte != null
      ? Number(dto.bonificacionImporte) || 0
      : r2(bruto * bonifPct / 100);
    if (bonificacionImporte > bruto + 0.009) {
      throw new BadRequestException('La bonificación no puede ser mayor que el subtotal de los ítems.');
    }
    if (bonificacionImporte < 0) bonificacionImporte = 0;
    // El factor real, para repartir la bonificación entre los renglones y que
    // el libro de IVA cierre con el neto gravado de cada alícuota.
    const factorBonif = bruto > 0 ? 1 - bonificacionImporte / bruto : 1;

    /*
     * EN UNA LIQUIDACIÓN EL IVA ES CERO, y se fuerza acá y no en la pantalla.
     *
     * No es cosmético: si el renglón guardara su 21%, el importe existiría en la
     * base y cualquier suma futura de IVA de compras lo levantaría como crédito
     * fiscal de una factura que no existe. El precio de la mitad no facturada ya
     * viene sin IVA — es la razón por la que es más barata.
     */
    const fiscal = esFiscal(dto.tipo);
    let subtotalNeto = 0;
    let ivaTotal = 0;
    for (const it of items) {
      const neto = it.subtotal * factorBonif;
      it.subtotal = neto;
      subtotalNeto += neto;
      if (!fiscal) it.iva = 0;
      ivaTotal += neto * it.iva / 100;
    }

    // Percepciones: cada una con su nombre y alícuota copiados del proveedor,
    // porque la factura del año pasado tiene que seguir explicando su total.
    const conIva = subtotalNeto + ivaTotal;
    // Las percepciones son pago a cuenta de un impuesto: en un comprobante que
    // no existe para ARCA no hay nada a cuenta de qué. Se descartan.
    const percepciones = (fiscal ? (dto.percepciones ?? []) : [])
      .filter((p) => (p?.nombre ?? '').trim())
      .map((p) => {
        const base = p.base === 'total' ? 'total' : 'neto';
        const alicuota = Number(p.alicuota) || 0;
        const calculado = (base === 'total' ? conIva : subtotalNeto) * alicuota / 100;
        // El importe del papel gana: el proveedor puede redondear distinto.
        const importe = p.importe != null ? Number(p.importe) || 0 : r2(calculado);
        return { nombre: String(p.nombre).trim(), alicuota, base: base as 'neto' | 'total', importe };
      })
      .filter((p) => p.importe > 0.009);
    const percepcionesTotal = percepciones.reduce((a, p) => a + p.importe, 0);

    const total = subtotalNeto + ivaTotal + percepcionesTotal;
    const estado = dto.estado ?? 'confirmado';
    // El papel imprime cinco dígitos y el sistema usa cuatro: normalizar acá es
    // lo que hace que el único de la base cruce las dos formas de cargarlo.
    const puntoVenta = normalizarPuntoVenta(dto.puntoVenta ?? '0001');
    // LISTA DE TIPOS · mueve stock hacia adentro. La liquidación va acá: la
    // mercadería de la mitad no facturada entró al depósito igual que la otra.
    const ingresaStock = estado !== 'anulado' && !!dto.recepcion
      && (dto.tipo === 'remito' || dto.tipo === 'factura' || dto.tipo === 'liquidacion');
    /**
     * UNA NOTA DE CRÉDITO CON RECEPCIÓN **SACA** MERCADERÍA.
     *
     * Faltaba: la NC ya descontaba la deuda pero la mercadería devuelta quedaba
     * en stock. No se puede hacer automático por tipo, porque una NC no siempre
     * es una devolución: también ajusta un precio mal facturado o compensa un
     * bulto roto que igual te quedaste. Por eso lo decide `recepcion`, que acá
     * significa "esta NC devuelve mercadería".
     */
    const egresaStock = estado !== 'anulado' && !!dto.recepcion && dto.tipo === 'nota_credito';
    if ((ingresaStock || egresaStock) && !dto.sucursalId) {
      throw new BadRequestException('Indicá la sucursal de recepción.');
    }

    /**
     * LA FACTURA QUE LA NOTA AJUSTA.
     * ==========================================================================
     * Una NC o ND nace de UNA factura: la mercadería que se devolvió de esa
     * entrega, el flete que no se cobró en ese remito. Atarla es lo que hace que
     * el saldo de esa factura diga la verdad — sin la referencia, la NC restaba
     * de la deuda total del proveedor y la factura seguía ofreciendo su importe
     * entero para pagar.
     *
     * Se valida acá y no en el DTO porque son reglas de datos, no de forma: el
     * proveedor tiene que ser el mismo, tiene que ser una factura (un remito no
     * genera deuda y una nota no se ajusta con otra nota) y tiene que estar
     * confirmada.
     */
    const esNota = dto.tipo === 'nota_credito' || dto.tipo === 'nota_debito';
    if (dto.refComprobanteId != null) {
      if (!esNota) {
        throw new BadRequestException('Solo una nota de crédito o de débito ajusta a otro comprobante.');
      }
      const [ref] = await this.db.select().from(comprobantes)
        .where(eq(comprobantes.id, dto.refComprobanteId)).limit(1);
      if (!ref) throw new BadRequestException('La factura que se quiere ajustar no existe.');
      if (ref.proveedorId !== prov.id) {
        throw new BadRequestException(`Esa factura no es de ${prov.nombre}: una nota no puede ajustar la factura de otro proveedor.`);
      }
      if (ref.tipo !== 'factura') {
        throw new BadRequestException(`Una nota solo ajusta una factura, y ${etiquetaDoc(ref)} no lo es.`);
      }
      if (ref.estado !== 'confirmado') {
        throw new BadRequestException(`${etiquetaDoc(ref)} está ${ref.estado}: no se le pueden aplicar notas.`);
      }
    }

    /**
     * El mismo comprobante no se carga dos veces. El índice único de la base es
     * la garantía real (dos pestañas en paralelo se pasan por arriba de este
     * chequeo), pero sin esto el usuario veía un error de Postgres en crudo.
     */
    if (dto.numero) {
      const [ya] = await this.db.select({ id: comprobantes.id }).from(comprobantes).where(and(
        eq(comprobantes.proveedorId, prov.id),
        eq(comprobantes.tipo, dto.tipo),
        eq(comprobantes.puntoVenta, puntoVenta),
        eq(comprobantes.numero, dto.numero),
      )).limit(1);
      if (ya) {
        throw new BadRequestException(
          `${prov.nombre} ya tiene cargada ${NOMBRE_TIPO[dto.tipo]} ${puntoVenta}-${dto.numero} (comprobante #${ya.id}).`,
        );
      }
    }

    const id = await this.db.transaction(async (tx) => {
      const [c] = await tx.insert(comprobantes).values({
        tipo: dto.tipo,
        /* La liquidación es SIEMPRE letra X y no se deja elegir: la A significa
         * "discrimina IVA" y este comprobante no discrimina nada. Con letra A la
         * etiqueta decía "Liquidación A", que promete algo que no hay. */
        letra: fiscal ? (dto.letra ?? 'A') : 'X',
        puntoVenta,
        numero: dto.numero ?? null,
        fecha: dto.fecha ? new Date(dto.fecha) : undefined,
        fechaCarga: dto.fechaCarga ? new Date(dto.fechaCarga) : undefined, proveedorId: prov.id, sucursalId: dto.sucursalId ?? null,
        estado, condicionPago: dto.condicionPago ?? 'cuenta_corriente',
        vencimientoPago: dto.vencimientoPago ? new Date(dto.vencimientoPago) : null,
        recepcion: !!dto.recepcion,
        bonificacion: bonifPct, bonificacionImporte: r2(bonificacionImporte),
        subtotalNeto, ivaTotal, percepcionesTotal: r2(percepcionesTotal), total,
        /* Un comprobante no fiscal NO GUARDA CAE. Se podía cargar el papel de una
         * factura A real (con su CAE y su IVA) eligiendo tipo liquidación: la
         * API forzaba IVA 0 y letra X pero se guardaba el CAE igual, y quedaba un
         * no fiscal con número de autorización de ARCA. Aparte de perder el
         * crédito fiscal de esa factura, deja lista la trampa para cualquier
         * chequeo futuro del estilo "tiene CAE ⇒ es fiscal". */
        cae: fiscal ? String(dto.cae ?? '').slice(0, 32) : '',
        refComprobanteId: dto.refComprobanteId ?? null, observaciones: dto.observaciones ?? '', usuarioId: dto.usuarioId ?? null,
      }).returning();

      await tx.insert(comprobanteItems).values(items.map((it) => ({
        comprobanteId: c.id, productoId: it.productoId, presentacionId: it.presentacionId ?? null,
        cantidad: Number(it.cantidad) || 0, costoUnitario: Number(it.costoUnitario) || 0,
        descuento: Number(it.descuento) || 0, iva: it.iva, subtotal: it.subtotal,
      })));

      /*
       * APRENDER EL MAPEO DE ARTÍCULOS. Si el renglón vino de la lectura del
       * PDF trae el código con el que el proveedor lo imprime: acá — recién al
       * GUARDAR, o sea con una persona confirmando la factura entera — se
       * recuerda (proveedor, código) → producto. La próxima factura del mismo
       * proveedor reconoce el artículo sin similitudes de nombre.
       *
       * Es upsert: si el mapeo existía y el admin eligió otro producto en este
       * alta, la elección nueva PISA la vieja. Un mapeo mal aprendido se
       * corrige solo en la factura siguiente.
       */
      for (const it of dto.items) {
        const codigo = String(it.codigoProveedor ?? '').trim();
        if (!codigo) continue;
        await tx.insert(proveedorArticulos).values({
          proveedorId: prov.id,
          codigo,
          productoId: it.productoId,
          descripcion: String(it.descripcionPapel ?? '').trim().slice(0, 200),
          actualizadoEn: new Date(),
        }).onConflictDoUpdate({
          target: [proveedorArticulos.proveedorId, proveedorArticulos.codigo],
          set: {
            productoId: it.productoId,
            descripcion: String(it.descripcionPapel ?? '').trim().slice(0, 200),
            actualizadoEn: new Date(),
          },
        });
      }

      if (percepciones.length) {
        await tx.insert(comprobantePercepciones).values(
          percepciones.map((p) => ({ comprobanteId: c.id, ...p })),
        );
      }

      if (ingresaStock) {
        await this.inv.ingresarStockItems(tx, {
          sucursalId: dto.sucursalId, proveedorId: prov.id, proveedorNombre: prov.nombre, usuarioId: dto.usuarioId,
          descripcion: `Recepción ${dto.tipo} ${c.puntoVenta}-${c.numero ?? c.id}`, items: dto.items,
        });
      }

      /* La devolución al proveedor: sale del stock disponible. Si no hay
       * cantidad suficiente el helper corta la transacción — mejor que dejar
       * stock negativo por una NC cargada con el número de bultos equivocado. */
      if (egresaStock) {
        await this.inv.egresarStockItems(tx, {
          sucursalId: dto.sucursalId, usuarioId: dto.usuarioId, tipoMovimiento: 'devolucion',
          descripcion: `Devolución a ${prov.nombre} · NC ${c.puntoVenta}-${c.numero ?? c.id}`,
          items: dto.items,
        });
      }

      /**
       * Los costos que el usuario aceptó actualizar viajan en la MISMA
       * transacción que el comprobante: o queda todo o no queda nada. Se hace
       * después del ingreso de stock porque ese paso puede crear la entrada
       * producto/proveedor que recién entonces existe para actualizar.
       */
      const pedidos = (dto.actualizarCostos ?? []).filter((x) => Number(x.costo) > 0);
      if (pedidos.length) {
        const entradas = await tx.select().from(productoProveedores)
          .where(and(
            eq(productoProveedores.proveedorId, prov.id),
            inArray(productoProveedores.productoId, pedidos.map((x) => x.productoId)),
          ));
        const porProducto = new Map(entradas.map((e: any) => [e.productoId, e.id]));

        /**
         * El tamaño del bulto de ESTA entrega (kg o unidades) se actualiza en
         * la misma transacción y ANTES que el costo: si la bolsa pasó de 25 a
         * 20 kg, el precio nuevo del bulto solo tiene sentido con los kilos
         * nuevos — por separado, el $/kg quedaría mal y la góndola con él.
         */
        for (const x of pedidos) {
          const cant = Number(x.cantidad);
          const id = porProducto.get(x.productoId);
          if (id && cant > 0) {
            await tx.update(productoProveedores).set({ cantidad: cant })
              .where(eq(productoProveedores.id, id));
          }
        }

        const cambios = pedidos
          .map((x) => {
            const id = porProducto.get(x.productoId);
            return id ? { id, costo: x.costo, descuento: x.descuento, flete: x.flete } : null;
          })
          .filter(Boolean) as any[];

        if (cambios.length) {
          await this.precios.actualizarCostos({
            cambios,
            origen: 'recepcion',
            motivo: `${dto.tipo} ${c.puntoVenta}-${c.numero ?? c.id} · ${prov.nombre}`,
            usuarioId: dto.usuarioId,
            comprobanteId: c.id,
          } as any, tx);
        }
      }

      // Y el cambio de proveedor activo, si el usuario lo tildó. Va después de
      // actualizar costos para que el precio nuevo salga con el costo nuevo.
      if (dto.activarProveedor?.length) {
        await this.precios.activarProveedor({
          productoIds: dto.activarProveedor,
          proveedorId: prov.id,
          origen: 'recepcion',
          motivo: `${dto.tipo} ${c.puntoVenta}-${c.numero ?? c.id} · ${prov.nombre}`,
          usuarioId: dto.usuarioId,
          comprobanteId: c.id,
        }, tx);
      }

      /**
       * Y se cierra la factura de la bandeja, en la MISMA transacción: si el
       * comprobante no llega a quedar, el papel sigue esperando. Es un UPDATE de
       * una línea y por eso va acá y no invocando al módulo de facturas — traer
       * un módulo entero para esto ataba dos servicios sin necesidad.
       */
      if (dto.lecturaId) {
        await tx.update(facturaLecturas)
          .set({ estado: 'cargada', comprobanteId: c.id })
          .where(and(eq(facturaLecturas.id, dto.lecturaId), eq(facturaLecturas.estado, 'pendiente')));
      }
      return c.id;
    });
    // La evolución de precios se registra DESPUÉS del commit: dentro de la
    // transacción los costos nuevos todavía no son visibles para el snapshot.
    const tocados = [
      ...(dto.actualizarCostos ?? []).map((x) => x.productoId),
      ...(dto.activarProveedor ?? []),
    ];
    if (tocados.length) {
      await this.precios.registrarEvolucion(tocados, 'costo', {
        detalle: 'Recepción de comprobante', usuarioId: dto.usuarioId ?? null,
      });
    }

    /*
     * EL PAGO, después del commit del comprobante y a propósito.
     *
     * Va afuera de la transacción porque `PagosProveedorService` maneja la suya
     * (el pago, su egreso de caja y el recálculo son una sola operación). Si el
     * pago falla —turno cerrado, el pago que se quiso tomar ya no tiene saldo—,
     * el comprobante queda cargado y con deuda: un estado válido y recuperable
     * desde el detalle. Perder también la carga de la factura sería peor.
     *
     * Solo los documentos que GENERAN deuda se pagan. Una nota de crédito
     * resta deuda: pagarla no significa nada.
     */
    // LISTA DE TIPOS · genera deuda. La liquidación va acá: al proveedor se le
    // debe la mitad no facturada igual que la facturada, y se le paga junto.
    const generaDeuda = estado === 'confirmado'
      && (dto.tipo === 'factura' || dto.tipo === 'liquidacion' || dto.tipo === 'nota_debito');
    if (generaDeuda) {
      // Primero los pagos que ya existían: es plata que ya salió del cajón y
      // la factura viene a explicarla.
      for (const t of dto.tomarPagos ?? []) {
        await this.pagos.imputar(Number(t.pagoId), {
          imputaciones: [{ comprobanteId: id, importe: Number(t.importe) }],
          usuarioId: dto.usuarioId,
        });
      }
      // Y después el resto que se paga en el acto.
      const contado = Number(dto.pagoContado?.importe) || 0;
      if (contado > 0) {
        await this.pagos.crear({
          proveedorId: prov.id,
          destino: 'mercaderia',
          importe: contado,
          medio: dto.pagoContado?.medio,
          fecha: dto.fecha,
          concepto: `${dto.tipo} ${dto.letra ?? 'A'} ${puntoVenta}-${dto.numero ?? id}`.trim(),
          referencia: dto.pagoContado?.referencia,
          sucursalId: dto.sucursalId,
          cajaSesionId: dto.pagoContado?.cajaSesionId,
          usuarioId: dto.usuarioId,
          imputaciones: [{ comprobanteId: id, importe: contado }],
        }, opciones.sucursalSesion);
      }

      /*
       * La CONDICIÓN se deriva de lo que realmente se pagó en el acto, no de lo
       * que dijo el que llamó: quedó saldado = contado, quedó saldo = cuenta
       * corriente. Así el campo no puede contradecir al saldo — que es
       * exactamente lo que pasaba antes, cuando "contado" era solo una etiqueta.
       *
       * Se fija UNA vez, al crear: describe cómo se acordó esta compra. Que una
       * factura en cuenta corriente se pague después no la convierte en contado.
       */
      if ((dto.tomarPagos?.length || contado > 0)) {
        const [final] = await this.db.select({ total: comprobantes.total, pagado: comprobantes.pagado })
          .from(comprobantes).where(eq(comprobantes.id, id)).limit(1);
        const saldado = final && final.pagado >= final.total - 0.009;
        await this.db.update(comprobantes)
          .set({ condicionPago: saldado ? 'contado' : 'cuenta_corriente' })
          .where(eq(comprobantes.id, id));
      }
    }
    return this.get(id);
  }

  /**
   * Cuenta corriente del proveedor por MERCADERÍA: facturas + ND − NC, menos lo
   * que ya se le pagó contra esos comprobantes (`pagado`, que mantiene el
   * módulo de Pagos a proveedores).
   *
   * Ojo con el alcance: acá solo entran los comprobantes de compra. La cuenta
   * COMPLETA del proveedor —que además suma sus gastos y sus pagos a cuenta sin
   * aplicar— la arma `GET /pagos-proveedor/cuenta/:id`.
   */
  async cuenta(proveedorId: number) {
    const cs = await this.db.select().from(comprobantes)
      .where(and(eq(comprobantes.proveedorId, proveedorId), eq(comprobantes.estado, 'confirmado')))
      .orderBy(desc(comprobantes.id));
    let deuda = 0;
    let pagado = 0;
    for (const c of cs) {
      // Antes solo contaba la cta. cte.: una factura al contado sin pago
      // registrado desaparecía del saldo aunque no se hubiera pagado nunca.
      // Ahora la deuda la define el documento y la cancela el pago.
      // LISTA DE TIPOS · suman a la cuenta corriente. La liquidación también:
      // la plata que se le paga al proveedor es UNA, facturada o no.
      if (c.tipo === 'factura' || c.tipo === 'liquidacion' || c.tipo === 'nota_debito') {
        deuda += c.total; pagado += c.pagado;
      } else if (c.tipo === 'nota_credito') deuda -= c.total;
    }
    /*
     * El TOTAL del proveedor no cambia por atar las notas a su factura —una NC
     * resta de la deuda igual, referenciada o no—, así que este número siguió
     * estando bien todo este tiempo. Lo que cambia es la ATRIBUCIÓN: cada
     * comprobante viene con su ajuste y su saldo real, que es lo que estaba mal
     * cuando se pagaba factura por factura.
     */
    const ajustes = await this.ajustesDe(cs.map((c) => c.id));
    const etiquetas = new Map(cs.map((c) => [c.id, etiquetaDoc(c)]));
    const conAjuste = cs.map((c) => {
      const aj = ajustes.get(c.id);
      return {
        ...c,
        ajuste: aj?.ajuste ?? 0,
        notas: aj?.notas ?? [],
        refEtiqueta: c.refComprobanteId ? (etiquetas.get(c.refComprobanteId) ?? '') : '',
        saldo: this.saldoReal(c, aj?.ajuste ?? 0),
      };
    });
    return {
      proveedorId,
      saldo: r2(deuda - pagado),
      deuda: r2(deuda),
      pagado: r2(pagado),
      comprobantes: conAjuste,
    };
  }
}

/**
 * TODO EL CONTROLLER PIDE `compras.facturacion`, lecturas incluidas.
 *
 * Acá vive la deuda con los proveedores y lo que se les compró a cada precio:
 * no es un dato que necesite ninguna otra pantalla del sistema (el arranque del
 * inventario arma lo suyo directo de la base, no pasando por acá), así que
 * cerrarlo entero no le saca nada a nadie.
 */
@Controller('comprobantes')
@Permiso('compras.facturacion')
export class ComprobantesController {
  constructor(private readonly svc: ComprobantesService) {}

  @Get()
  list(
    @Auth() auth: Sesion,
    @Query('proveedorId') proveedorId?: string,
    @Query('tipo') tipo?: string,
    @Query('estado') estado?: string,
  ) {
    return this.svc.list({
      proveedorId: proveedorId ? Number(proveedorId) : undefined, tipo, estado,
      /*
       * LA MITAD NO FACTURADA es un permiso aparte (`liquidaciones`). El filtro
       * estaba SOLO en el navegador, así que `?tipo=liquidacion` la devolvía
       * igual a quien se le había negado: el que esconde el botón no puede ser
       * el mismo que decide si el dato viaja.
       */
      verLiquidaciones: tienePermiso(auth.permisos, ['liquidaciones']),
    });
  }

  @Get('cuenta/:proveedorId')
  cuenta(@Param('proveedorId', ParseIntPipe) proveedorId: number) {
    return this.svc.cuenta(proveedorId);
  }

  /** Las facturas que una NC/ND de este proveedor puede ajustar, con su saldo. */
  @Get('referenciables/:proveedorId')
  referenciables(@Param('proveedorId', ParseIntPipe) proveedorId: number) {
    return this.svc.referenciables(proveedorId);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.svc.get(id);
  }

  @Post()
  create(@Body() dto: CreateComprobanteDto, @Auth() auth: Sesion) {
    /*
     * LA PUERTA DE ATRÁS DE PRECIOS.
     *
     * `create` llama por adentro a `precios.actualizarCostos` y
     * `precios.activarProveedor` con datos que vienen del body. El controller de
     * precios está cerrado con `@Permiso('precios')`… y esto lo saltea: un solo
     * POST reescribía el costo de catálogo y con él el precio de góndola.
     *
     * Es la regla de las dos puertas otra vez — cerrar el controller no alcanza
     * cuando otro módulo llama al servicio por adentro. Recibir mercadería
     * (`compras.facturacion`) y tocar precios son dos permisos distintos, así que
     * se piden los dos.
     */
    return this.svc.create(dto, {
      puedeTocarPrecios: tienePermiso(auth.permisos, ['precios']),
      // Para el pago contado: el turno de caja tiene que ser de esta sucursal.
      sucursalSesion: auth.sucursalId,
    });
  }
}

@Module({
  imports: [InventarioModule, PreciosModule, PagosModule],
  controllers: [ComprobantesController],
  providers: [ComprobantesService],
})
export class ComprobantesModule {}
