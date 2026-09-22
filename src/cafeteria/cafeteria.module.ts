/**
 * CAFETERÍA — el puente con coffit.
 * ============================================================================
 * El dueño tiene DOS negocios con el MISMO CUIT: la distribuidora (este
 * sistema) y una cafetería cuyo stock maneja OTRO sistema (coffit). El envío
 * NO es una transferencia entre sucursales — no hay receptor en el CRM — sino
 * un PUNTO DE SALIDA: la mercadería egresa del stock valorizada A COSTO
 * congelado y del otro lado coffit la ingresa en su almacén "Sabor y Aroma",
 * donde ELLA decide qué es cada cosa (góndola, insumo, lo que sea).
 *
 * Reglas que NO se negocian:
 *  - El CRM nunca muestra existencias de Cafetería (coffit es el dueño).
 *  - El envío va a COSTO: la ganancia aparece donde se genera (cuando el café
 *    vende), no en un traspaso interno.
 *  - La CLASIFICACIÓN de la mercadería es de coffit. El CRM no pregunta
 *    destinos: manda el detalle completo y ahí termina su responsabilidad.
 *
 * CICLO DE VIDA en dos estados (desde el 9/8/2026):
 *
 *   ──crear──► enviado ──anular──► anulado
 *              (egresa stock y     (reversión completa:
 *               congela costo       todo reingresa)
 *               en el mismo acto)
 *
 * Con el envío ya se da por hecho que coffit lo recibió: el "viaje" es cruzar
 * la calle. La corrección de un envío NO es una devolución (no existen): es
 * EDITARLO — se revierte el egreso viejo y se aplica el nuevo, en una
 * transacción. Cada cambio sube `version` y toca `actualizadoEn`, que es el
 * pulso con el que coffit sincroniza (GET /cafeteria/sync).
 *
 * EL COSTO SE CONGELA UNA VEZ. Editar no re-valúa los renglones que ya
 * estaban (re-valuar cambiaría retroactivamente cuánto costó la cafetería en
 * un período ya mirado); solo un renglón NUEVO entra al costo del día.
 */
import {
  Body, Controller, Get, Inject, Injectable, Module, Param, ParseIntPipe, Patch, Post, Put, Query,
  BadRequestException, ConflictException, ForbiddenException, NotFoundException,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import { fechaLocal } from '../common/documentos';
import { DRIZZLE, Database } from '../db/drizzle';
import { Auth, ClaveServicio, Permiso, type Sesion } from '../auth/auth.decoradores';
import { soloSuSucursal, tienePermiso } from '../auth/auth.guard';
import {
  comprobantes, enviosCafeteria, envioCafeteriaItems, gastos, listasVenta, pedidoCafeteriaItems,
  pedidosCafeteria, precioHistorial, presentaciones, productoListas, productoProveedores, productos,
  stock, sucursales, usuarios,
} from '../db/schema';
import { ProductosModule, ProductosService } from '../productos/productos.module';
import { InventarioModule } from '../inventario/inventario.module';
import { InventarioService } from '../inventario/inventario.service';
import { costoNetoEntry, formatoActivo } from '../inventario/pricing';

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Con qué signo entra cada tipo de comprobante de compra a una suma (0101):
 * la nota de crédito RESTA (mercadería devuelta o precio corregido); el
 * remito y la orden de compra no son compra hasta que se facturan.
 */
const SIGNO_COMPRA = sql`(case when ${comprobantes.tipo} in ('factura', 'liquidacion', 'nota_debito') then 1
  when ${comprobantes.tipo} = 'nota_credito' then -1 else 0 end)`;
const r3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;

class EnvioItemDto {
  @IsInt() productoId!: number;
  @IsOptional() @IsInt() presentacionId?: number;
  @IsNumber() @Min(0.001) @Max(100000) cantidad!: number;
  /**
   * EL COSTO QUE DECLARA LA CAFETERÍA (0097), solo en los envíos de ENTRADA.
   * Ahí el CRM no puede saberlo — la medialuna la hizo coffit — así que lo
   * dice quien lo sabe, y se congela igual que en una salida. En una salida
   * se ignora: ese costo sale del formato de compra y no se tipea.
   *
   * Cero vale (una muestra), pero AUSENTE no: mandar una entrada sin declarar
   * el costo dejaría la rentabilidad de ese producto en cero sin que nadie lo
   * note.
   */
  @IsOptional() @IsNumber() @Min(0) @Max(100_000_000) costoUnitario?: number;
}

class CrearEnvioDto {
  /** 'salida' (la distribuidora le manda al café) o 'entrada' (el café manda
   *  lo que elabora a una sucursal). Sin decir nada es 'salida', que es lo que
   *  existía: ningún cliente viejo cambia de comportamiento. */
  @IsOptional() @IsIn(['salida', 'entrada']) sentido?: 'salida' | 'entrada';
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsString() fecha?: string;
  @IsOptional() @IsString() @MaxLength(500) observaciones?: string;
  @IsOptional() @IsInt() usuarioId?: number;
  /** El pedido que este envío viene a cumplir: lo cierra en el mismo acto. */
  @IsOptional() @IsInt() pedidoId?: number;
  /** «Sí, ya sé que hay uno igual de hoy, va igual»: lo manda la pantalla
   *  DESPUÉS de preguntar, nunca por su cuenta. Ver `gemeloDelDia`. */
  @IsOptional() @IsBoolean() confirmarDuplicado?: boolean;
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => EnvioItemDto)
  items!: EnvioItemDto[];
}

class EditarEnvioDto {
  /**
   * La versión que la pantalla estaba mirando. Si en el medio otro la cambió,
   * el edit se rechaza en vez de pisar en silencio lo que el otro hizo.
   *
   * OBLIGATORIA. Era `@IsOptional()`, y un candado que se abre no mandando la
   * llave no es un candado: bastaba un `PUT` sin el campo para saltear la
   * comparación entera y ganar siempre. El `FOR UPDATE` de abajo evita el estado
   * roto a medias, no la pisada.
   */
  @IsInt() version!: number;
  @IsOptional() @IsString() fecha?: string;
  @IsOptional() @IsString() @MaxLength(500) observaciones?: string;
  @IsOptional() @IsInt() usuarioId?: number;
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => EnvioItemDto)
  items!: EnvioItemDto[];
}

class AnularEnvioDto {
  @IsString() @MaxLength(300) motivo!: string;
  @IsOptional() @IsInt() usuarioId?: number;
}

class PedidoItemDto {
  @IsInt() productoId!: number;
  @IsOptional() @IsInt() presentacionId?: number;
  @IsNumber() @Min(0.001) @Max(100000) cantidad!: number;
}

class CrearPedidoDto {
  /**
   * A QUÉ SUCURSAL SE LE PIDE (0098). Obligatoria: sin esto el pedido iba "a
   * la distribuidora" por defecto y nadie decidía nada, y el que lo armaba
   * sacaba el stock de donde le quedaba cómodo. Ahora manda: solo esa sucursal
   * lo ve, y el envío que lo cumple sale de ahí.
   */
  @IsInt() sucursalId!: number;
  @IsOptional() @IsString() @MaxLength(500) observaciones?: string;
  @IsOptional() @IsInt() usuarioId?: number;
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => PedidoItemDto)
  items!: PedidoItemDto[];
}

/**
 * EL ALTA DE UN PRODUCTO QUE HACE LA CAFETERÍA. Lo mínimo y nada más: un
 * nombre, si se cuenta o se pesa, y a cuánto se vende en el mostrador.
 *
 * No tiene proveedor, ni formato de compra, ni categoría, ni códigos: nada de
 * eso aplica a algo que no se compra. El resto del catálogo sigue siendo de
 * Compras › Productos, que es donde va el que tiene esa llave.
 */
class ProductoCafeDto {
  @IsString() @MaxLength(120) nombre!: string;
  /** Se pesa (kg) en vez de contarse. Por defecto se cuenta: la medialuna. */
  @IsOptional() @IsBoolean() esGranel?: boolean;
  /** Lo que paga el cliente en el mostrador, con IVA. */
  @IsNumber() @Min(0.01) @Max(100_000_000) precio!: number;
  /**
   * Cuánto le cuesta a la cafetería hacerlo. Opcional: se puede cargar el
   * producto hoy y poner el costo cuando lo sepa. 0 = todavía no lo sé.
   */
  @IsOptional() @IsNumber() @Min(0) @Max(100_000_000) costo?: number;
}

class AnularPedidoDto {
  @IsString() @MaxLength(300) motivo!: string;
  @IsOptional() @IsInt() usuarioId?: number;
}

