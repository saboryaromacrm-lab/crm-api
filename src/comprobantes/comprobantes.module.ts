import {
  Body, Controller, Get, Inject, Injectable, Module, BadRequestException,
  NotFoundException, Param, ParseIntPipe, Post, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, ValidateNested,
} from 'class-validator';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  comprobantes, comprobanteItems, comprobantePercepciones, productoProveedores, proveedores,
  proveedorImputaciones, proveedorPagos, sucursales, usuarios,
} from '../db/schema';
import { InventarioModule } from '../inventario/inventario.module';
import { InventarioService } from '../inventario/inventario.service';
import { PreciosModule, PreciosService } from '../precios/precios.module';
import { PagosModule, PagosProveedorService } from '../pagos/pagos.module';

const TIPOS = ['orden_compra', 'remito', 'factura', 'nota_credito', 'nota_debito'] as const;

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

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

  async list(q: { proveedorId?: number; tipo?: string; estado?: string }) {
    const conds: any[] = [];
    if (q.proveedorId) conds.push(eq(comprobantes.proveedorId, Number(q.proveedorId)));
    if (q.tipo) conds.push(eq(comprobantes.tipo, q.tipo as any));
    if (q.estado) conds.push(eq(comprobantes.estado, q.estado as any));
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
    const [items, pagos, percs] = await Promise.all([
      this.db.select().from(comprobanteItems).where(inArray(comprobanteItems.comprobanteId, ids)),
      this.pagosDe(ids),
      this.db.select().from(comprobantePercepciones).where(inArray(comprobantePercepciones.comprobanteId, ids)),
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

    return rows.map((c) => ({
      ...c,
      items: itemsPorId.get(c.id) ?? [],
      percepciones: percsPorId.get(c.id) ?? [],
      pagos: pagos.get(c.id) ?? [],
      saldo: Math.round((c.total - c.pagado) * 100) / 100,
    }));
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
    const [conItems, pagos, percepciones] = await Promise.all([
      this.withItems(c),
      this.pagosDe([id]),
      this.db.select().from(comprobantePercepciones).where(eq(comprobantePercepciones.comprobanteId, id)),
    ]);
    return {
      ...conItems,
      percepciones,
      pagos: pagos.get(id) ?? [],
      saldo: Math.round((c.total - c.pagado) * 100) / 100,
    };
  }

  async create(dto: CreateComprobanteDto) {
    const [prov] = await this.db.select().from(proveedores).where(eq(proveedores.id, dto.proveedorId)).limit(1);
    if (!prov) throw new BadRequestException('Proveedor inválido.');
    if (!dto.items?.length) throw new BadRequestException('Agregá al menos un ítem.');

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

    let subtotalNeto = 0;
    let ivaTotal = 0;
    for (const it of items) {
      const neto = it.subtotal * factorBonif;
      it.subtotal = neto;
      subtotalNeto += neto;
      ivaTotal += neto * it.iva / 100;
    }

    // Percepciones: cada una con su nombre y alícuota copiados del proveedor,
    // porque la factura del año pasado tiene que seguir explicando su total.
    const conIva = subtotalNeto + ivaTotal;
    const percepciones = (dto.percepciones ?? [])
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
    const ingresaStock = estado !== 'anulado' && !!dto.recepcion && (dto.tipo === 'remito' || dto.tipo === 'factura');
    if (ingresaStock && !dto.sucursalId) throw new BadRequestException('Indicá la sucursal de recepción.');

    const id = await this.db.transaction(async (tx) => {
      const [c] = await tx.insert(comprobantes).values({
        tipo: dto.tipo, letra: dto.letra ?? 'A', puntoVenta: dto.puntoVenta ?? '0001', numero: dto.numero ?? null,
        fecha: dto.fecha ? new Date(dto.fecha) : undefined,
        fechaCarga: dto.fechaCarga ? new Date(dto.fechaCarga) : undefined, proveedorId: prov.id, sucursalId: dto.sucursalId ?? null,
        estado, condicionPago: dto.condicionPago ?? 'cuenta_corriente',
        vencimientoPago: dto.vencimientoPago ? new Date(dto.vencimientoPago) : null,
        recepcion: !!dto.recepcion,
        bonificacion: bonifPct, bonificacionImporte: r2(bonificacionImporte),
        subtotalNeto, ivaTotal, percepcionesTotal: r2(percepcionesTotal), total,
        refComprobanteId: dto.refComprobanteId ?? null, observaciones: dto.observaciones ?? '', usuarioId: dto.usuarioId ?? null,
      }).returning();

      await tx.insert(comprobanteItems).values(items.map((it) => ({
        comprobanteId: c.id, productoId: it.productoId, presentacionId: it.presentacionId ?? null,
        cantidad: Number(it.cantidad) || 0, costoUnitario: Number(it.costoUnitario) || 0,
        descuento: Number(it.descuento) || 0, iva: it.iva, subtotal: it.subtotal,
      })));

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
    const generaDeuda = estado === 'confirmado' && (dto.tipo === 'factura' || dto.tipo === 'nota_debito');
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
          concepto: `${dto.tipo} ${dto.letra ?? 'A'} ${dto.puntoVenta ?? ''}-${dto.numero ?? id}`.trim(),
          referencia: dto.pagoContado?.referencia,
          sucursalId: dto.sucursalId,
          cajaSesionId: dto.pagoContado?.cajaSesionId,
          usuarioId: dto.usuarioId,
          imputaciones: [{ comprobanteId: id, importe: contado }],
        });
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
      if (c.tipo === 'factura' || c.tipo === 'nota_debito') { deuda += c.total; pagado += c.pagado; }
      else if (c.tipo === 'nota_credito') deuda -= c.total;
    }
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return { proveedorId, saldo: r2(deuda - pagado), deuda: r2(deuda), pagado: r2(pagado), comprobantes: cs };
  }
}

@Controller('comprobantes')
export class ComprobantesController {
  constructor(private readonly svc: ComprobantesService) {}

  @Get()
  list(@Query('proveedorId') proveedorId?: string, @Query('tipo') tipo?: string, @Query('estado') estado?: string) {
    return this.svc.list({ proveedorId: proveedorId ? Number(proveedorId) : undefined, tipo, estado });
  }

  @Get('cuenta/:proveedorId')
  cuenta(@Param('proveedorId', ParseIntPipe) proveedorId: number) {
    return this.svc.cuenta(proveedorId);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.svc.get(id);
  }

  @Post()
  create(@Body() dto: CreateComprobanteDto) {
    return this.svc.create(dto);
  }
}

@Module({
  imports: [InventarioModule, PreciosModule, PagosModule],
  controllers: [ComprobantesController],
  providers: [ComprobantesService],
})
export class ComprobantesModule {}