@Injectable()
export class CafeteriaService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly inv: InventarioService,
    private readonly prods: ProductosService,
  ) {}

  /**
   * Costo unitario de HOY del formato activo ($/kg del granel, $/paquete de la
   * presentación).
   *
   * Las TRES consultas salen antes del bucle: con 300 renglones de tope, un
   * SELECT por renglón eran cientos de idas y vueltas con la transacción —y la
   * del envío además egresa stock, o sea que tiene filas tomadas mientras tanto.
   */
  private async valuarItems(
    tx: any, items: { productoId: number; presentacionId?: number | null }[], conCosto = true,
  ) {
    const ids = [...new Set(items.map((it) => it.productoId))];
    const presIds = [...new Set(items.map((it) => it.presentacionId).filter(Boolean))] as number[];
    /* `conCosto` en false para las ENTRADAS: ahí el costo lo declara la
     * cafetería, así que la consulta de formatos de compra —la más pesada de
     * las tres— no se hace. Un producto de la cafetería ni siquiera tiene
     * proveedor cargado. */
    const [provs, prods, press] = await Promise.all([
      conCosto
        ? tx.select().from(productoProveedores).where(inArray(productoProveedores.productoId, ids))
        : Promise.resolve([]),
      tx.select().from(productos).where(inArray(productos.id, ids)),
      presIds.length
        ? tx.select().from(presentaciones).where(inArray(presentaciones.id, presIds))
        : Promise.resolve([]),
    ]);
    const prodDe = new Map<number, any>(prods.map((p: any) => [p.id, p]));
    const presPorId = new Map<number, any>(press.map((p: any) => [p.id, p]));

    const out = new Map<string, { prod: any; pres: any; costoU: number }>();
    for (const it of items) {
      const clave = `${it.productoId}-${it.presentacionId ?? 0}`;
      if (out.has(clave)) continue;
      const prod = prodDe.get(it.productoId);
      if (!prod) throw new BadRequestException('Producto inválido en el detalle.');
      // Archivado = fuera de catálogo: no se pide ni se manda al café.
      if (prod.estado === 'archivado') {
        throw new BadRequestException(`${prod.nombre} está archivado: ya no se maneja. Reactivalo si volvió a entrar.`);
      }
      let pres: any = null;
      if (it.presentacionId) {
        pres = presPorId.get(it.presentacionId) ?? null;
        if (!pres || pres.productoId !== prod.id) throw new BadRequestException(`Presentación inválida para ${prod.nombre}.`);
      }
      const cnKg = conCosto
        ? costoNetoEntry(formatoActivo(provs.filter((p: any) => p.productoId === prod.id)) as any, prod.iva)
        : 0;
      out.set(clave, { prod, pres, costoU: pres ? cnKg * (pres.tamKg ?? 1) : cnKg });
    }
    return out;
  }

  /**
   * Los renglones listos para insertar, con el MODO DE UNIDAD explícito.
   * `costoDe` decide el costo unitario de cada renglón: en el alta es el de
   * hoy; en la edición conserva el congelado de los renglones que ya estaban.
   */
  private armarFilas(
    items: EnvioItemDto[],
    val: Map<string, { prod: any; pres: any; costoU: number }>,
    costoDe: (clave: string, costoHoy: number, it: EnvioItemDto) => number,
  ) {
    let total = 0;
    const filas: any[] = [];
    for (const it of items) {
      const clave = `${it.productoId}-${it.presentacionId ?? 0}`;
      const { prod, pres, costoU } = val.get(clave)!;
      const cantidad = Number(it.cantidad);
      const costo = costoDe(clave, costoU, it);
      total += costo * cantidad;

      const esGranel = prod.tipo === 'granel' && !pres;
      const modo = pres ? 'paquete' : (esGranel ? 'granel' : 'unidad');
      /*
       * MEDIA MEDIALUNA NO EXISTE. Solo el granel se fracciona: ahí `cantidad`
       * son kilos y 2,5 es un número legítimo. En unidades y en paquetes es un
       * conteo, y un decimal ahí entra al stock igual y deja una existencia
       * que nunca va a cerrar contra lo que se cuenta en la góndola.
       *
       * El freno vive acá y no en cada camino porque este es el único lugar
       * que ya sabe el modo: alta, edición, salida y entrada pasan todos por
       * esta función. Un control repetido cuatro veces es un control que algún
       * día está en tres.
       */
      if (modo !== 'granel' && !Number.isInteger(cantidad)) {
        throw new BadRequestException(
          `${prod.nombre} se cuenta por ${modo === 'paquete' ? 'paquete' : 'unidad'} entera: `
          + `${cantidad} no es una cantidad posible. Si va fraccionado, usá el formato por kilo.`,
        );
      }
      const tamKg = pres ? Number(pres.tamKg) || 0 : (esGranel ? 1 : 0);
      const tam = pres ? (pres.tamKg < 1 ? `${Math.round(pres.tamKg * 1000)} g` : `${pres.tamKg} kg`) : '';
      filas.push({
        productoId: prod.id,
        presentacionId: pres?.id ?? null,
        modo,
        cantidad,
        tamKg,
        costoUnitario: costo,
        nombre: pres ? `${prod.nombre} · ${tam}` : prod.nombre,
        unidad: esGranel ? 'kg' : (pres ? 'paq.' : 'u.'),
        codigoBarras: (pres?.codigoBarras || prod.codigoBarras || ''),
        codigoPropio: prod.codigoPropio || '',
        /* Congelado acá (0101): de qué stock salió decide si este envío mueve
         * plata entre los dos negocios o solo cruza la calle. */
        exclusivo: !!prod.soloCafeteria,
      });
    }
    return { filas, total: r2(total) };
  }

  /**
   * EL STOCK DE UN ENVÍO, EN EL SENTIDO QUE CORRESPONDA (0097).
   *
   * Una sola tabla de verdad para los tres caminos —alta, edición y
   * anulación— en vez de cuatro `if` repartidos: `aplicar` pone la mercadería
   * donde el envío dice, `revertir` la saca.
   *
   * REVERTIR UNA ENTRADA EGRESA, y ahí la validación de stock es lo que
   * importa: si esas medialunas ya se vendieron, deshacer el ingreso tiene que
   * REBOTAR con un mensaje claro y no dejar el stock en negativo — el negativo
   * de una venta es un hecho que pasó; este sería uno inventado por corregir
   * un papel.
   */
  private async moverStock(tx: any, o: {
    sentido: 'salida' | 'entrada'; accion: 'aplicar' | 'revertir';
    sucursalId: number; usuarioId?: number | null; filas: any[]; descripcion: string;
  }) {
    const base = {
      sucursalId: o.sucursalId, usuarioId: o.usuarioId ?? null, descripcion: o.descripcion,
      items: o.filas.map((f) => ({ productoId: f.productoId, presentacionId: f.presentacionId, cantidad: f.cantidad })),
    };
    const ingresa = (o.sentido === 'entrada') === (o.accion === 'aplicar');
    if (ingresa) {
      await this.inv.reingresarStockItems(tx, {
        ...base,
        // La salida conserva su 'devolucion' de siempre; la entrada tiene tipo propio.
        ...(o.sentido === 'entrada' ? { tipoMovimiento: 'ingreso_cafeteria' } : {}),
      });
      return;
    }
    await this.inv.egresarStockItems(tx, {
      ...base,
      tipoMovimiento: o.sentido === 'entrada' ? 'ingreso_cafeteria' : 'envio_cafeteria',
    });
  }

  /**
   * LA LISTA BLANCA DE LA ENTRADA: solo lo que la cafetería elabora.
   *
   * Sin esto, cualquiera mandaría harina "desde la cafetería" con un costo
   * declarado a dedo, y ese costo pisaría el costo real del proveedor en la
   * rentabilidad — en silencio y sin forma de notarlo después.
   */
  private validarEntrada(val: Map<string, { prod: any; pres: any; costoU: number }>, items: EnvioItemDto[]) {
    for (const { prod } of val.values()) {
      if (!prod.origenCafeteria) {
        throw new BadRequestException(
          `${prod.nombre} no es un producto de la cafetería. `
          + 'Marcalo como "Lo elabora la cafetería" en su ficha, o sacalo del envío.',
        );
      }
    }
    for (const it of items) {
      if (it.costoUnitario == null) {
        const { prod } = val.get(`${it.productoId}-${it.presentacionId ?? 0}`)!;
        throw new BadRequestException(
          `Falta el costo de ${prod.nombre}. En una entrada lo declara la cafetería: sin él, ese producto quedaría con rentabilidad inventada.`,
        );
      }
    }
  }

  /* ==================================================================== *
   * LOS PRODUCTOS QUE HACE LA CAFETERÍA
   * ==================================================================== *
   * La cafetería no entra a Compras › Productos —esa llave abre el catálogo
   * entero, con precios, costos y proveedores— pero necesita poder dar de alta
   * lo que empieza a elaborar sin tener que pedírselo a alguien y esperar.
   *
   * Esta es la puerta chica: ve y toca SOLO los productos marcados como
   * elaborados por ella, y solo tres cosas de cada uno —nombre, si se cuenta o
   * se pesa, y el precio del mostrador—. Todo lo demás del producto (códigos,
   * categoría, proveedores, formatos de compra) no aplica a algo que no se
   * compra, y sigue siendo de Compras.
   *
   * EL CANDADO ES `origenCafeteria`, y se revisa en CADA operación: el alta lo
   * fuerza en true y la edición rechaza lo que no lo tenga. Sin eso, un id
   * cualquiera en la URL le habría dejado renombrar la harina o cambiarle el
   * precio a lo que quisiera.
   */

  /** La lista de precios del mostrador: la primera activa, por orden. */
  private async listaMostrador() {
    const [l] = await this.db.select({ id: listasVenta.id, nombre: listasVenta.nombre })
      .from(listasVenta).where(eq(listasVenta.activa, true))
      .orderBy(asc(listasVenta.orden), asc(listasVenta.id)).limit(1);
    if (!l) throw new BadRequestException('No hay ninguna lista de precios activa. Configurala en Ventas › Listas.');
    return l;
  }

  /** El producto, solo si de verdad es de la cafetería. */
  private async productoDelCafe(id: number) {
    const [p] = await this.db.select().from(productos).where(eq(productos.id, id)).limit(1);
    if (!p) throw new NotFoundException('Producto inexistente.');
    if (!p.origenCafeteria) {
      throw new ForbiddenException('Ese producto no es de la cafetería: se edita desde Compras › Productos.');
    }
    return p;
  }

  /** Días enteros desde una fecha, o `null` si nunca pasó. */
  private diasDesde(f: Date | null | undefined) {
    if (!f) return null;
    return Math.max(0, Math.floor((Date.now() - new Date(f).getTime()) / 86_400_000));
  }

  async productosDelCafe() {
    const lista = await this.listaMostrador();
    /*
     * DESDE CUÁNDO NO SE MUEVE EL PRECIO, del historial que el sistema YA
     * lleva: `precio_historial` escribe solo cuando el número cambió de
     * verdad, así que su última fecha es exactamente la respuesta. Por eso el
     * precio no necesitó ninguna columna nueva y el costo sí: el costo de la
     * cafetería no pasaba por ningún lado hasta ahora.
     */
    const ultimoPrecio = this.db.$with('ultimo_precio').as(
      this.db.select({
        productoId: precioHistorial.productoId,
        fecha: sql<Date>`max(${precioHistorial.fecha})`.as('fecha'),
      }).from(precioHistorial)
        .where(eq(precioHistorial.listaId, lista.id))
        .groupBy(precioHistorial.productoId),
    );

    const filas = await this.db.with(ultimoPrecio).select({
      id: productos.id,
      nombre: productos.nombre,
      codigoPropio: productos.codigoPropio,
      tipo: productos.tipo,
      estado: productos.estado,
      costo: productos.costoCafeteria,
      costoActualizado: productos.costoCafeteriaActualizado,
      modoPrecio: productoListas.modoPrecio,
      precioFijo: productoListas.precioFijo,
      precioActualizado: ultimoPrecio.fecha,
    }).from(productos)
      .leftJoin(productoListas, and(
        eq(productoListas.productoId, productos.id),
        eq(productoListas.listaId, lista.id),
        isNull(productoListas.presentacionId),
      ))
      .leftJoin(ultimoPrecio, eq(ultimoPrecio.productoId, productos.id))
      .where(eq(productos.origenCafeteria, true))
      .orderBy(asc(productos.nombre));

    return {
      lista: lista.nombre,
      productos: filas.map((f) => {
        /* `precio` solo cuando es un número fijo. Si la distribuidora se lo
         * definió por MARGEN desde Compras, acá no se toca: convertirlo a un
         * fijo en silencio le cambiaría la regla de precio sin avisar. */
        const precio = f.modoPrecio === 'precio' ? Number(f.precioFijo) : null;
        /* NULO = nunca se declaró, distinto de "cuesta cero": uno es un dato
         * que falta y el otro es una decisión, y la pantalla los muestra
         * distinto porque significan cosas distintas. */
        const costo = f.costoActualizado ? Number(f.costo) : null;
        return {
          id: f.id, nombre: f.nombre, codigoPropio: f.codigoPropio,
          esGranel: f.tipo === 'granel', estado: f.estado,
          precio,
          porMargen: f.modoPrecio === 'markup',
          costo,
          costoDias: this.diasDesde(f.costoActualizado),
          precioDias: this.diasDesde(f.precioActualizado as any),
          /* El margen sale de los dos números de esta misma fila, y es la razón
           * por la que importa que ninguno de los dos esté viejo. Sin costo no
           * hay margen — y esa ausencia también dice algo. */
          margen: precio != null && costo != null && precio > 0
            ? r2(((precio - costo) / precio) * 100)
            : null,
        };
      }),
    };
  }

  /**
   * GUARDA EL COSTO Y MUEVE EL RELOJ SOLO SI EL NÚMERO CAMBIÓ.
   *
   * Volver a guardar lo mismo NO puede poner "actualizado hoy": si lo hiciera,
   * el aviso de costo viejo se apagaría con solo abrir y cerrar la ficha, que
   * es justo lo contrario de para lo que sirve. Es la misma regla con la que
   * el sistema ya escribe `precio_historial`, y tiene que ser la misma para
   * que las dos antigüedades de la pantalla signifiquen lo mismo.
   *
   * `undefined` = el formulario no mandó costo (no lo toca). `0` sí es un
   * valor: alguien decidió que no cuesta nada.
   */
  private async guardarCostoDelCafe(prod: any, costo: number | undefined) {
    if (costo === undefined || costo === null) return;
    const nuevo = r2(Number(costo));
    const nunca = !prod.costoCafeteriaActualizado;
    if (!nunca && Math.abs(Number(prod.costoCafeteria) - nuevo) < 0.005) return;
    await this.db.update(productos)
      .set({ costoCafeteria: nuevo, costoCafeteriaActualizado: new Date() })
      .where(eq(productos.id, prod.id));
  }

  /** El nombre, limpio y de verdad: `@IsString()` deja pasar "   ". */
  private nombreDelProducto(dto: ProductoCafeDto) {
    const n = (dto.nombre ?? '').trim();
    if (!n) throw new BadRequestException('Poné el nombre del producto.');
    return n;
  }

  async crearProductoDelCafe(dto: ProductoCafeDto) {
    const nombre = this.nombreDelProducto(dto);
    const lista = await this.listaMostrador();
    const p: any = await this.prods.create({
      nombre,
      esGranel: !!dto.esGranel,
      /* Las dos marcas, explícitas y en el alta: `origenCafeteria` es lo que
       * lo habilita en el envío, y `soloCafeteria` en false porque es
       * justamente lo contrario — esto SÍ se vende en el mostrador. */
      origenCafeteria: true,
      soloCafeteria: false,
    } as any);
    await this.prods.setListas(p.id, [
      { listaId: lista.id, modoPrecio: 'precio', precioFijo: Number(dto.precio), unidades: 1 },
    ]);
    await this.guardarCostoDelCafe(p, dto.costo);
    return this.productosDelCafe();
  }

  async editarProductoDelCafe(id: number, dto: ProductoCafeDto) {
    const nombre = this.nombreDelProducto(dto);
    const p = await this.productoDelCafe(id);
    const lista = await this.listaMostrador();
    /* Solo el nombre: el tipo NO se cambia después del alta. Pasar de contar a
     * pesar (o al revés) le cambia el significado a todo el stock y a todos
     * los envíos que ya existen — eso es un producto nuevo, no una edición. */
    await this.prods.update(id, { nombre, esGranel: p.tipo === 'granel' } as any);
    await this.prods.setListas(id, [
      { listaId: lista.id, modoPrecio: 'precio', precioFijo: Number(dto.precio), unidades: 1 },
    ]);
    await this.guardarCostoDelCafe(p, dto.costo);
    return this.productosDelCafe();
  }

  /** Dejó de hacerlo: sale del catálogo pero su historia queda. */
  async bajaProductoDelCafe(id: number, activar: boolean) {
    await this.productoDelCafe(id);
    await this.prods.cambiarEstado(id, { estado: activar ? 'activo' : 'archivado' } as any);
    return this.productosDelCafe();
  }

  /**
   * LA HUELLA DE UN DETALLE: qué se mandó, cuánto y a qué costo, sin importar
   * en qué orden se cargaron los renglones.
   */
  private huella(filas: { productoId: number; presentacionId: number | null; cantidad: any; costoUnitario: any }[]) {
    return filas
      .map((f) => `${f.productoId}-${f.presentacionId ?? 0}:${Number(f.cantidad)}:${Number(f.costoUnitario)}`)
      .sort()
      .join('|');
  }

  /**
   * EL ENVÍO GEMELO: el mismo envío ya cargado hoy.
   *
   * El botón de la pantalla ya no se puede clickear dos veces, pero eso vive
   * en UN navegador. Dos pestañas, dos computadoras, o la página que se colgó
   * y se volvió a cargar de cero, entran igual — y el resultado es stock de
   * más que nadie mira hasta que el inventario no cierra.
   *
   * La ventana es EL DÍA del documento y no unos minutos: el error real no es
   * "clickeé dos veces", es "cargué las medialunas de hoy dos veces", y eso
   * pasa con una hora de diferencia. A cambio, el filtro es exacto —mismo
   * sentido, misma sucursal, mismo total y mismo detalle renglón por
   * renglón— así que un gemelo de verdad es casi siempre un error.
   *
   * Y NO BLOQUEA: devuelve el que encontró para que la pantalla pregunte. Si
   * el café de verdad mandó dos veces lo mismo, se confirma y va. Un freno que
   * no se puede saltear termina siendo un freno que hay que saltear por fuera.
   */
  private async gemeloDelDia(tx: any, o: {
    sentido: 'salida' | 'entrada'; sucursalId: number; fecha: Date; total: number; filas: any[];
  }) {
    const desde = new Date(o.fecha); desde.setHours(0, 0, 0, 0);
    const hasta = new Date(o.fecha); hasta.setHours(23, 59, 59, 999);
    /* El total entra como pre-filtro barato: dos envíos con distinto total no
     * pueden tener el mismo detalle, y así el detalle se lee de muy pocos. */
    const candidatos = await tx.select({ id: enviosCafeteria.id, codigo: enviosCafeteria.codigo })
      .from(enviosCafeteria)
      .where(and(
        eq(enviosCafeteria.sentido, o.sentido),
        eq(enviosCafeteria.sucursalId, o.sucursalId),
        eq(enviosCafeteria.estado, 'enviado'),
        eq(enviosCafeteria.totalCosto, o.total),
        gte(enviosCafeteria.fecha, desde),
        lte(enviosCafeteria.fecha, hasta),
      ))
      .orderBy(desc(enviosCafeteria.id))
      .limit(5);
    if (!candidatos.length) return null;

    const mia = this.huella(o.filas);
    const filas = await tx.select().from(envioCafeteriaItems)
      .where(inArray(envioCafeteriaItems.envioId, candidatos.map((c: any) => c.id)));
    return candidatos.find((c: any) => this.huella(filas.filter((f: any) => f.envioId === c.id)) === mia) ?? null;
  }

  /**
   * EL CANDADO DEL ROL CAFETERÍA (0097).
   *
   * El café carga SUS envíos —los de entrada— y nada más. Una salida egresa
   * stock real de la distribuidora: quien no tiene esa llave no puede crear
   * una, ni editar o anular una que ya exista. Vive en el servicio y no en el
   * controller porque los tres caminos tienen que contestar igual, y un
   * candado repetido tres veces es un candado que algún día está en dos.
   */
  private verSentido(sentido: string, soloSentido?: 'entrada' | null) {
    if (soloSentido && sentido !== soloSentido) {
      throw new ForbiddenException('Desde Cafetería solo se cargan los envíos que salen de la cafetería.');
    }
  }

  /** El envío nace ENVIADO: mueve el stock y congela costo en el mismo acto. */
  async crear(o: CrearEnvioDto, soloSentido?: 'entrada' | null) {
    const items = (o.items || []).filter((it) => Number(it.cantidad) > 0);
    if (!items.length) throw new BadRequestException('Agregá al menos un renglón con cantidad.');

    const sentido = o.sentido === 'entrada' ? 'entrada' : 'salida';
    const entrada = sentido === 'entrada';
    this.verSentido(sentido, soloSentido);
    /* Un pedido es la demanda de la cafetería HACIA la distribuidora: el camino
     * de vuelta no tiene nada que cerrar. */
    if (entrada && o.pedidoId) {
      throw new BadRequestException('Un envío de la cafetería no cumple pedidos: los pedidos son lo que ella pide.');
    }

    const id = await this.db.transaction(async (tx) => {
      /*
       * SI CUMPLE UN PEDIDO, LA SUCURSAL LA MANDA EL PEDIDO (0098).
       *
       * La cafetería eligió a quién le pedía y vio la disponibilidad de ESA
       * sucursal; el envío tiene que salir de ahí. Lo decide el servidor y no
       * el formulario: si dependiera de lo que manda la pantalla, un campo mal
       * precargado le bajaría el stock a un local que no tenía nada que ver.
       */
      const pedidoSuc = o.pedidoId
        ? (await tx.select({ sucursalId: pedidosCafeteria.sucursalId })
          .from(pedidosCafeteria).where(eq(pedidosCafeteria.id, o.pedidoId)).limit(1))[0]?.sucursalId
        : null;

      /* En la SALIDA la sucursal es de dónde sale (por defecto la
       * distribuidora). En la ENTRADA es a dónde LLEGA, y la elige quien
       * envía: no hay destino obvio, y adivinarlo dejaría la mercadería en una
       * sucursal que no la recibió. */
      const sucId = entrada
        ? Number(o.sucursalId) || 0
        : (pedidoSuc
          || o.sucursalId
          || (await tx.select().from(sucursales).where(eq(sucursales.tipo, 'distribuidora')).limit(1))[0]?.id);
      if (!sucId) {
        throw new BadRequestException(entrada
          ? 'Elegí a qué sucursal llega la mercadería.'
          : 'No hay sucursal de origen.');
      }
      /* Un id que no existe llegaba hasta la clave foránea y salía un 500
       * crudo: el que lo veía no tenía forma de saber qué le faltaba. */
      const [suc] = await tx.select({ id: sucursales.id })
        .from(sucursales).where(eq(sucursales.id, sucId)).limit(1);
      if (!suc) {
        throw new BadRequestException('Esa sucursal ya no existe. Actualizá la pantalla y elegila de nuevo.');
      }

      /*
       * Si viene a cumplir un pedido, el pedido se CIERRA acá, con reclamo
       * atómico: dos personas convirtiendo el mismo pedido a la vez generarían
       * dos envíos por la misma demanda — solo una gana el UPDATE condicional.
       */
      if (o.pedidoId) {
        const cerrado = await tx.update(pedidosCafeteria)
          .set({ estado: 'enviado', actualizadoEn: new Date() })
          .where(and(
            eq(pedidosCafeteria.id, o.pedidoId),
            inArray(pedidosCafeteria.estado, ['pendiente', 'armando']),
          ))
          .returning({ id: pedidosCafeteria.id });
        if (!cerrado.length) {
          throw new BadRequestException('Ese pedido ya se convirtió en envío (o está anulado) — actualizá la pantalla.');
        }
      }

      const val = await this.valuarItems(tx, items, !entrada);
      if (entrada) this.validarEntrada(val, items);
      const { filas, total } = this.armarFilas(
        items, val,
        entrada ? (_c, _hoy, it) => r2(Number(it.costoUnitario)) : (_c, hoy) => hoy,
      );

      const fecha = fechaLocal(o.fecha) ?? new Date();
      if (!o.confirmarDuplicado) {
        /*
         * EL CANDADO QUE HACE ATÓMICA LA BÚSQUEDA DEL GEMELO.
         *
         * Buscar y después insertar no alcanza: dos pedidos idénticos que
         * llegan en el mismo instante no se ven entre sí —ninguno commiteó
         * todavía— y entran los dos. Es justo el caso que esto viene a tapar.
         *
         * `pg_advisory_xact_lock` sobre la huella del envío serializa SOLO a
         * los que traen exactamente el mismo contenido: el segundo espera al
         * primero, y cuando pasa ya lo ve cargado. Se suelta solo al terminar
         * la transacción (no hay nada que limpiar), no toca ninguna tabla y no
         * frena ningún otro envío. Un índice único habría pedido una columna
         * nueva y una migración para lo mismo.
         */
        const clave = `cafe:${sentido}:${sucId}:${fecha.toISOString().slice(0, 10)}:${this.huella(filas)}`;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${clave}))`);
        const gemelo = await this.gemeloDelDia(tx, { sentido, sucursalId: sucId, fecha, total, filas });
        if (gemelo) {
          throw new ConflictException({
            duplicado: gemelo.codigo,
            message: `Hoy ya se cargó un envío idéntico a esta sucursal: ${gemelo.codigo}, por ${total}. `
              + 'Si de verdad va otra vez, confirmalo.',
          });
        }
      }

      const [envio] = await tx.insert(enviosCafeteria).values({
        codigo: '', fecha, sucursalId: sucId,
        usuarioId: o.usuarioId ?? null, estado: 'enviado', sentido, totalCosto: total,
        observaciones: (o.observaciones ?? '').trim(),
        version: 1, actualizadoEn: new Date(),
        pedidoId: o.pedidoId ?? null,
      }).returning();
      /* Prefijo por sentido: en una lista mezclada el código solo ya dice de
       * qué lado viene la mercadería. CAF = le mandamos, RCA = nos mandó. */
      const codigo = `${entrada ? 'RCA' : 'CAF'}${String(envio.id).padStart(4, '0')}`;
      await tx.update(enviosCafeteria).set({ codigo }).where(eq(enviosCafeteria.id, envio.id));
      await tx.insert(envioCafeteriaItems).values(filas.map((f) => ({ ...f, envioId: envio.id })));

      await this.moverStock(tx, {
        sentido, accion: 'aplicar', sucursalId: sucId, usuarioId: o.usuarioId, filas,
        descripcion: `${codigo}: ${entrada ? 'recibido de' : 'enviado a'} Cafetería`,
      });
      return envio.id;
    });
    return this.get(id);
  }

  /**
   * EDITAR UN ENVÍO YA ENVIADO — la única forma de corregirlo (no hay
   * devoluciones). El patrón es el de la casa: REVERTIR Y RE-APLICAR, nunca
   * deltas. En una sola transacción:
   *
   *   1. La fila del envío se toma con FOR UPDATE (dos edits simultáneos se
   *      serializan; edit y anular no se pisan).
   *   2. Se valida la versión que la pantalla estaba mirando.
   *   3. Se REINGRESA todo el detalle viejo (la reversión).
   *   4. Se arma el detalle nuevo: el renglón que ya estaba CONSERVA su costo
   *      congelado; el renglón nuevo se valúa al costo de hoy.
   *   5. Se EGRESA el detalle nuevo — la validación de stock corre acá, ya con
   *      lo viejo devuelto: subir de 10 a 15 kg exige 5 de más, no 15.
   *   6. version + 1, actualizadoEn = ahora: coffit se entera en el próximo sync.
   *
   * Si algo falla (stock que no alcanza, producto inválido), la transacción
   * entera vuelve atrás y el envío queda EXACTAMENTE como estaba.
   */
  async editar(id: number, o: EditarEnvioDto, soloSentido?: 'entrada' | null) {
    const items = (o.items || []).filter((it) => Number(it.cantidad) > 0);
    if (!items.length) {
      throw new BadRequestException('Un envío sin renglones no existe: si no va más, anulalo.');
    }

    const avisos: string[] = [];
    await this.db.transaction(async (tx) => {
      const [envio] = await tx.select().from(enviosCafeteria)
        .where(eq(enviosCafeteria.id, id)).limit(1).for('update');
      if (!envio) throw new NotFoundException('Envío inexistente.');
      if (envio.estado === 'anulado') throw new BadRequestException('Un envío anulado no se edita.');
      this.verSentido(envio.sentido, soloSentido);
      if (o.version !== envio.version) {
        throw new BadRequestException('El envío cambió desde que abriste la pantalla — actualizá y volvé a intentar.');
      }

      const viejos = await tx.select().from(envioCafeteriaItems)
        .where(eq(envioCafeteriaItems.envioId, id));

      /* 3 — la reversión: el detalle viejo se deshace en el sentido que
       * corresponda (una salida vuelve a disponible; una entrada se saca). */
      await this.moverStock(tx, {
        sentido: envio.sentido, accion: 'revertir',
        sucursalId: envio.sucursalId, usuarioId: o.usuarioId, filas: viejos,
        descripcion: `${envio.codigo} v${envio.version + 1}: edición — reversión del detalle anterior`,
      });

      /* 4 — el detalle nuevo, conservando el costo congelado de lo que ya estaba. */
      const entrada = envio.sentido === 'entrada';
      const costoViejo = new Map(viejos.map((f) => [`${f.productoId}-${f.presentacionId ?? 0}`, f.costoUnitario]));
      const val = await this.valuarItems(tx, items, !entrada);
      if (entrada) this.validarEntrada(val, items);
      const { filas, total } = this.armarFilas(items, val, (clave, hoy, it) => {
        /* En una ENTRADA el costo lo declara la cafetería SIEMPRE, también al
         * corregir: si se equivocó al tipearlo, obligarla a conservar el número
         * viejo sería dejar el error adentro para siempre. */
        if (entrada) return r2(Number(it.costoUnitario));
        const congelado = costoViejo.get(clave);
        if (congelado != null) return congelado;
        avisos.push(`${val.get(clave)!.prod.nombre}: renglón nuevo, valuado al costo de hoy.`);
        return hoy;
      });

      await tx.delete(envioCafeteriaItems).where(eq(envioCafeteriaItems.envioId, id));
      await tx.insert(envioCafeteriaItems).values(filas.map((f) => ({ ...f, envioId: id })));

      /* 5 — el detalle nuevo. La validación de stock corre acá, después de la
       * reversión: si no alcanza, TODO vuelve atrás. */
      await this.moverStock(tx, {
        sentido: envio.sentido, accion: 'aplicar',
        sucursalId: envio.sucursalId, usuarioId: o.usuarioId, filas,
        descripcion: `${envio.codigo} v${envio.version + 1}: edición — detalle nuevo`,
      });

      await tx.update(enviosCafeteria).set({
        totalCosto: total,
        fecha: fechaLocal(o.fecha) ?? envio.fecha,
        observaciones: o.observaciones != null ? o.observaciones.trim() : envio.observaciones,
        version: envio.version + 1,
        actualizadoEn: new Date(),
      }).where(eq(enviosCafeteria.id, id));
    });
    return { ...(await this.get(id)), avisos };
  }

  /** Anular = reversión completa. También sube la versión: coffit tiene que deshacer su ingreso. */
  async anular(id: number, o: AnularEnvioDto, soloSentido?: 'entrada' | null) {
    if (!o.motivo?.trim()) throw new BadRequestException('Escribí por qué se anula.');
    await this.db.transaction(async (tx) => {
      const [envio] = await tx.select().from(enviosCafeteria)
        .where(eq(enviosCafeteria.id, id)).limit(1).for('update');
      if (!envio) throw new NotFoundException('Envío inexistente.');
      if (envio.estado === 'anulado') throw new BadRequestException('El envío ya está anulado.');
      this.verSentido(envio.sentido, soloSentido);

      const items = await tx.select().from(envioCafeteriaItems)
        .where(eq(envioCafeteriaItems.envioId, id));
      await this.moverStock(tx, {
        sentido: envio.sentido, accion: 'revertir',
        sucursalId: envio.sucursalId, usuarioId: o.usuarioId, filas: items,
        descripcion: envio.sentido === 'entrada'
          ? `${envio.codigo}: entrada de Cafetería ANULADA — sale lo que había ingresado`
          : `${envio.codigo}: envío a Cafetería ANULADO — reingreso completo`,
      });
      await tx.update(enviosCafeteria).set({
        estado: 'anulado', motivoAnulacion: o.motivo.trim(),
        version: envio.version + 1, actualizadoEn: new Date(),
      }).where(eq(enviosCafeteria.id, id));
    });
    return this.get(id);
  }

  /** Kg totales de un renglón, para que coffit contraste y la trampa del 20× no exista. */
  private conKg(it: any) {
    const totalKg = it.modo === 'granel' ? r3(it.cantidad)
      : it.modo === 'paquete' ? r3(it.cantidad * it.tamKg)
        : null;
    return { ...it, totalKg };
  }

  async list(q: { desde?: string; hasta?: string; estado?: string; sentido?: string; limit?: number }) {
    const conds: any[] = [];
    /* Sin `sentido` vienen los dos: el panel pide el suyo en cada pestaña, y
     * una consulta sin filtro sigue sirviendo para mirar todo junto. */
    if (q.sentido === 'salida' || q.sentido === 'entrada') {
      conds.push(eq(enviosCafeteria.sentido, q.sentido as any));
    }
    const desde = fechaLocal(q.desde);
    const hasta = fechaLocal(q.hasta);
    if (desde) conds.push(gte(enviosCafeteria.fecha, desde));
    if (hasta) { hasta.setHours(23, 59, 59, 999); conds.push(lte(enviosCafeteria.fecha, hasta)); }
    if (q.estado === 'enviado' || q.estado === 'anulado') {
      conds.push(eq(enviosCafeteria.estado, q.estado as any));
    }
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 300);

    const rows = await this.db.select({
      id: enviosCafeteria.id, codigo: enviosCafeteria.codigo,
      fecha: enviosCafeteria.fecha, sucursalId: enviosCafeteria.sucursalId,
      estado: enviosCafeteria.estado, sentido: enviosCafeteria.sentido,
      totalCosto: enviosCafeteria.totalCosto,
      observaciones: enviosCafeteria.observaciones, version: enviosCafeteria.version,
      actualizadoEn: enviosCafeteria.actualizadoEn,
      sucursalNombre: sucursales.nombre, usuarioNombre: usuarios.nombre,
    }).from(enviosCafeteria)
      .leftJoin(sucursales, eq(sucursales.id, enviosCafeteria.sucursalId))
      .leftJoin(usuarios, eq(usuarios.id, enviosCafeteria.usuarioId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(enviosCafeteria.id))
      .limit(limit);

    const cuenta = await this.db.select({
      envioId: envioCafeteriaItems.envioId,
      renglones: sql<number>`count(*)`,
    }).from(envioCafeteriaItems)
      .where(inArray(envioCafeteriaItems.envioId, rows.length ? rows.map((r) => r.id) : [-1]))
      .groupBy(envioCafeteriaItems.envioId);
    const porEnvio = new Map(cuenta.map((c) => [c.envioId, Number(c.renglones)]));
    return rows.map((r) => ({ ...r, renglones: porEnvio.get(r.id) ?? 0 }));
  }

  async get(id: number) {
    const [envio] = await this.db.select({
      id: enviosCafeteria.id, codigo: enviosCafeteria.codigo,
      fecha: enviosCafeteria.fecha, sucursalId: enviosCafeteria.sucursalId,
      estado: enviosCafeteria.estado, sentido: enviosCafeteria.sentido,
      totalCosto: enviosCafeteria.totalCosto,
      observaciones: enviosCafeteria.observaciones, motivoAnulacion: enviosCafeteria.motivoAnulacion,
      version: enviosCafeteria.version, actualizadoEn: enviosCafeteria.actualizadoEn,
      pedidoId: enviosCafeteria.pedidoId, pedidoCodigo: pedidosCafeteria.codigo,
      sucursalNombre: sucursales.nombre, usuarioNombre: usuarios.nombre,
    }).from(enviosCafeteria)
      .leftJoin(sucursales, eq(sucursales.id, enviosCafeteria.sucursalId))
      .leftJoin(usuarios, eq(usuarios.id, enviosCafeteria.usuarioId))
      .leftJoin(pedidosCafeteria, eq(pedidosCafeteria.id, enviosCafeteria.pedidoId))
      .where(eq(enviosCafeteria.id, id)).limit(1);
    if (!envio) throw new NotFoundException('Envío inexistente.');
    const items = await this.db.select().from(envioCafeteriaItems)
      .where(eq(envioCafeteriaItems.envioId, id))
      .orderBy(envioCafeteriaItems.id);
    return { ...envio, items: items.map((it) => this.conKg(it)) };
  }

  /* ==================================================================== *
   * PEDIDOS DE LA CAFETERÍA — la demanda, separada del envío
   * ==================================================================== *
   * Los arma el usuario del rol Cafetería (su única pantalla del CRM) contra
   * el catálogo completo con disponibilidad. NO tocan stock ni costo: la
   * realidad entra con el envío, que se crea desde el pedido y lo cierra.
   */

  async crearPedido(o: CrearPedidoDto) {
    const items = (o.items || []).filter((it) => Number(it.cantidad) > 0);
    if (!items.length) throw new BadRequestException('Agregá al menos un renglón con cantidad.');

    const id = await this.db.transaction(async (tx) => {
      const [suc] = await tx.select({ id: sucursales.id })
        .from(sucursales).where(eq(sucursales.id, Number(o.sucursalId) || 0)).limit(1);
      if (!suc) throw new BadRequestException('Elegí a qué sucursal le pedís la mercadería.');
      // valuarItems valida producto/presentación y da los nombres; el costo
      // que calcula acá NO se guarda — el pedido es demanda, no plata.
      const val = await this.valuarItems(tx, items);
      const filas = items.map((it) => {
        const { prod, pres } = val.get(`${it.productoId}-${it.presentacionId ?? 0}`)!;
        const esGranel = prod.tipo === 'granel' && !pres;
        const tam = pres ? (pres.tamKg < 1 ? `${Math.round(pres.tamKg * 1000)} g` : `${pres.tamKg} kg`) : '';
        return {
          productoId: prod.id,
          presentacionId: pres?.id ?? null,
          cantidad: Number(it.cantidad),
          nombre: pres ? `${prod.nombre} · ${tam}` : prod.nombre,
          unidad: esGranel ? 'kg' : (pres ? 'paq.' : 'u.'),
        };
      });

      const [pedido] = await tx.insert(pedidosCafeteria).values({
        codigo: '', usuarioId: o.usuarioId ?? null, sucursalId: suc.id,
        observaciones: (o.observaciones ?? '').trim(), actualizadoEn: new Date(),
      }).returning();
      const codigo = `PCAF${String(pedido.id).padStart(4, '0')}`;
      await tx.update(pedidosCafeteria).set({ codigo }).where(eq(pedidosCafeteria.id, pedido.id));
      await tx.insert(pedidoCafeteriaItems).values(filas.map((f) => ({ ...f, pedidoId: pedido.id })));
      return pedido.id;
    });
    return this.getPedido(id);
  }

  /**
   * `soloSuc` es lo que devuelve `soloSuSucursal(sesion)`: **`null` = sin
   * límite**, y ese es el caso del jefe (ve todos, para que un pedido hecho a
   * un local donde nadie mira el CRM no muera en silencio) y el de la
   * cafetería (está afuera de las sucursales: todos los pedidos son suyos).
   * El personal de cada local ve SOLO los que le pidieron a él.
   *
   * Los pedidos viejos no tienen sucursal (nacieron antes del 0098) y quedan
   * fuera del filtro a propósito: atribuirlos a un local sería inventar un
   * dato. Siguen a la vista del jefe, que es quien puede resolverlos.
   */
  async listPedidos(q: { estado?: string; limit?: number; soloSuc?: number | null } = {}) {
    const conds: any[] = [];
    if (q.estado && ['pendiente', 'armando', 'enviado', 'anulado'].includes(q.estado)) {
      conds.push(eq(pedidosCafeteria.estado, q.estado as any));
    }
    if (q.soloSuc) conds.push(eq(pedidosCafeteria.sucursalId, q.soloSuc));
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 300);
    const rows = await this.db.select({
      id: pedidosCafeteria.id, codigo: pedidosCafeteria.codigo, fecha: pedidosCafeteria.fecha,
      estado: pedidosCafeteria.estado, observaciones: pedidosCafeteria.observaciones,
      usuarioNombre: usuarios.nombre,
      sucursalId: pedidosCafeteria.sucursalId, sucursalNombre: sucursales.nombre,
      // El envío que lo cumplió, si ya se convirtió.
      envioId: enviosCafeteria.id, envioCodigo: enviosCafeteria.codigo,
    }).from(pedidosCafeteria)
      .leftJoin(sucursales, eq(sucursales.id, pedidosCafeteria.sucursalId))
      .leftJoin(usuarios, eq(usuarios.id, pedidosCafeteria.usuarioId))
      .leftJoin(enviosCafeteria, eq(enviosCafeteria.pedidoId, pedidosCafeteria.id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(pedidosCafeteria.id))
      .limit(limit);

    const cuenta = await this.db.select({
      pedidoId: pedidoCafeteriaItems.pedidoId,
      renglones: sql<number>`count(*)`,
    }).from(pedidoCafeteriaItems)
      .where(inArray(pedidoCafeteriaItems.pedidoId, rows.length ? rows.map((r) => r.id) : [-1]))
      .groupBy(pedidoCafeteriaItems.pedidoId);
    const porPedido = new Map(cuenta.map((c) => [c.pedidoId, Number(c.renglones)]));
    return rows.map((r) => ({ ...r, renglones: porPedido.get(r.id) ?? 0 }));
  }

  async getPedido(id: number) {
    const [pedido] = await this.db.select({
      id: pedidosCafeteria.id, codigo: pedidosCafeteria.codigo, fecha: pedidosCafeteria.fecha,
      estado: pedidosCafeteria.estado, observaciones: pedidosCafeteria.observaciones,
      motivoAnulacion: pedidosCafeteria.motivoAnulacion, actualizadoEn: pedidosCafeteria.actualizadoEn,
      usuarioId: pedidosCafeteria.usuarioId, usuarioNombre: usuarios.nombre,
      sucursalId: pedidosCafeteria.sucursalId, sucursalNombre: sucursales.nombre,
      envioId: enviosCafeteria.id, envioCodigo: enviosCafeteria.codigo,
    }).from(pedidosCafeteria)
      .leftJoin(sucursales, eq(sucursales.id, pedidosCafeteria.sucursalId))
      .leftJoin(usuarios, eq(usuarios.id, pedidosCafeteria.usuarioId))
      .leftJoin(enviosCafeteria, eq(enviosCafeteria.pedidoId, pedidosCafeteria.id))
      .where(eq(pedidosCafeteria.id, id)).limit(1);
    if (!pedido) throw new NotFoundException('Pedido inexistente.');
    const items = await this.db.select().from(pedidoCafeteriaItems)
      .where(eq(pedidoCafeteriaItems.pedidoId, id))
      .orderBy(pedidoCafeteriaItems.id);
    return { ...pedido, items };
  }

  /** El contador del badge y del aviso del admin: qué demanda espera. */
  /** El contador del menú y el aviso: cuenta lo MISMO que la lista va a
   *  mostrar, si no a Norte le sonaba la campana en el Depósito. */
  async pedidosPendientes(soloSuc?: number | null) {
    const conds: any[] = [inArray(pedidosCafeteria.estado, ['pendiente', 'armando'])];
    if (soloSuc) conds.push(eq(pedidosCafeteria.sucursalId, soloSuc));
    const rows = await this.db.select({
      estado: pedidosCafeteria.estado,
      n: sql<number>`count(*)::int`,
    }).from(pedidosCafeteria)
      .where(and(...conds))
      .groupBy(pedidosCafeteria.estado);
    const de = (e: string) => Number(rows.find((r) => r.estado === e)?.n) || 0;
    return { pendientes: de('pendiente'), armando: de('armando') };
  }

  /** pendiente → armando: "lo estoy preparando". Reclamo atómico. */
  async tomarPedido(id: number) {
    const gano = await this.db.update(pedidosCafeteria)
      .set({ estado: 'armando', actualizadoEn: new Date() })
      .where(and(eq(pedidosCafeteria.id, id), eq(pedidosCafeteria.estado, 'pendiente')))
      .returning({ id: pedidosCafeteria.id });
    if (!gano.length) throw new BadRequestException('El pedido cambió de estado — actualizá la pantalla.');
    return this.getPedido(id);
  }

  async anularPedido(id: number, o: AnularPedidoDto) {
    if (!o.motivo?.trim()) throw new BadRequestException('Escribí por qué se anula.');
    const gano = await this.db.update(pedidosCafeteria)
      .set({ estado: 'anulado', motivoAnulacion: o.motivo.trim(), actualizadoEn: new Date() })
      .where(and(
        eq(pedidosCafeteria.id, id),
        inArray(pedidosCafeteria.estado, ['pendiente', 'armando']),
      ))
      .returning({ id: pedidosCafeteria.id });
    if (!gano.length) throw new BadRequestException('Ese pedido ya se envió (o ya estaba anulado): no se anula.');
    return this.getPedido(id);
  }

  /**
   * SINCRONIZACIÓN PARA COFFIT: todo lo que cambió desde `desde` (creados,
   * editados y anulados — el anulado VIAJA, coffit tiene que deshacerlo), con
   * el detalle completo. `ahora` va en la respuesta para que coffit lo guarde
   * como el próximo `desde`: así el cursor lo pone el reloj de ESTE servidor y
   * no hay agujeros por relojes desfasados.
   *
   * EL CURSOR ES EL DE LA ÚLTIMA FILA ENVIADA, NO EL RELOJ DE PARED, y esa
   * diferencia perdía envíos en silencio. La página corta en 200: si hubo 250
   * cambios —un reproceso, una tanda de ediciones— coffit recibía los primeros
   * 200 y guardaba `ahora` como próximo cursor, con lo cual **los 50 restantes,
   * cuyo `actualizadoEn` es anterior a ese `ahora`, no se devolvían nunca más**.
   * Del otro lado eran 50 envíos de mercadería que no ingresaron a la cafetería
   * y que nadie iba a notar hasta un inventario.
   *
   * Ahora, cuando la página se llena, el cursor es el `actualizadoEn` del
   * último envío devuelto y viaja `hayMas: true` para que coffit vuelva a
   * pedir enseguida en vez de esperar al próximo ciclo.
   */
  async sync(desde?: string) {
    const TOPE = 200;
    const ahora = new Date();
    const corte = desde ? new Date(desde) : null;
    if (desde && Number.isNaN(corte!.getTime())) {
      throw new BadRequestException('El desde va en formato ISO (el "ahora" de la respuesta anterior).');
    }
    /*
     * SOLO LAS SALIDAS (0097). Coffit ingiere lo que la distribuidora le manda;
     * las ENTRADAS son mercadería que ella misma despachó y que ya tiene
     * anotada de su lado. Mandarle documentos de un sentido que no conoce
     * sería romperle el contrato a una aplicación externa en silencio — y el
     * error aparecería en SU sistema, no en el nuestro.
     */
    const soloSalida = eq(enviosCafeteria.sentido, 'salida');
    const envios = await this.db.select().from(enviosCafeteria)
      .where(corte ? and(soloSalida, gt(enviosCafeteria.actualizadoEn, corte)) : soloSalida)
      .orderBy(asc(enviosCafeteria.actualizadoEn))
      .limit(TOPE);
    const hayMas = envios.length === TOPE;

    /*
     * SE VACÍA EL GRUPO DE LA ÚLTIMA MARCA DE TIEMPO antes de mover el cursor.
     *
     * El cursor es una fecha y la próxima página pide `> cursor`, así que si el
     * corte de 200 cayera en medio de un grupo de envíos con el MISMO
     * `actualizadoEn` —dos ediciones en la misma transacción—, los que quedaron
     * del otro lado se perderían igual que antes, solo que más raro y más
     * difícil de encontrar. Traerlos ahora hace que `>` sea exacto en vez de
     * casi siempre exacto.
     */
    if (hayMas) {
      const ultima = envios[envios.length - 1].actualizadoEn;
      const yaEstan = new Set(envios.map((e) => e.id));
      const empatados = await this.db.select().from(enviosCafeteria)
        .where(and(soloSalida, eq(enviosCafeteria.actualizadoEn, ultima)));
      for (const e of empatados) if (!yaEstan.has(e.id)) envios.push(e);
    }
    const cursor = hayMas ? envios[envios.length - 1].actualizadoEn : ahora;

    const items = envios.length
      ? await this.db.select().from(envioCafeteriaItems)
        .where(inArray(envioCafeteriaItems.envioId, envios.map((e) => e.id)))
        .orderBy(envioCafeteriaItems.id)
      : [];
    const porEnvio = new Map<number, any[]>();
    for (const it of items) {
      const arr = porEnvio.get(it.envioId) ?? [];
      arr.push(this.conKg(it));
      porEnvio.set(it.envioId, arr);
    }
    return {
      /* `ahora` es el próximo `desde`. Con la página llena NO es el reloj: es la
       * marca del último envío devuelto, para no saltearse los que quedaron. */
      ahora: cursor.toISOString(),
      /* Coffit tiene que volver a pedir enseguida en vez de esperar su ciclo:
       * sin esto, una tanda grande tarda horas en llegar entera. */
      hayMas,
      envios: envios.map((e) => ({ ...e, items: porEnvio.get(e.id) ?? [] })),
    };
  }

  /**
   * MÉTRICA: qué se le mandó a coffit en el período, agregado POR ARTÍCULO.
   * Suma solo lo enviado (lo anulado no existió). El agregado corre en SQL:
   * traer todos los renglones para sumarlos en JS sería peso al aire.
   */
  async metrica(q: { desde?: string; hasta?: string; buscar?: string; sentido?: string }) {
    const desde = fechaLocal(q.desde);
    const hasta = fechaLocal(q.hasta);
    if (hasta) hasta.setHours(23, 59, 59, 999);
    /* Un sentido por vez: mezclar lo que mandamos con lo que nos mandaron en
     * una sola tabla daría un total que no significa nada. */
    const sentido = q.sentido === 'entrada' ? 'entrada' : 'salida';
    const conds: any[] = [
      eq(enviosCafeteria.estado, 'enviado'),
      eq(enviosCafeteria.sentido, sentido as any),
    ];
    if (desde) conds.push(gte(enviosCafeteria.fecha, desde));
    if (hasta) conds.push(lte(enviosCafeteria.fecha, hasta));
    const buscar = (q.buscar ?? '').trim();
    const condsItems = [...conds];
    if (buscar) condsItems.push(sql`${envioCafeteriaItems.nombre} ilike ${`%${buscar}%`}`);

    /*
     * LA CABECERA SE MIDE SOBRE EL MISMO CONJUNTO QUE LA TABLA.
     *
     * Sin `buscar` es la suma de las cabeceras de los envíos, que es lo exacto
     * (`totalCosto` es el número congelado del envío). CON `buscar` no puede
     * serlo: la tabla de abajo muestra un artículo y la tarjeta mostraba la
     * plata del período entero al lado — buscar un café de $50.000 en un mes de
     * $2.000.000 dejaba las dos cifras a diez centímetros y sin relación. Los
     * otros dos números de esa misma fila («Artículos» y «Kg totales») ya
     * respetaban el filtro, así que la tarjeta se contradecía sola.
     */
    const [cab] = buscar
      ? await this.db.select({
        envios: sql<number>`count(distinct ${envioCafeteriaItems.envioId})::int`,
        costoTotal: sql<number>`coalesce(sum(${envioCafeteriaItems.cantidad} * ${envioCafeteriaItems.costoUnitario}), 0)`,
      }).from(envioCafeteriaItems)
        .innerJoin(enviosCafeteria, eq(enviosCafeteria.id, envioCafeteriaItems.envioId))
        .where(and(...condsItems))
      : await this.db.select({
        envios: sql<number>`count(*)::int`,
        costoTotal: sql<number>`coalesce(sum(${enviosCafeteria.totalCosto}), 0)`,
      }).from(enviosCafeteria).where(and(...conds));

    const productosAgg = await this.db.select({
      productoId: envioCafeteriaItems.productoId,
      presentacionId: envioCafeteriaItems.presentacionId,
      nombre: envioCafeteriaItems.nombre,
      modo: envioCafeteriaItems.modo,
      unidad: envioCafeteriaItems.unidad,
      envios: sql<number>`count(distinct ${envioCafeteriaItems.envioId})::int`,
      cantidad: sql<number>`coalesce(sum(${envioCafeteriaItems.cantidad}), 0)`,
      kg: sql<number>`coalesce(sum(case
        when ${envioCafeteriaItems.modo} = 'granel' then ${envioCafeteriaItems.cantidad}
        when ${envioCafeteriaItems.modo} = 'paquete' then ${envioCafeteriaItems.cantidad} * ${envioCafeteriaItems.tamKg}
        else 0 end), 0)`,
      costo: sql<number>`coalesce(sum(${envioCafeteriaItems.cantidad} * ${envioCafeteriaItems.costoUnitario}), 0)`,
    }).from(envioCafeteriaItems)
      .innerJoin(enviosCafeteria, eq(enviosCafeteria.id, envioCafeteriaItems.envioId))
      .where(and(...condsItems))
      .groupBy(
        envioCafeteriaItems.productoId, envioCafeteriaItems.presentacionId,
        envioCafeteriaItems.nombre, envioCafeteriaItems.modo, envioCafeteriaItems.unidad,
      )
      .orderBy(sql`sum(${envioCafeteriaItems.cantidad} * ${envioCafeteriaItems.costoUnitario}) desc`);

    const productosOut = productosAgg.map((p) => ({
      ...p,
      cantidad: r3(Number(p.cantidad)),
      kg: r3(Number(p.kg)),
      costo: r2(Number(p.costo)),
    }));
    return {
      envios: Number(cab?.envios) || 0,
      costoTotal: r2(Number(cab?.costoTotal) || 0),
      kgTotales: r3(productosOut.reduce((a, p) => a + p.kg, 0)),
      articulos: productosOut.length,
      productos: productosOut,
    };
  }

  /**
   * EL ÚLTIMO COSTO QUE LA CAFETERÍA DECLARÓ por cada cosa que elabora, para
   * que el formulario lo proponga en vez de hacerla tipearlo cada mañana.
   *
   * Es una propuesta, no un dato: se puede pisar renglón por renglón, y lo que
   * se guarda es siempre lo que quedó en el campo. Mira solo envíos VIVOS —
   * el costo de uno anulado es un número que alguien ya descartó.
   *
   * Clave `producto-presentación` (0 = sin presentación), igual que la que usa
   * el formulario para sus renglones.
   */
  async costosEntrada() {
    /*
     * DOS FUENTES, Y UN ORDEN DE PRIORIDAD QUE IMPORTA.
     *
     * 1. EL COSTO DE LA FICHA (0099) es el que manda: alguien entró a "Mis
     *    productos" y lo declaró. Es una decisión, con fecha, y es la que la
     *    pantalla vigila cuando queda vieja.
     * 2. EL DEL ÚLTIMO ENVÍO es el respaldo, para los productos que todavía no
     *    tienen costo en la ficha (los de antes de esto). Sin él, esos
     *    renglones habrían empezado a salir vacíos de un día para el otro.
     *
     * Con la ficha primero, un costo corregido a mano en un envío puntual
     * —una tanda que salió más cara— NO se propaga al envío siguiente. Eso es
     * lo correcto: era del documento, no del producto.
     */
    const filas = await this.db
      .selectDistinctOn([envioCafeteriaItems.productoId, envioCafeteriaItems.presentacionId], {
        productoId: envioCafeteriaItems.productoId,
        presentacionId: envioCafeteriaItems.presentacionId,
        costoUnitario: envioCafeteriaItems.costoUnitario,
      })
      .from(envioCafeteriaItems)
      .innerJoin(enviosCafeteria, eq(enviosCafeteria.id, envioCafeteriaItems.envioId))
      .where(and(eq(enviosCafeteria.sentido, 'entrada'), eq(enviosCafeteria.estado, 'enviado')))
      .orderBy(
        envioCafeteriaItems.productoId,
        envioCafeteriaItems.presentacionId,
        desc(envioCafeteriaItems.envioId),
      );
    const mapa: Record<string, { costo: number; origen: 'ficha' | 'envio'; dias: number | null }> = {};
    for (const f of filas) {
      mapa[`${f.productoId}-${f.presentacionId ?? 0}`] = {
        costo: Number(f.costoUnitario), origen: 'envio', dias: null,
      };
    }

    /* La ficha pisa al último envío, y solo para el producto suelto: una
     * presentación es otro formato y su costo no es el de la unidad. */
    const deLaFicha = await this.db.select({
      id: productos.id,
      costo: productos.costoCafeteria,
      actualizado: productos.costoCafeteriaActualizado,
    }).from(productos)
      .where(and(eq(productos.origenCafeteria, true), isNotNull(productos.costoCafeteriaActualizado)));
    for (const p of deLaFicha) {
      mapa[`${p.id}-0`] = {
        costo: Number(p.costo), origen: 'ficha', dias: this.diasDesde(p.actualizado),
      };
    }
    return mapa;
  }

  /**
   * La foto de gestión del período: cuánto le costó la cafetería al negocio.
   * Envíos (a costo) MÁS los gastos imputados a ella. Las ventas las tiene
   * coffit — la rentabilidad es la resta entre los dos sistemas.
   */
  async resumen(q: { desde?: string; hasta?: string }) {
    const desde = fechaLocal(q.desde);
    const hasta = fechaLocal(q.hasta);
    if (hasta) hasta.setHours(23, 59, 59, 999);
    const condsEnvio: any[] = [eq(enviosCafeteria.estado, 'enviado')];
    const condsGasto: any[] = [eq(gastos.negocio, 'cafeteria'), ne(gastos.estado, 'anulado')];
    if (desde) { condsEnvio.push(gte(enviosCafeteria.fecha, desde)); condsGasto.push(gte(gastos.fecha, desde)); }
    if (hasta) { condsEnvio.push(lte(enviosCafeteria.fecha, hasta)); condsGasto.push(lte(gastos.fecha, hasta)); }

    /*
     * LOS DOS SENTIDOS EN UNA SOLA CONSULTA (0097). Agrupar por `sentido` sale
     * más barato que preguntar dos veces lo mismo con un filtro distinto, y
     * garantiza que los dos números salgan de la misma foto: con dos consultas,
     * un envío cargado entre una y otra hacía que el saldo no cerrara.
     */
    const porSentido = await this.db.select({
      sentido: enviosCafeteria.sentido,
      total: sql<number>`coalesce(sum(${enviosCafeteria.totalCosto}), 0)`,
      cantidad: sql<number>`count(*)::int`,
    }).from(enviosCafeteria).where(and(...condsEnvio)).groupBy(enviosCafeteria.sentido);
    /*
     * LO COMPRADO DIRECTO PARA EL CAFÉ (0101): la parte de las facturas de
     * compra que era de artículos exclusivos, con el signo del documento.
     */
    const condsCompra: any[] = [eq(comprobantes.estado, 'confirmado'), gt(comprobantes.netoCafeteria, 0)];
    if (desde) condsCompra.push(gte(comprobantes.fecha, desde));
    if (hasta) condsCompra.push(lte(comprobantes.fecha, hasta));
    const [[g], [compra], deposito] = await Promise.all([
      this.db.select({
        total: sql<number>`coalesce(sum(${gastos.total}), 0)`,
        cantidad: sql<number>`count(*)`,
      }).from(gastos).where(and(...condsGasto)),
      this.db.select({
        total: sql<number>`coalesce(sum(${comprobantes.netoCafeteria} * ${SIGNO_COMPRA}), 0)`,
        cantidad: sql<number>`count(*) filter (where ${comprobantes.tipo} in ('factura', 'liquidacion'))::int`,
      }).from(comprobantes).where(and(...condsCompra)),
      this.existenciasDelCafe(),
    ]);

    const de = (s: string) => porSentido.find((x) => x.sentido === s);
    const enviado = Number(de('salida')?.total ?? 0);
    const recibido = Number(de('entrada')?.total ?? 0);
    const gastosCafe = Number(g?.total ?? 0);
    return {
      /** Comprado a proveedores directo para el café en el período (neto). */
      compradoDirecto: r2(Number(compra?.total ?? 0)),
      comprasCantidad: Number(compra?.cantidad ?? 0),
      /** Mercadería del café guardada HOY en las sucursales, a costo. Es una foto, no un período. */
      enDeposito: r2(deposito.reduce((a, f) => a + f.valor, 0)),
      enviado: r2(enviado),
      enviosCantidad: Number(de('salida')?.cantidad ?? 0),
      /** Lo que la cafetería mandó a las sucursales, al costo que ella declaró. */
      recibido: r2(recibido),
      recibidosCantidad: Number(de('entrada')?.cantidad ?? 0),
      /** A favor de la distribuidora cuando es positivo: le mandó más de lo que recibió. */
      saldo: r2(enviado - recibido),
      gastos: r2(gastosCafe),
      gastosCantidad: Number(g?.cantidad ?? 0),
      costoTotal: r2(enviado + gastosCafe),
    };
  }

  /* ==================================================================== *
   * EL DEPÓSITO DEL CAFÉ — lo que es suyo y está guardado acá (0101)
   * ==================================================================== *
   * Todo el stock disponible de los artículos de USO EXCLUSIVO de la
   * cafetería, en todas las sucursales, valuado al costo real de hoy. Es lo
   * que la compra directa ya le imputó al café y todavía no cruzó la calle:
   * el casillero del medio entre "comprado" y "consumido".
   *
   * Sin depósito paralelo ni estado de stock nuevo: la marca de la ficha
   * dice de quién es cada unidad, y con eso alcanza porque un artículo
   * exclusivo es del café entero — no hay que partirlo.
   */
  private async existenciasDelCafe() {
    const prods = await this.db.select({
      id: productos.id, nombre: productos.nombre, tipo: productos.tipo, iva: productos.iva,
      codigoPropio: productos.codigoPropio,
    }).from(productos)
      .where(and(eq(productos.soloCafeteria, true), ne(productos.estado, 'archivado')));
    if (!prods.length) return [];
    const ids = prods.map((p) => p.id);

    const [filas, provs, press] = await Promise.all([
      this.db.select({
        productoId: stock.productoId, presentacionId: stock.presentacionId,
        sucursalId: stock.sucursalId, cantidad: stock.cantidad,
      }).from(stock).where(and(
        inArray(stock.productoId, ids), eq(stock.estado, 'disponible'), gt(stock.cantidad, 1e-9),
      )),
      this.db.select().from(productoProveedores).where(inArray(productoProveedores.productoId, ids)),
      this.db.select().from(presentaciones).where(inArray(presentaciones.productoId, ids)),
    ]);
    const prodDe = new Map(prods.map((p) => [p.id, p]));
    const presDe = new Map(press.map((p) => [p.id, p]));
    /* El costo de hoy, una vez por producto y no por fila. */
    const costoKg = new Map<number, number>();
    for (const p of prods) {
      costoKg.set(p.id, costoNetoEntry(formatoActivo(provs.filter((x) => x.productoId === p.id)) as any, p.iva));
    }

    /* Un renglón por artículo (producto + presentación), con su stock por sucursal. */
    const porArticulo = new Map<string, any>();
    for (const f of filas) {
      const prod = prodDe.get(f.productoId)!;
      const pres = f.presentacionId ? presDe.get(f.presentacionId) : null;
      if (f.presentacionId && !pres) continue;
      const clave = `${f.productoId}-${f.presentacionId ?? 0}`;
      let a = porArticulo.get(clave);
      if (!a) {
        const esGranel = prod.tipo === 'granel' && !pres;
        const tam = pres ? (pres.tamKg < 1 ? `${Math.round(pres.tamKg * 1000)} g` : `${pres.tamKg} kg`) : '';
        const cnKg = costoKg.get(prod.id) ?? 0;
        a = {
          productoId: prod.id, presentacionId: pres?.id ?? null,
          nombre: pres ? `${prod.nombre} · ${tam}` : prod.nombre,
          codigoPropio: prod.codigoPropio || '',
          unidad: esGranel ? 'kg' : (pres ? 'paq.' : 'u.'),
          costoU: r2(pres ? cnKg * (pres.tamKg ?? 1) : cnKg),
          porSucursal: {} as Record<number, number>,
          total: 0, valor: 0,
        };
        porArticulo.set(clave, a);
      }
      a.porSucursal[f.sucursalId] = (a.porSucursal[f.sucursalId] ?? 0) + f.cantidad;
      a.total += f.cantidad;
      a.valor = r2(a.total * a.costoU);
    }
    return [...porArticulo.values()].sort((x, y) => y.valor - x.valor);
  }

  /** La pantalla: qué hay guardado para el café, dónde y cuánto vale. */
  async deposito() {
    const [articulos, sucs] = await Promise.all([
      this.existenciasDelCafe(),
      this.db.select({ id: sucursales.id, nombre: sucursales.nombre }).from(sucursales).orderBy(asc(sucursales.id)),
    ]);
    /* Solo las sucursales que tienen algo: seis columnas vacías no dicen nada. */
    const conStock = new Set<number>();
    for (const a of articulos) for (const k of Object.keys(a.porSucursal)) conStock.add(Number(k));
    return {
      sucursales: sucs.filter((s) => conStock.has(s.id)),
      articulos,
      valor: r2(articulos.reduce((a, f) => a + f.valor, 0)),
    };
  }
}

/**
 * DOS PANTALLAS Y DOS LLAVES, y son de lados opuestos del mostrador:
 * `almacen.cafeteria` es la de la distribuidora (arma y edita los envíos, que
 * EGRESAN stock real) y `almacen.cafeteria-pedidos` es la del rol Cafetería,
 * que solo pide. La clase pide la primera y los tres endpoints de pedidos
 * aceptan además la segunda — sin eso, el rol Cafetería se quedaba sin su única
 * pantalla.
 *
 * `sync` va aparte y con su propio comentario: es el único endpoint del sistema
 * que consume una aplicación EXTERNA.
 */
@Controller('cafeteria')
@Permiso('almacen.cafeteria')
export class CafeteriaController {
  constructor(private readonly svc: CafeteriaService) {}

  @Get('envios')
  @Permiso('almacen.cafeteria', 'almacen.cafeteria-entradas')
  list(
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('estado') estado?: string,
    @Query('sentido') sentido?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.list({ desde, hasta, estado, sentido, limit: limit ? Number(limit) : undefined });
  }

  /* El resumen viaja en la MISMA carga que abre la pantalla: si pide un
   * permiso que el rol Cafetería no tiene, su 403 tumba las otras cuatro
   * consultas y la pantalla entera queda en "no se pudieron cargar". */
  @Get('resumen')
  @Permiso('almacen.cafeteria', 'almacen.cafeteria-entradas')
  resumen(@Query('desde') desde?: string, @Query('hasta') hasta?: string) {
    return this.svc.resumen({ desde, hasta });
  }

  /* ---- Los productos que hace la cafetería (la puerta chica a su catálogo) ----
   *
   * MIRAR es de toda la sección; ESCRIBIR, solo de quien carga las entradas.
   *
   * La diferencia importa: `almacen.cafeteria` es un permiso DE FÁBRICA que
   * tiene cualquier rol del negocio (ver `permisos-base.ts`), así que pedir esa
   * llave para el alta le habría dado a cualquier cajera una puerta al catálogo
   * que Compras › Productos justamente le niega. `almacen.cafeteria-entradas`
   * la tienen solo la cafetería y el administrador, que son los dos que tienen
   * algo que ver con lo que el café elabora.
   */

  @Permiso('almacen.cafeteria', 'almacen.cafeteria-entradas')
  @Get('productos') listarProductosCafe() {
    return this.svc.productosDelCafe();
  }

  @Permiso('almacen.cafeteria-entradas')
  @Post('productos') crearProductoCafe(@Body() dto: ProductoCafeDto) {
    return this.svc.crearProductoDelCafe(dto);
  }

  @Permiso('almacen.cafeteria-entradas')
  @Patch('productos/:id') editarProductoCafe(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ProductoCafeDto,
  ) {
    return this.svc.editarProductoDelCafe(id, dto);
  }

  @Permiso('almacen.cafeteria-entradas')
  @Post('productos/:id/baja') bajaProductoCafe(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { activar?: boolean },
  ) {
    return this.svc.bajaProductoDelCafe(id, !!body?.activar);
  }

  /* Lo que es del café y está guardado en las sucursales. Lo mira la
   * distribuidora y lo mira el café —es SU mercadería—, así que acepta las
   * llaves de las dos puntas. */
  @Get('deposito')
  @Permiso('almacen.cafeteria', 'almacen.cafeteria-pedidos', 'almacen.cafeteria-entradas')
  deposito() {
    return this.svc.deposito();
  }

  @Get('costos-entrada')
  @Permiso('almacen.cafeteria', 'almacen.cafeteria-entradas')
  costosEntrada() {
    return this.svc.costosEntrada();
  }

  @Get('metrica')
  @Permiso('almacen.cafeteria', 'almacen.cafeteria-entradas')
  metrica(
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('buscar') buscar?: string,
    @Query('sentido') sentido?: string,
  ) {
    return this.svc.metrica({ desde, hasta, buscar, sentido });
  }

  /**
   * EL ENDPOINT DE COFFIT: todo lo que cambió desde el cursor.
   *
   * Es el único que consume una aplicación EXTERNA, y por eso tiene su propia
   * llave: `COFFIT_TOKEN` en el `.env`, que se manda en `X-Coffit-Token`. Sin
   * esa cabecera sigue valiendo la sesión del CRM, así que **hoy no rompe nada**
   * y el día que se coordine con coffit alcanza con cargarle el secreto.
   *
   * Por qué hacía falta: hasta acá coffit se autenticaba con un token de sesión
   * común de 12 h, o sea con usuario y contraseña de alguien del CRM guardados
   * en la configuración de otra máquina. Ese token no es "solo lectura de
   * envíos" — es el panel entero, y con él se mueve stock. El contrato
   * (`docs/contrato-coffit.md`) prometía un token de solo lectura desde el
   * principio; esto es ese token, y **solo abre esta puerta**.
   */
  @Get('sync')
  @ClaveServicio('COFFIT_TOKEN')
  sync(@Query('desde') desde?: string) {
    return this.svc.sync(desde);
  }
  /* ---- Pedidos de la cafetería (la demanda) ---- */

  /*
   * CADA SUCURSAL VE LOS PEDIDOS QUE LE HICIERON A ELLA (0098) — decisión del
   * dueño. El jefe los ve todos: si un pedido cae en un local donde nadie mira
   * el CRM, alguien tiene que poder verlo. La cafetería también los ve todos,
   * por el motivo contrario: los hizo ella.
   *
   * El filtro sale de la SESIÓN, nunca de la query: si viniera por parámetro,
   * cambiar un número en la URL mostraría los de cualquier local.
   */
  @Permiso('almacen.cafeteria', 'almacen.cafeteria-pedidos')
  @Get('pedidos') listPedidos(
    @Auth() sesion: Sesion,
    @Query('estado') estado?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.listPedidos({
      estado, limit: limit ? Number(limit) : undefined, soloSuc: soloSuSucursal(sesion),
    });
  }

  /** El poller del aviso del admin: un count, nada más. */
  @Permiso('almacen.cafeteria', 'almacen.cafeteria-pedidos')
  @Get('pedidos-pendientes') pedidosPendientes(@Auth() sesion: Sesion) {
    return this.svc.pedidosPendientes(soloSuSucursal(sesion));
  }

  @Permiso('almacen.cafeteria', 'almacen.cafeteria-pedidos')
  @Get('pedidos/:id') getPedido(@Param('id', ParseIntPipe) id: number) {
    return this.svc.getPedido(id);
  }

  @Permiso('almacen.cafeteria', 'almacen.cafeteria-pedidos')
  @Post('pedidos') crearPedido(@Body() dto: CrearPedidoDto) {
    return this.svc.crearPedido(dto);
  }

  @Post('pedidos/:id/tomar') tomarPedido(@Param('id', ParseIntPipe) id: number) {
    return this.svc.tomarPedido(id);
  }

  @Permiso('almacen.cafeteria', 'almacen.cafeteria-pedidos')
  @Post('pedidos/:id/anular') anularPedido(@Param('id', ParseIntPipe) id: number, @Body() dto: AnularPedidoDto) {
    return this.svc.anularPedido(id, dto);
  }

  @Get('envios/:id')
  @Permiso('almacen.cafeteria', 'almacen.cafeteria-entradas')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.svc.get(id);
  }

  /*
   * El rol Cafetería carga SUS envíos —los de entrada— y por eso este endpoint
   * acepta su llave. Lo que NO puede es mandar una salida: eso egresa stock
   * real de la distribuidora. El candado está abajo, en `soloSuSentido`.
   */
  /** Quien no tiene la llave de la distribuidora solo maneja ENTRADAS. */
  private soloEntradas(sesion: Sesion): 'entrada' | null {
    return tienePermiso(sesion.permisos ?? [], ['almacen.cafeteria']) ? null : 'entrada';
  }

  @Post('envios')
  @Permiso('almacen.cafeteria', 'almacen.cafeteria-entradas')
  crear(@Body() dto: CrearEnvioDto, @Auth() sesion: Sesion) {
    return this.svc.crear(dto, this.soloEntradas(sesion));
  }

  @Put('envios/:id')
  @Permiso('almacen.cafeteria', 'almacen.cafeteria-entradas')
  editar(@Param('id', ParseIntPipe) id: number, @Body() dto: EditarEnvioDto, @Auth() sesion: Sesion) {
    return this.svc.editar(id, dto, this.soloEntradas(sesion));
  }

  @Post('envios/:id/anular')
  @Permiso('almacen.cafeteria', 'almacen.cafeteria-entradas')
  anular(@Param('id', ParseIntPipe) id: number, @Body() dto: AnularEnvioDto, @Auth() sesion: Sesion) {
    return this.svc.anular(id, dto, this.soloEntradas(sesion));
  }
}

@Module({
  /* `ProductosModule` para poder dar de alta lo que la cafetería elabora sin
   * duplicar acá el alta de un producto (códigos, validaciones, precios). */
  imports: [InventarioModule, ProductosModule],
  controllers: [CafeteriaController],
  providers: [CafeteriaService],
  exports: [CafeteriaService],
})
export class CafeteriaModule {}
