/**
 * CAFETERÍA — el puente con coffit.
 * ============================================================================
 * El dueño tiene DOS negocios con el MISMO CUIT: la distribuidora (este
 * sistema) y una cafetería cuyo stock maneja OTRO sistema (coffit). El envío
 * NO es una transferencia entre sucursales — no hay receptor en el ERP — sino
 * un PUNTO DE SALIDA: la mercadería egresa del stock valorizada A COSTO
 * congelado y del otro lado coffit la ingresa en su almacén "Sabor y Aroma",
 * donde ELLA decide qué es cada cosa (góndola, insumo, lo que sea).
 *
 * Reglas que NO se negocian:
 *  - El ERP nunca muestra existencias de Cafetería (coffit es el dueño).
 *  - El envío va a COSTO: la ganancia aparece donde se genera (cuando el café
 *    vende), no en un traspaso interno.
 *  - La CLASIFICACIÓN de la mercadería es de coffit. El ERP no pregunta
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
import { PERMISO_METRICAS_CAFE, soloSuSucursal, tienePermiso, veMetricasDelCafe } from '../auth/auth.guard';
import {
  comprobanteItems, comprobantes, enviosCafeteria, envioCafeteriaItems, gastoCategorias, gastoItems, gastos, incidencias, listasVenta, pedidoCafeteriaItems,
  pedidosCafeteria, precioHistorial, presentaciones, productoListas, productoProveedores, productos,
  coffitCierres, coffitMovimientos, proveedores, stock, sucursales, usuarios,
} from '../db/schema';
import { ProductosModule, ProductosService } from '../productos/productos.module';
import { InventarioModule } from '../inventario/inventario.module';
import { InventarioService } from '../inventario/inventario.service';
import { costoNetoEntry, escalaPaquete, formatoActivo, formatoDeCosto } from '../inventario/pricing';
import {
  costoUltimaFactura, cupoCafe, exigirCuentaAbierta, finDia, hoyAr, inicioDia, lineasCuenta, saldoAl, sumaTotales, sumarDias, totalesCuenta,
  totalesDeLineas, ultimoCierre,
} from './cuenta';

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

const r3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;
/**
 * CUÁNTO PARA ATRÁS PUEDE IR LA FECHA DE UN ENVÍO (26/9/2026).
 *
 * El stock se mueve en el momento de cargarlo, sea cual sea la fecha: la fecha
 * solo dice en qué período cuenta. Sin límite se aceptaba 2020 o 2031, y eso
 * mete o saca plata de un mes ya mirado (o de uno que todavía no existe) sin
 * que nadie lo note. Una semana alcanza para "me olvidé de cargar el lunes".
 */
const DIAS_ATRAS_ENVIO = 7;
/**
 * La incidencia de un faltante al recibir un envío de la cafetería (0113). No
 * retiene stock —no hay nada que liberar—: se cierra revisando (ver
 * `InventarioService.cerrarRecepcionCafe`).
 */
const TIPO_RECEPCION_CAFE = InventarioService.TIPO_RECEPCION_CAFE;

/**
 * Las alícuotas que se ofrecen para lo que elabora el café (ver
 * `ProductoCafeDto.iva`). El 0 es "sin IVA" (27/9/2026, pedido del dueño):
 * lo que se vende tipo remito, sin IVA que cobrar — el precio del mostrador es
 * todo neto. ARCA lo conoce (alícuota 0 %, código 3).
 */
const ALICUOTAS_CAFE = [21, 10.5, 0];
const r6 = (n: number) => Math.round((Number(n) || 0) * 1e6) / 1e6;
/** Una cantidad como se lee: 2,5 y no 2.5000000001. */
/** Un importe como se lee acá: $5.000,00. */
const plata = (n: number) => `$${Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cantTxt = (n: number) => Number(n).toLocaleString('es-AR', { maximumFractionDigits: 3 });

class EnvioItemDto {
  @IsInt() productoId!: number;
  @IsOptional() @IsInt() presentacionId?: number;
  @IsNumber() @Min(0.001) @Max(100000) cantidad!: number;
  /**
   * EL COSTO QUE DECLARA LA CAFETERÍA (0097), solo en los envíos de ENTRADA.
   * Ahí el ERP no puede saberlo — la medialuna la hizo coffit — así que lo
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

class RenglonRecibidoDto {
  @IsInt() itemId!: number;
  @IsNumber() @Min(0) @Max(100000) cantidadRecibida!: number;
}

/**
 * EL CONTROL DEL QUE RECIBE (0113): un número por renglón, contado contra el
 * remito. La pantalla propone "llegó completo" (lo enviado) y se cambia solo
 * donde falta. Todos los renglones tienen que venir: uno sin contar no se da
 * por llegado.
 */
class RecibirEnvioDto {
  @IsArray() @ArrayNotEmpty({ message: 'Contá los renglones del envío antes de recibirlo.' }) @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => RenglonRecibidoDto)
  items!: RenglonRecibidoDto[];
  @IsOptional() @IsString() @MaxLength(500) observaciones?: string;
}

/** Un movimiento a mano en la cuenta con Coffit (0120). */
class MovimientoCuentaDto {
  @IsIn(['saldo_inicial', 'pago', 'compensacion', 'ajuste']) tipo!: string;
  /** 'coffit' = baja lo que Coffit debe (Coffit pagó); 'sya' = sube (S&A le pagó a Coffit, o un cargo). */
  @IsIn(['sya', 'coffit']) aFavor!: string;
  @IsNumber() @Min(0.01, { message: 'El importe tiene que ser mayor a cero.' }) @Max(10_000_000_000) importe!: number;
  @IsOptional() @IsString() @MaxLength(10) fecha?: string;
  @IsString() @MaxLength(300) descripcion!: string;
  @IsOptional() @IsString() @MaxLength(40) medio?: string;
  @IsOptional() @IsString() @MaxLength(80) referencia?: string;
}

class CerrarCuentaDto {
  /** Último día que cubre el cierre, 'AAAA-MM-DD'. */
  @IsString() @MaxLength(10) hasta!: string;
  /** El saldo que se vio en la pantalla: si cambió algo en el medio, no se cierra. */
  @IsNumber() saldoEsperado!: number;
  @IsOptional() @IsString() @MaxLength(500) observaciones?: string;
}

class MotivoDto {
  @IsString() @MaxLength(300) motivo!: string;
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
  /** «Sí, ya pedí esto mismo hoy, va otra vez»: lo manda la pantalla después de preguntar. */
  @IsOptional() @IsBoolean() confirmarDuplicado?: boolean;
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
  /**
   * EL IVA DEL MOSTRADOR (26/9/2026): 21 % por defecto, 10,5 % para lo que la
   * ley grava a la mitad (el pan, por ejemplo). Quién va en cuál lo decide el
   * contador; acá solo se ofrecen las dos que aplican a lo que hace un café.
   */
  @IsOptional() @IsIn(ALICUOTAS_CAFE, { message: 'El IVA del mostrador va al 21 %, al 10,5 % o sin IVA.' }) iva?: number;
  /** «Sí, lo vendo por debajo del costo a propósito»: lo manda la pantalla después de preguntar. */
  @IsOptional() @IsBoolean() confirmarPerdida?: boolean;
}

/**
 * LA EDICIÓN: lo mismo que el alta, pero el PRECIO ES OPCIONAL (26/9/2026).
 *
 * Si la distribuidora le puso el precio por MARGEN, la cafetería no lo toca
 * desde acá: la pantalla no lo manda y la API rechaza si llega. Obligarla a
 * tipear un precio para poder corregir solo el costo convertía la regla de
 * margen en un precio fijo, en silencio.
 */
class EditarProductoCafeDto {
  @IsString() @MaxLength(120) nombre!: string;
  @IsOptional() @IsNumber() @Min(0.01) @Max(100_000_000) precio?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100_000_000) costo?: number;
  @IsOptional() @IsIn(ALICUOTAS_CAFE, { message: 'El IVA del mostrador va al 21 %, al 10,5 % o sin IVA.' }) iva?: number;
  @IsOptional() @IsBoolean() confirmarPerdida?: boolean;
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
    /* LO QUE SALE HACIA COFFIT VA AL COSTO DE LA ÚLTIMA FACTURA (29/9/2026,
     * decisión del dueño en la conciliación): lo que de verdad se pagó, no la
     * lista de hoy. Sin factura, el costo del formato de compra. */
    const ultimaFactura = conCosto ? await this.costoUltimaFactura(tx, ids) : new Map<number, number>();

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
      const cnKg = !conCosto ? 0
        : (ultimaFactura.get(prod.id)
          ?? costoNetoEntry(formatoDeCosto(prod, provs.filter((p: any) => p.productoId === prod.id)) as any, prod.iva));
      out.set(clave, { prod, pres, costoU: pres ? cnKg * escalaPaquete(pres.tamKg ?? 1, prod.merma) : cnKg });
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
          `${prod.nombre} no es un producto de Coffit. `
          + 'Marcalo como "Lo elabora Coffit" en su ficha, o sacalo del envío.',
        );
      }
    }
    for (const it of items) {
      if (it.costoUnitario == null) {
        const { prod } = val.get(`${it.productoId}-${it.presentacionId ?? 0}`)!;
        throw new BadRequestException(
          `Falta el costo de ${prod.nombre}. En una entrada lo declara Coffit: sin él, ese producto quedaría con rentabilidad inventada.`,
        );
      }
    }
  }

  /**
   * LA PRIMERA DECLARACIÓN LLENA LA FICHA VACÍA (26/9/2026).
   *
   * Desde que la venta toma el costo de la ficha (`formatoDeCosto`), una ficha
   * que nunca se declaró deja a ese producto vendiéndose a costo cero aunque
   * la cafetería lo esté declarando en cada envío. Si la ficha está VACÍA, el
   * costo de este envío pasa a ser el suyo, con la fecha de hoy.
   *
   * Una ficha YA declarada no se toca: ahí sigue valiendo la regla de 0099 —
   * pisar el costo en un envío puntual (una tanda más cara) es del documento,
   * no del producto. Solo el renglón suelto: el costo de un paquete es otro.
   */
  private async llenarFichasVacias(tx: any, filas: any[]) {
    const ultimo = new Map<number, number>();
    for (const f of filas) if (!f.presentacionId) ultimo.set(f.productoId, Number(f.costoUnitario));
    for (const [productoId, costo] of ultimo) {
      await tx.update(productos)
        .set({ costoCafeteria: r2(costo), costoCafeteriaActualizado: new Date() })
        .where(and(
          eq(productos.id, productoId),
          eq(productos.origenCafeteria, true),
          isNull(productos.costoCafeteriaActualizado),
        ));
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
      throw new ForbiddenException('Ese producto no es de Coffit: se edita desde Compras › Productos.');
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
      iva: productos.iva,
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
          iva: Number(f.iva) || 0,
          /* El margen sale de los dos números de esta misma fila, y es la razón
           * por la que importa que ninguno de los dos esté viejo. Sin costo no
           * hay margen — y esa ausencia también dice algo.
           *
           * SOBRE EL PRECIO SIN IVA (26/9/2026). El precio del mostrador trae el
           * IVA adentro y ese IVA es de ARCA, no del café; el costo es neto. Se
           * comparaban $1.500 contra $700 y salía 53 %, cuando la venta guarda
           * $1.239,67 contra $700: 43,5 %. Ahora es el mismo número que va a
           * dar la rentabilidad de Gerencia. */
          margen: precio != null && costo != null && precio > 0
            ? r2(((precio / (1 + (Number(f.iva) || 0) / 100) - costo) / (precio / (1 + (Number(f.iva) || 0) / 100))) * 100)
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

  /**
   * UN NOMBRE, UN PRODUCTO (26/9/2026). Se podían cargar dos "Medialuna" con
   * precios distintos y la cajera veía las dos en la caja sin saber cuál era
   * cuál. Se compara contra TODO el catálogo vivo (no solo lo del café): una
   * medialuna del café llamada igual que una de la distribuidora confunde igual.
   * Sin mayúsculas, tildes ni espacios de más. Lo archivado no cuenta: ya no
   * aparece en ningún buscador.
   */
  private async exigirNombreLibre(nombre: string, exceptoId?: number) {
    const clave = (t: string) => t.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ').trim();
    const buscado = clave(nombre);
    /* El catálogo vivo entero (unos miles de nombres): comparar en SQL sin
     * tildes pediría la extensión `unaccent`, y esto corre solo al guardar. */
    const parecidos = await this.db.select({ id: productos.id, nombre: productos.nombre, codigo: productos.codigoPropio })
      .from(productos)
      .where(ne(productos.estado, 'archivado' as any));
    const otro = parecidos.find((x) => x.id !== exceptoId && clave(x.nombre) === buscado);
    if (otro) {
      throw new BadRequestException(
        `Ya hay un producto que se llama "${otro.nombre}"${otro.codigo ? ` (código ${otro.codigo})` : ''}. `
        + 'Poné un nombre que los distinga en la caja, o editá ese.',
      );
    }
  }

  /**
   * PRECIO POR DEBAJO DEL COSTO (26/9/2026). Se guardaba $0,01 con un costo de
   * $5.000 y la pantalla mostraba "−49.999.900 %" como si nada. Puede ser a
   * propósito (una liquidación, una muestra), así que no se prohíbe: se pide
   * confirmarlo. Se compara SIN IVA, igual que el margen.
   */
  private exigirPrecioSobreCosto(nombre: string, precio: number | null, costo: number | null, iva: number, confirmado?: boolean) {
    if (confirmado || precio == null || costo == null) return;
    const neto = precio / (1 + iva / 100);
    if (neto + 0.005 >= costo) return;
    throw new ConflictException({
      perdida: true,
      message: `Con ese precio ${nombre} se vende por debajo del costo: sin IVA quedan ${plata(neto)} `
        + `y hacerlo cuesta ${plata(costo)}. Si es a propósito, confirmalo.`,
    });
  }

  async crearProductoDelCafe(dto: ProductoCafeDto) {
    const nombre = this.nombreDelProducto(dto);
    await this.exigirNombreLibre(nombre);
    const iva = dto.iva ?? 21;
    this.exigirPrecioSobreCosto(nombre, Number(dto.precio), dto.costo ?? null, iva, dto.confirmarPerdida);
    const lista = await this.listaMostrador();
    const p: any = await this.prods.create({
      nombre,
      iva,
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

  async editarProductoDelCafe(id: number, dto: EditarProductoCafeDto, usuarioId?: number | null) {
    const nombre = this.nombreDelProducto(dto as any);
    const p = await this.productoDelCafe(id);
    await this.exigirNombreLibre(nombre, id);
    const lista = await this.listaMostrador();

    /*
     * EL CAFÉ TOCA SOLO SU FILA: la del mostrador (26/9/2026).
     *
     * Antes se reemplazaba el formato de venta ENTERO por esa sola fila, así que
     * si la distribuidora le había cargado un precio mayorista, cambiarle el
     * nombre a la medialuna lo borraba. Ahora se leen las filas que hay, se
     * cambia únicamente la del mostrador, y las demás vuelven tal cual (con su
     * código de caja, sus unidades y su mínimo).
     *
     * Y si esa fila va POR MARGEN, el precio es de la distribuidora: no se toca,
     * y si la pantalla lo manda igual se rechaza con un mensaje.
     */
    const filas = await this.db.select().from(productoListas)
      .where(and(eq(productoListas.productoId, id), isNull(productoListas.presentacionId)));
    const mostrador = filas.find((f) => f.listaId === lista.id);
    if (dto.precio != null && mostrador?.modoPrecio === 'markup') {
      throw new BadRequestException(
        `El precio de ${p.nombre} lo fija Sabor y Aroma por margen: desde acá no se cambia. Si tiene que ser otro, pedíselo a ellos.`,
      );
    }
    /* El precio y el costo con los que va a quedar: lo que se manda, o lo que
     * ya tenía. Por margen no hay precio fijo que comparar. */
    const iva = dto.iva ?? Number(p.iva);
    const precioFinal = dto.precio != null ? Number(dto.precio)
      : (mostrador?.modoPrecio === 'precio' ? Number(mostrador.precioFijo) : null);
    const costoFinal = dto.costo != null ? Number(dto.costo)
      : (p.costoCafeteriaActualizado ? Number(p.costoCafeteria) : null);
    this.exigirPrecioSobreCosto(nombre, precioFinal, costoFinal, iva, dto.confirmarPerdida);

    /* Solo el nombre (y el IVA): el tipo NO se cambia después del alta. Pasar
     * de contar a pesar (o al revés) le cambia el significado a todo el stock
     * y a todos los envíos que ya existen — eso es un producto nuevo. */
    await this.prods.update(id, { nombre, iva, esGranel: p.tipo === 'granel' } as any);

    const nuevo = dto.precio != null ? Number(dto.precio) : null;
    const cambiaPrecio = nuevo != null
      && !(mostrador?.modoPrecio === 'precio' && Math.abs(Number(mostrador.precioFijo) - nuevo) < 0.005);
    if (cambiaPrecio) {
      const comoItem = (f: any) => ({
        listaId: f.listaId, modoPrecio: f.modoPrecio, markup: f.markup, precioFijo: f.precioFijo,
        unidades: f.unidades, codigoBarras: f.codigoBarras, unidadesMinimas: f.unidadesMinimas,
      });
      const items: any[] = filas.filter((f) => f.listaId !== lista.id).map(comoItem);
      items.push(mostrador
        ? { ...comoItem(mostrador), modoPrecio: 'precio', precioFijo: nuevo }
        : { listaId: lista.id, modoPrecio: 'precio', precioFijo: nuevo, unidades: 1 });
      await this.prods.setListas(id, items, usuarioId ?? null);
    }
    await this.guardarCostoDelCafe(p, dto.costo);
    return this.productosDelCafe();
  }

  /** Dejó de hacerlo: sale del catálogo pero su historia queda. */
  async bajaProductoDelCafe(id: number, activar: boolean) {
    const p = await this.productoDelCafe(id);
    if (activar) {
      await this.exigirNombreLibre(p.nombre, id);
    } else {
      /*
       * CON STOCK NO SE DA DE BAJA, y el mensaje de Compras (liquidalo con una
       * oferta, dalo de baja por merma, dejalo discontinuado) le habla a quien
       * tiene esas herramientas. El café no las tiene: lo que le sirve saber es
       * dónde quedó y qué hacer.
       */
      const quedan = await this.db.select({ sucursal: sucursales.nombre, cantidad: sql<number>`sum(${stock.cantidad})` })
        .from(stock).innerJoin(sucursales, eq(sucursales.id, stock.sucursalId))
        .where(and(eq(stock.productoId, id), gt(stock.cantidad, 1e-9), inArray(stock.estado, ['disponible', 'comprometido', 'retenido', 'en_transito'] as any)))
        .groupBy(sucursales.nombre);
      if (quedan.length) {
        const donde = quedan.map((q) => `${cantTxt(Number(q.cantidad))} en ${q.sucursal}`).join(', ');
        throw new BadRequestException(
          `Todavía quedan ${donde}. Dejá de mandarlo y, cuando se venda lo que queda, lo das de baja. `
          + 'Si se tiró o se venció, avisale a Sabor y Aroma para que lo den de baja del stock.',
        );
      }
    }
    await this.prods.cambiarEstado(id, { estado: activar ? 'activo' : 'archivado' } as any);
    return this.productosDelCafe();
  }

  /**
   * LA HUELLA DE UN DETALLE: qué se mandó, cuánto y a qué costo, sin importar
   * en qué orden se cargaron los renglones.
   */
  /**
   * LO QUE COFFIT YA PAGÓ Y TODAVÍA NO SE LE MANDÓ (0119), por artículo y en
   * su unidad base (kg el granel, unidades el resto).
   *
   * Un artículo COMPARTIDO tildado «para Coffit» en una factura le cargó el
   * costo al café al comprarlo, pero la mercadería se queda en el depósito
   * mezclada con la de la distribuidora. El cupo es lo comprado así QUE ENTRÓ
   * AL DEPÓSITO (remito, factura o liquidación con recepción: si el proveedor
   * le entregó directo a Coffit, no hay nada que mandarle; una NC que devuelve
   * mercadería lo baja) menos lo que
   * los envíos ya tomaron de ahí. Los envíos anulados devuelven lo que tomaron
   * solos, porque dejan de contar.
   */
  private cupoCafe(tx: any, ids: number[], exceptoEnvioId?: number) {
    return cupoCafe(tx, ids, exceptoEnvioId);
  }

  /**
   * CUÁNTO DE CADA RENGLÓN DE UNA SALIDA YA LO PAGÓ COFFIT (0119). El
   * exclusivo (la marca de la ficha, congelada en el renglón), entero. El compartido, lo que alcance del cupo (`cupoCafe`),
   * renglón por renglón en el orden del envío. El resto del renglón sale del
   * stock propio de la distribuidora y es lo que le mueve la plata al café.
   *
   * El candado serializa solo a los envíos que traen compartidos: dos envíos a
   * la vez no pueden tomar el mismo cupo dos veces.
   */
  private async asignarExclusivo(tx: any, filas: any[], exceptoEnvioId?: number) {
    for (const f of filas) f.cantidadExclusiva = f.exclusivo ? Number(f.cantidad) : 0;
    const compartidos = [...new Set(filas.filter((f) => !f.exclusivo).map((f) => Number(f.productoId)))];
    if (!compartidos.length) return;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('cafe:cupo'))`);
    const cupo = await this.cupoCafe(tx, compartidos, exceptoEnvioId);
    for (const f of filas) {
      if (f.exclusivo) continue;
      const queda = cupo.get(Number(f.productoId)) ?? 0;
      if (queda <= 1e-9) continue;
      const factor = f.modo === 'unidad' ? 1 : (Number(f.tamKg) || 1);
      const toma = Math.min(Number(f.cantidad) * factor, queda);
      cupo.set(Number(f.productoId), r6(queda - toma));
      f.cantidadExclusiva = r6(toma / factor);
    }
  }

  /**
   * $ por unidad base (kg o u.) de la ÚLTIMA factura (o liquidación) de cada
   * producto: el neto del renglón con su descuento y la bonificación general ya
   * repartida, sin IVA. Una sola consulta con DISTINCT ON.
   */
  private costoUltimaFactura(tx: any, ids: number[]): Promise<Map<number, number>> {
    return costoUltimaFactura(tx, ids);
  }

  /** Para la pantalla del envío: el costo al que va a salir cada producto. */
  async costosSalida(ids: number[]) {
    const limpios = [...new Set(ids.filter((x) => Number.isInteger(x) && x > 0))].slice(0, 300);
    if (!limpios.length) return {};
    const val = await this.valuarItems(this.db, limpios.map((productoId) => ({ productoId })), true);
    const out: Record<number, number> = {};
    for (const [, v] of val) out[v.prod.id] = r2(v.costoU);
    return out;
  }

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
      throw new ForbiddenException('Desde Coffit solo se cargan los envíos que salen de Coffit.');
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
      throw new BadRequestException('Un envío de Coffit no cumple pedidos: los pedidos son lo que ella pide.');
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

      const fecha = this.fechaDelEnvio(o.fecha);
      await exigirCuentaAbierta(tx, fecha, 'cargar un envío con esa fecha');
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
      if (!entrada) await this.asignarExclusivo(tx, filas);
      await tx.insert(envioCafeteriaItems).values(filas.map((f) => ({ ...f, envioId: envio.id })));
      if (entrada) await this.llenarFichasVacias(tx, filas);

      /*
       * CADA LADO MUEVE SU STOCK EN SU MOMENTO (0113). La SALIDA egresa acá: la
       * mercadería dejó la distribuidora. La ENTRADA no toca nada todavía: entra
       * al stock de la sucursal recién cuando la sucursal la controla y la
       * recibe, y entra LO QUE CONTÓ (ver `recibir`). Las dos nacen con la
       * recepción `pendiente`.
       */
      if (!entrada) {
        await this.moverStock(tx, {
          sentido, accion: 'aplicar', sucursalId: sucId, usuarioId: o.usuarioId, filas,
          descripcion: `${codigo}: enviado a Coffit`,
        });
      }
      return envio.id;
    });
    return this.get(id);
  }

  /**
   * EDITAR UN ENVÍO YA ENVIADO — la única forma de corregirlo (no hay
   * devoluciones). En una sola transacción:
   *
   *   1. La fila del envío se toma con FOR UPDATE (dos edits simultáneos se
   *      serializan; edit y anular no se pisan).
   *   2. Se valida la versión que la pantalla estaba mirando.
   *   3. Se arma el detalle nuevo: en una salida el renglón que ya estaba
   *      CONSERVA su costo congelado y el nuevo se valúa al de hoy; en una
   *      entrada el costo es siempre el que declara la cafetería.
   *   4. El stock: en una SALIDA se mueve solo por la diferencia de cada
   *      artículo; en una ENTRADA nunca (entra al recibir, con lo contado).
   *      YA RECIBIDO, la cantidad enviada solo puede BAJAR hasta lo que se
   *      contó —para corregir lo que en realidad no salió—; no se agregan
   *      renglones ni se sube: eso es otro envío (0113).
   *   5. version + 1, actualizadoEn = ahora: coffit se entera en el próximo sync.
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

      /* 3 — el detalle nuevo, conservando el costo congelado de lo que ya estaba. */
      const entrada = envio.sentido === 'entrada';
      const costoViejo = new Map(viejos.map((f) => [`${f.productoId}-${f.presentacionId ?? 0}`, f.costoUnitario]));
      /* La marca «uso exclusivo» con que salió cada renglón queda como estaba
       * (29/9/2026): prender o apagar la marca en la ficha después no puede
       * cambiar quién pagó un envío ya hecho. */
      const exclusivoViejo = new Map(viejos.map((f) => [`${f.productoId}-${f.presentacionId ?? 0}`, !!f.exclusivo]));
      /* LA CUENTA DEL MES CERRADO NO SE TOCA (0120). */
      await exigirCuentaAbierta(tx, envio.fecha, `corregir ${envio.codigo}`);
      const val = await this.valuarItems(tx, items, !entrada);
      if (entrada) this.validarEntrada(val, items);
      const { filas, total } = this.armarFilas(items, val, (clave, hoy, it) => {
        /* En una ENTRADA el costo lo declara la cafetería SIEMPRE, también al
         * corregir: si se equivocó al tipearlo, obligarla a conservar el número
         * viejo sería dejar el error adentro para siempre. */
        if (entrada) {
          /* Ya recibida, el costo quedó fijo (0120): es lo que se le reconoció a
           * Coffit en la cuenta. Un cambio posterior va como ajuste. */
          const antes = costoViejo.get(clave);
          if (envio.recepcion !== 'pendiente' && antes != null && Math.abs(Number(it.costoUnitario) - antes) > 0.004) {
            throw new BadRequestException(
              `${envio.codigo} ya se recibió: el costo de ${val.get(clave)!.prod.nombre} quedó fijo en ${antes}. `
              + 'Si hay que reconocer otra cosa, va como ajuste en la cuenta corriente.',
            );
          }
          return r2(Number(it.costoUnitario));
        }
        const congelado = costoViejo.get(clave);
        if (congelado != null) return congelado;
        avisos.push(`${val.get(clave)!.prod.nombre}: renglón nuevo, valuado al costo de hoy.`);
        return hoy;
      });

      const antes = this.sumarPorArticulo(viejos);
      const despues = this.sumarPorArticulo(filas);

      /*
       * 4a — YA RECIBIDO (0113): lo contado manda. La cantidad enviada puede
       * bajar hasta lo recibido (lo que en realidad no salió) y nada más: subir
       * o agregar sería declarar mercadería que el que recibió nunca contó.
       */
      const recibido = envio.recepcion !== 'pendiente';
      const recPor = new Map<string, number>();
      for (const f of viejos) {
        const k = `${f.productoId}-${f.presentacionId ?? 0}`;
        recPor.set(k, r6((recPor.get(k) ?? 0) + Number(f.cantidadRecibida ?? 0)));
      }
      if (recibido) {
        for (const k of new Set([...antes.keys(), ...despues.keys()])) {
          const a = antes.get(k);
          const d = despues.get(k);
          const nombre = (d ?? a)!.nombre;
          const nuevo = d?.cantidad ?? 0;
          const rec = recPor.get(k) ?? 0;
          if (!a) {
            throw new BadRequestException(`${envio.codigo} ya se recibió: no se le agregan renglones (${nombre}). Si falta mandar algo, hacé otro envío.`);
          }
          if (nuevo > a.cantidad + 1e-9) {
            throw new BadRequestException(`${envio.codigo} ya se recibió: la cantidad de ${nombre} no se sube. Si falta mandar, hacé otro envío.`);
          }
          if (nuevo + 1e-9 < rec) {
            throw new BadRequestException(
              `${nombre}: al recibir se contaron ${cantTxt(rec)} ${a.unidad.replace(/\.$/, '')}. Lo enviado no puede quedar por debajo de lo que llegó.`,
            );
          }
        }
      }

      /*
       * 4b — EL STOCK, SOLO EN LA SALIDA Y SOLO POR LA DIFERENCIA (26/9/2026).
       * Lo que no cambió no se toca; lo que sube egresa la diferencia y lo que
       * baja vuelve por la diferencia. La ENTRADA no mueve nada al editar: su
       * stock es el que contó la sucursal al recibir.
       */
      const suben: any[] = [];
      const bajan: any[] = [];
      if (!entrada) {
        for (const k of new Set([...antes.keys(), ...despues.keys()])) {
          const d = r6((despues.get(k)?.cantidad ?? 0) - (antes.get(k)?.cantidad ?? 0));
          if (Math.abs(d) < 1e-9) continue;
          const art = despues.get(k) ?? antes.get(k)!;
          (d > 0 ? suben : bajan).push({ ...art, cantidad: Math.abs(d) });
        }
      }

      for (const f of filas) {
        const k = `${f.productoId}-${f.presentacionId ?? 0}`;
        if (exclusivoViejo.has(k)) f.exclusivo = exclusivoViejo.get(k);
      }
      /* Qué parte de cada renglón ya la pagó Coffit, sin contar lo que este
       * mismo envío tomaba antes de la corrección (0119). */
      if (!entrada) await this.asignarExclusivo(tx, filas, id);

      /* Lo contado viaja con cada renglón: se reparte por artículo en el orden
       * de los renglones (casi siempre hay uno solo por artículo). */
      const quedaPor = new Map(recPor);
      const filasConRecibido = filas.map((f) => {
        if (!recibido) return { ...f, cantidadRecibida: null };
        const k = `${f.productoId}-${f.presentacionId ?? 0}`;
        const tomo = Math.min(Number(f.cantidad), quedaPor.get(k) ?? 0);
        quedaPor.set(k, r6((quedaPor.get(k) ?? 0) - tomo));
        return { ...f, cantidadRecibida: r6(tomo) };
      });
      await tx.delete(envioCafeteriaItems).where(eq(envioCafeteriaItems.envioId, id));
      await tx.insert(envioCafeteriaItems).values(filasConRecibido.map((f) => ({ ...f, envioId: id })));
      if (entrada) await this.llenarFichasVacias(tx, filas);

      /* Primero lo que vuelve (baja) y después lo que sale (sube): la validación
       * de stock corre con lo devuelto ya adentro. */
      for (const m of [
        { accion: 'revertir' as const, filas: bajan, texto: 'vuelve la diferencia' },
        { accion: 'aplicar' as const, filas: suben, texto: 'sale la diferencia' },
      ]) {
        if (!m.filas.length) continue;
        await this.moverStock(tx, {
          sentido: envio.sentido, accion: m.accion,
          sucursalId: envio.sucursalId, usuarioId: o.usuarioId, filas: m.filas,
          descripcion: `${envio.codigo} v${envio.version + 1}: corrección — ${m.texto}`,
        });
      }

      /* Si ya se había recibido, se recalcula: si lo enviado quedó igual a lo
       * contado, las diferencias se resolvieron corrigiendo el envío. */
      const recepcion = !recibido ? envio.recepcion
        : ([...despues.entries()].every(([k, d]) => Math.abs(d.cantidad - (recPor.get(k) ?? 0)) < 1e-9)
          ? 'recibido' : 'con_diferencias');

      /* Tampoco se lo puede mudar a un mes cerrado (0120). */
      const fechaNueva = this.fechaDelEnvio(o.fecha, envio.fecha);
      await exigirCuentaAbierta(tx, fechaNueva, `pasar ${envio.codigo} a esa fecha`);

      await tx.update(enviosCafeteria).set({
        totalCosto: total,
        recepcion,
        fecha: fechaNueva,
        observaciones: o.observaciones != null ? o.observaciones.trim() : envio.observaciones,
        version: envio.version + 1,
        actualizadoEn: new Date(),
      }).where(eq(enviosCafeteria.id, id));
    });
    return { ...(await this.get(id)), avisos };
  }

  /** Cantidad por artículo (producto + presentación), sumando renglones repetidos. */
  private sumarPorArticulo(filas: any[]) {
    const m = new Map<string, { productoId: number; presentacionId: number | null; cantidad: number; nombre: string; unidad: string }>();
    for (const f of filas) {
      const k = `${f.productoId}-${f.presentacionId ?? 0}`;
      const x = m.get(k);
      if (x) x.cantidad = r6(x.cantidad + Number(f.cantidad));
      else m.set(k, { productoId: f.productoId, presentacionId: f.presentacionId ?? null, cantidad: Number(f.cantidad), nombre: f.nombre, unidad: f.unidad });
    }
    return m;
  }

  /**
   * LA FECHA DEL ENVÍO, validada. Sin fecha es ahora; nunca futura; hasta
   * `DIAS_ATRAS_ENVIO` días atrás. Al editar, dejar el mismo día no se revalida:
   * corregir hoy un envío de hace un mes no tiene que obligar a moverle la fecha.
   */
  private fechaDelEnvio(txt?: string, previa?: Date | null) {
    const f = fechaLocal(txt);
    if (!f) return previa ?? new Date();
    if (Number.isNaN(f.getTime())) throw new BadRequestException('La fecha del envío no es válida.');
    const dia = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (previa && dia(f) === dia(new Date(previa))) return previa;
    const hoy = new Date();
    if (dia(f) > dia(hoy)) throw new BadRequestException('La fecha del envío no puede ser futura.');
    const limite = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - DIAS_ATRAS_ENVIO);
    if (dia(f) < limite.getTime()) {
      throw new BadRequestException(
        `La fecha del envío puede ir hasta ${DIAS_ATRAS_ENVIO} días para atrás (desde el ${limite.toLocaleDateString('es-AR')}). `
        + 'Uno más viejo cambiaría la cuenta de un período que ya se miró: cargalo con la fecha de hoy y aclaralo en observaciones.',
      );
    }
    return f;
  }

  /**
   * Anular = reversión completa, y SOLO MIENTRAS NO SE RECIBIÓ (0113). Una vez
   * controlado, la mercadería ya está del otro lado: anular la haría volver en
   * los papeles sin que vuelva de verdad. Después de recibido se corrige con
   * Editar (bajando hasta lo que llegó) y los faltantes van por su incidencia.
   * La salida devuelve su egreso; la entrada pendiente no había movido nada.
   * También sube la versión: coffit tiene que deshacer su ingreso.
   */
  async anular(id: number, o: AnularEnvioDto, soloSentido?: 'entrada' | null) {
    if (!o.motivo?.trim()) throw new BadRequestException('Escribí por qué se anula.');
    await this.db.transaction(async (tx) => {
      const [envio] = await tx.select().from(enviosCafeteria)
        .where(eq(enviosCafeteria.id, id)).limit(1).for('update');
      if (!envio) throw new NotFoundException('Envío inexistente.');
      if (envio.estado === 'anulado') throw new BadRequestException('El envío ya está anulado.');
      this.verSentido(envio.sentido, soloSentido);
      await exigirCuentaAbierta(tx, envio.fecha, `anular ${envio.codigo}`);
      if (envio.recepcion !== 'pendiente') {
        throw new BadRequestException(
          `${envio.codigo} ya se recibió y se controló: no se anula. Si algo no salió, corregilo con Editar `
          + '(se puede bajar hasta lo que llegó); si faltó mercadería, se resuelve desde su incidencia.',
        );
      }

      if (envio.sentido === 'salida') {
        const items = await tx.select().from(envioCafeteriaItems)
          .where(eq(envioCafeteriaItems.envioId, id));
        await this.moverStock(tx, {
          sentido: envio.sentido, accion: 'revertir',
          sucursalId: envio.sucursalId, usuarioId: o.usuarioId, filas: items,
          descripcion: `${envio.codigo}: envío a Coffit ANULADO — reingreso completo`,
        });
      }
      await tx.update(enviosCafeteria).set({
        estado: 'anulado', motivoAnulacion: o.motivo.trim(),
        version: envio.version + 1, actualizadoEn: new Date(),
      }).where(eq(enviosCafeteria.id, id));
    });
    return this.get(id);
  }

  /**
   * QUIÉN RECIBE (0113): el OTRO lado. La salida la recibe la cafetería; la
   * entrada, la sucursal a la que llega (su gente, o la administración). El
   * que mandó no puede darlo por recibido: el control existe justamente para
   * que lo mire otra persona. El superadmin pasa siempre.
   */
  private exigirReceptor(envio: any, sesion: Sesion) {
    const permisos = sesion?.permisos ?? [];
    if (permisos.includes('*')) return;
    if (sesion?.usuarioId && envio.usuarioId === sesion.usuarioId) {
      throw new ForbiddenException('Este envío lo cargaste vos: lo tiene que controlar y recibir otra persona.');
    }
    const esCafe = tienePermiso(permisos, ['almacen.cafeteria-entradas']) && !tienePermiso(permisos, ['almacen.cafeteria']);
    if (envio.sentido === 'salida') {
      if (!esCafe) throw new ForbiddenException('Este envío lo recibe Coffit: lo controla y lo marca ella.');
      return;
    }
    if (esCafe) throw new ForbiddenException('Lo que mandaste lo controla y lo recibe la sucursal a la que llega.');
    const suya = soloSuSucursal(sesion);
    if (suya != null && suya !== envio.sucursalId) {
      throw new ForbiddenException('Este envío llega a otra sucursal: lo recibe esa sucursal.');
    }
  }

  /**
   * RECIBIR Y CONTROLAR (0113). El que recibe cuenta contra el remito y deja
   * un número por renglón. En una ENTRADA recién acá entra el stock a la
   * sucursal, y entra LO CONTADO. Lo que falta no desaparece: cada faltante
   * abre una incidencia para la administración (ya no hay mercadería retenida
   * que liberar: se resuelve revisando y corrigiendo el envío si no salió).
   *
   * No sube la versión: coffit sincroniza lo que la distribuidora le manda, y
   * el control de recepción no le cambia nada de eso.
   */
  async recibir(id: number, o: RecibirEnvioDto, sesion: Sesion) {
    const creadas: string[] = [];
    await this.db.transaction(async (tx) => {
      const [envio] = await tx.select().from(enviosCafeteria)
        .where(eq(enviosCafeteria.id, id)).limit(1).for('update');
      if (!envio) throw new NotFoundException('Envío inexistente.');
      if (envio.estado === 'anulado') throw new BadRequestException('Un envío anulado no se recibe.');
      if (envio.recepcion !== 'pendiente') throw new BadRequestException(`${envio.codigo} ya se recibió.`);
      this.exigirReceptor(envio, sesion);

      const items = await tx.select().from(envioCafeteriaItems)
        .where(eq(envioCafeteriaItems.envioId, id)).orderBy(envioCafeteriaItems.id);
      const contado = new Map((o.items ?? []).map((x) => [Number(x.itemId), Number(x.cantidadRecibida)]));
      const sinContar = items.filter((it) => !contado.has(it.id));
      if (sinContar.length) {
        throw new BadRequestException(
          `Falta contar ${sinContar.length === 1 ? 'un renglón' : `${sinContar.length} renglones`}: `
          + `${sinContar.slice(0, 3).map((it) => it.nombre).join(', ')}${sinContar.length > 3 ? '…' : ''}.`,
        );
      }

      const [suc] = await tx.select({ nombre: sucursales.nombre }).from(sucursales)
        .where(eq(sucursales.id, envio.sucursalId)).limit(1);
      const entrada = envio.sentido === 'entrada';
      const ruta = entrada ? `Coffit → ${suc?.nombre ?? 'sucursal'}` : `${suc?.nombre ?? 'Distribuidora'} → Coffit`;
      const entran: any[] = [];
      let hayDiferencias = false;

      for (const it of items) {
        const rec = r6(contado.get(it.id)!);
        if (rec > Number(it.cantidad) + 1e-9) {
          throw new BadRequestException(
            `${it.nombre}: se mandaron ${cantTxt(Number(it.cantidad))} ${it.unidad} y no pueden llegar más. `
            + 'Si vino de más, que el que lo mandó corrija el envío.',
          );
        }
        if (it.modo !== 'granel' && !Number.isInteger(rec)) {
          throw new BadRequestException(`${it.nombre} se cuenta entero: ${cantTxt(rec)} no es una cantidad posible.`);
        }
        await tx.update(envioCafeteriaItems).set({ cantidadRecibida: rec }).where(eq(envioCafeteriaItems.id, it.id));
        if (rec > 1e-9) entran.push({ productoId: it.productoId, presentacionId: it.presentacionId, cantidad: rec });

        const falta = r6(Number(it.cantidad) - rec);
        if (falta > 1e-9) {
          hayDiferencias = true;
          const [inc] = await tx.insert(incidencias).values({
            codigo: '', tipo: TIPO_RECEPCION_CAFE, estado: 'pendiente', responsableId: sesion?.usuarioId ?? null,
            motivo: `${envio.codigo} ${ruta}: se mandaron ${cantTxt(Number(it.cantidad))} ${it.unidad} de ${it.nombre} `
              + `y llegaron ${cantTxt(rec)}. Faltan ${cantTxt(falta)}.`,
            productoId: it.productoId, sucursalId: envio.sucursalId, presentacionId: it.presentacionId,
            cantidad: falta, unidad: it.modo === 'granel' ? 'kg' : 'u',
          } as any).returning();
          const codigo = 'INC' + String(inc.id).padStart(4, '0');
          await tx.update(incidencias).set({ codigo }).where(eq(incidencias.id, inc.id));
          creadas.push(codigo);
        }
      }

      if (entrada && entran.length) {
        await this.moverStock(tx, {
          sentido: 'entrada', accion: 'aplicar', sucursalId: envio.sucursalId, usuarioId: sesion?.usuarioId ?? null,
          filas: entran, descripcion: `${envio.codigo}: recibido de Coffit (controlado)`,
        });
      }
      await tx.update(enviosCafeteria).set({
        recepcion: hayDiferencias ? 'con_diferencias' : 'recibido',
        recibidoEn: new Date(),
        recibidoPor: sesion?.usuarioId ?? null,
        recepcionObs: (o.observaciones ?? '').trim(),
      }).where(eq(enviosCafeteria.id, id));
    });
    return { ...(await this.get(id)), incidencias: creadas };
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
      recepcion: enviosCafeteria.recepcion,
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
      usuarioId: enviosCafeteria.usuarioId,
      recepcion: enviosCafeteria.recepcion, recibidoEn: enviosCafeteria.recibidoEn,
      recibidoPor: enviosCafeteria.recibidoPor, recepcionObs: enviosCafeteria.recepcionObs,
    }).from(enviosCafeteria)
      .leftJoin(sucursales, eq(sucursales.id, enviosCafeteria.sucursalId))
      .leftJoin(usuarios, eq(usuarios.id, enviosCafeteria.usuarioId))
      .leftJoin(pedidosCafeteria, eq(pedidosCafeteria.id, enviosCafeteria.pedidoId))
      .where(eq(enviosCafeteria.id, id)).limit(1);
    if (!envio) throw new NotFoundException('Envío inexistente.');
    const items = await this.db.select().from(envioCafeteriaItems)
      .where(eq(envioCafeteriaItems.envioId, id))
      .orderBy(envioCafeteriaItems.id);
    const [rec] = envio.recibidoPor
      ? await this.db.select({ nombre: usuarios.nombre }).from(usuarios).where(eq(usuarios.id, envio.recibidoPor)).limit(1)
      : [];
    return { ...envio, recibidoPorNombre: rec?.nombre ?? null, items: items.map((it) => this.conKg(it)) };
  }

  /* ==================================================================== *
   * PEDIDOS DE LA CAFETERÍA — la demanda, separada del envío
   * ==================================================================== *
   * Los arma el usuario del rol Cafetería (su única pantalla del ERP) contra
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
        /* La misma regla que el envío: solo el granel se fracciona. Se pedían
         * 2,5 paquetes y el que armaba tenía que adivinar si eran 2 o 3. */
        if (!esGranel && !Number.isInteger(Number(it.cantidad))) {
          throw new BadRequestException(
            `${prod.nombre} se pide por ${pres ? 'paquete' : 'unidad'} entera: ${cantTxt(Number(it.cantidad))} no es una cantidad posible.`,
          );
        }
        const tam = pres ? (pres.tamKg < 1 ? `${Math.round(pres.tamKg * 1000)} g` : `${pres.tamKg} kg`) : '';
        return {
          productoId: prod.id,
          presentacionId: pres?.id ?? null,
          cantidad: Number(it.cantidad),
          nombre: pres ? `${prod.nombre} · ${tam}` : prod.nombre,
          unidad: esGranel ? 'kg' : (pres ? 'paq.' : 'u.'),
        };
      });

      /*
       * EL PEDIDO GEMELO (26/9/2026), mismo criterio que el del envío: otro
       * pedido ABIERTO de hoy a la misma sucursal con exactamente el mismo
       * detalle. Dos clics, dos pestañas o "¿se mandó?" y volver a mandar
       * terminaban en dos pedidos iguales, y la sucursal armaba dos veces. No
       * bloquea: se pregunta, y si de verdad va otra vez se confirma.
       */
      if (!o.confirmarDuplicado) {
        const huella = filas.map((f) => `${f.productoId}-${f.presentacionId ?? 0}:${f.cantidad}`).sort().join('|');
        const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`pcaf:${suc.id}:${hoy.toISOString().slice(0, 10)}:${huella}`}))`);
        const abiertos = await tx.select({ id: pedidosCafeteria.id, codigo: pedidosCafeteria.codigo })
          .from(pedidosCafeteria)
          .where(and(
            eq(pedidosCafeteria.sucursalId, suc.id),
            inArray(pedidosCafeteria.estado, ['pendiente', 'armando']),
            gte(pedidosCafeteria.fecha, hoy),
          ))
          .orderBy(desc(pedidosCafeteria.id)).limit(10);
        if (abiertos.length) {
          const suyos = await tx.select().from(pedidoCafeteriaItems)
            .where(inArray(pedidoCafeteriaItems.pedidoId, abiertos.map((a: any) => a.id)));
          const gemelo = abiertos.find((a: any) => suyos.filter((x: any) => x.pedidoId === a.id)
            .map((x: any) => `${x.productoId}-${x.presentacionId ?? 0}:${Number(x.cantidad)}`).sort().join('|') === huella);
          if (gemelo) {
            throw new ConflictException({
              duplicado: gemelo.codigo,
              message: `Hoy ya le pediste exactamente esto a esa sucursal: ${gemelo.codigo}, y sigue abierto. Si de verdad va otra vez, confirmalo.`,
            });
          }
        }
      }

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
   * un local donde nadie mira el ERP no muera en silencio) y el de la
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
  async pedidosPendientes(soloSuc?: number | null, sesion?: Sesion) {
    const porRecibir = sesion ? await this.porRecibir(sesion) : 0;
    const conds: any[] = [inArray(pedidosCafeteria.estado, ['pendiente', 'armando'])];
    if (soloSuc) conds.push(eq(pedidosCafeteria.sucursalId, soloSuc));
    const rows = await this.db.select({
      estado: pedidosCafeteria.estado,
      n: sql<number>`count(*)::int`,
    }).from(pedidosCafeteria)
      .where(and(...conds))
      .groupBy(pedidosCafeteria.estado);
    const de = (e: string) => Number(rows.find((r) => r.estado === e)?.n) || 0;
    return { pendientes: de('pendiente'), armando: de('armando'), porRecibir };
  }

  /**
   * LO QUE ESPERA QUE YO LO CONTROLE (0113). La cafetería: las salidas que le
   * mandaron. La distribuidora: las entradas que llegan a su sucursal (el jefe,
   * todas). Sin esto el envío quedaba "pendiente" sin que nadie se enterara.
   */
  private async porRecibir(sesion: Sesion) {
    const permisos = sesion.permisos ?? [];
    const esCafe = tienePermiso(permisos, ['almacen.cafeteria-entradas']) && !tienePermiso(permisos, ['almacen.cafeteria']);
    const conds: any[] = [eq(enviosCafeteria.estado, 'enviado'), eq(enviosCafeteria.recepcion, 'pendiente')];
    if (esCafe) conds.push(eq(enviosCafeteria.sentido, 'salida'));
    else {
      conds.push(eq(enviosCafeteria.sentido, 'entrada'));
      const suya = soloSuSucursal(sesion);
      if (suya != null) conds.push(eq(enviosCafeteria.sucursalId, suya));
    }
    const [r] = await this.db.select({ n: sql<number>`count(*)::int` }).from(enviosCafeteria).where(and(...conds));
    return Number(r?.n) || 0;
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

  /**
   * `soloPendiente` (26/9/2026): la cafetería anula lo que TODAVÍA NADIE TOMÓ.
   * Uno en "armando" ya tiene a alguien preparándolo en la sucursal: si el café
   * lo anulaba por su cuenta, el que armaba se enteraba al terminar. La pantalla
   * ya lo decía; ahora la API también.
   */
  async anularPedido(id: number, o: AnularPedidoDto, soloPendiente = false) {
    if (!o.motivo?.trim()) throw new BadRequestException('Escribí por qué se anula.');
    const gano = await this.db.update(pedidosCafeteria)
      .set({ estado: 'anulado', motivoAnulacion: o.motivo.trim(), actualizadoEn: new Date() })
      .where(and(
        eq(pedidosCafeteria.id, id),
        inArray(pedidosCafeteria.estado, soloPendiente ? ['pendiente'] : ['pendiente', 'armando']),
      ))
      .returning({ id: pedidosCafeteria.id });
    if (!gano.length) {
      const [ped] = await this.db.select({ estado: pedidosCafeteria.estado }).from(pedidosCafeteria)
        .where(eq(pedidosCafeteria.id, id)).limit(1);
      if (!ped) throw new NotFoundException('Pedido inexistente.');
      if (ped.estado === 'armando') {
        throw new BadRequestException('Ese pedido ya lo están armando: avisale a la sucursal que no lo necesitás y que lo anulen ellos.');
      }
      throw new BadRequestException('Ese pedido ya se envió (o ya estaba anulado): no se anula.');
    }
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
   * La foto de gestión del período: cuánto le costó la cafetería al negocio y
   * cómo queda la cuenta entre los dos. Desde la cuenta corriente (0120) los
   * números de plata salen de `cuenta.ts`, la MISMA regla que usan la cuenta y
   * Gerencia: lo recibido vale por lo contado, los gastos van al neto y el
   * saldo incluye pagos y ajustes.
   */
  async resumen(q: { desde?: string; hasta?: string }) {
    const desde = fechaLocal(q.desde);
    const hasta = fechaLocal(q.hasta);
    if (hasta) hasta.setHours(23, 59, 59, 999);
    const condsEnvio: any[] = [eq(enviosCafeteria.estado, 'enviado')];
    const condsGasto: any[] = [eq(gastos.negocio, 'cafeteria'), ne(gastos.estado, 'anulado')];
    const condsCompra: any[] = [eq(comprobantes.estado, 'confirmado'), gt(comprobantes.netoCafeteria, 0),
      inArray(comprobantes.tipo, ['factura', 'liquidacion'])];
    if (desde) {
      condsEnvio.push(gte(enviosCafeteria.fecha, desde)); condsGasto.push(gte(gastos.fecha, desde));
      condsCompra.push(gte(comprobantes.fecha, desde));
    }
    if (hasta) {
      condsEnvio.push(lte(enviosCafeteria.fecha, hasta)); condsGasto.push(lte(gastos.fecha, hasta));
      condsCompra.push(lte(comprobantes.fecha, hasta));
    }
    const alDia = q.hasta && /^\d{4}-\d{2}-\d{2}$/.test(q.hasta) ? q.hasta : hoyAr();
    const [porSentido, tot, [g], [compra], deposito, saldoCuenta] = await Promise.all([
      this.db.select({
        sentido: enviosCafeteria.sentido,
        total: sql<number>`coalesce(sum(${enviosCafeteria.totalCosto}), 0)`,
        cantidad: sql<number>`count(*)::int`,
      }).from(enviosCafeteria).where(and(...condsEnvio)).groupBy(enviosCafeteria.sentido),
      totalesCuenta(this.db, desde, hasta),
      this.db.select({ cantidad: sql<number>`count(*)::int` }).from(gastos).where(and(...condsGasto)),
      this.db.select({ cantidad: sql<number>`count(*)::int` }).from(comprobantes).where(and(...condsCompra)),
      this.existenciasDelCafe(),
      saldoAl(this.db, alDia),
    ]);
    const de = (s: string) => porSentido.find((x) => x.sentido === s);
    return {
      /** Comprado a proveedores para Coffit en el período (neto, la NC resta). */
      compradoDirecto: tot.compras,
      comprasCantidad: Number(compra?.cantidad ?? 0),
      /** Mercadería de Coffit guardada HOY en las sucursales. Es una foto, no un período. */
      enDeposito: r2(deposito.reduce((a, f) => a + f.valor, 0)),
      /** Todo lo mandado a costo (incluye lo que Coffit ya había pagado). */
      enviado: r2(Number(de('salida')?.total ?? 0)),
      enviosCantidad: Number(de('salida')?.cantidad ?? 0),
      /** Lo que Coffit mandó a las sucursales, por lo contado al recibir (0120). */
      recibido: r2(-tot.entradas),
      recibidosCantidad: Number(de('entrada')?.cantidad ?? 0),
      /** Lo que se le cobra de lo mandado: sin lo ya pagado y con los faltantes descontados. */
      enviadoDesdeStock: tot.envios,
      /** Gastos de Coffit al neto de lo que recupera la empresa (IVA y percepciones). */
      gastos: tot.gastos,
      gastosCantidad: Number(g?.cantidad ?? 0),
      /** Pagos, compensaciones y ajustes del período (+ = a favor de S&A). */
      manuales: tot.manuales,
      /** Lo que se movió la cuenta en el período. Positivo: Coffit debe más. */
      saldo: sumaTotales(tot),
      /** EL SALDO DE LA CUENTA al final del período, con todo lo anterior. */
      saldoCuenta,
      saldoCuentaAl: alDia,
      /** Lo que el café le costó al negocio en el período: comprado + mandado de stock + gastos. */
      costoTotal: r2(tot.compras + tot.envios + tot.gastos),
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
      codigoPropio: productos.codigoPropio, merma: productos.merma,
    }).from(productos)
      .where(and(eq(productos.soloCafeteria, true), ne(productos.estado, 'archivado')));
    /* Sin exclusivos igual puede haber compartidos ya pagados por Coffit. */
    if (!prods.length) return this.pendientesCompartidos();
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
    /* Valuado como se cobra (29/9/2026): al costo de la última factura, y sin
     * factura al del formato de compra. Una vez por producto, no por fila. */
    const ultima = await this.costoUltimaFactura(this.db, ids);
    const costoKg = new Map<number, number>();
    for (const p of prods) {
      costoKg.set(p.id, ultima.get(p.id)
        ?? costoNetoEntry(formatoActivo(provs.filter((x) => x.productoId === p.id)) as any, p.iva));
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
          costoU: r2(pres ? cnKg * escalaPaquete(pres.tamKg ?? 1, prod.merma) : cnKg),
          porSucursal: {} as Record<number, number>,
          total: 0, valor: 0,
        };
        porArticulo.set(clave, a);
      }
      a.porSucursal[f.sucursalId] = (a.porSucursal[f.sucursalId] ?? 0) + f.cantidad;
      a.total += f.cantidad;
      a.valor = r2(a.total * a.costoU);
    }
    return [...porArticulo.values(), ...await this.pendientesCompartidos()].sort((x, y) => y.valor - x.valor);
  }

  /**
   * LOS COMPARTIDOS QUE COFFIT YA PAGÓ Y FALTA MANDARLE (0119). No tienen
   * stock propio —están mezclados con los de la distribuidora—, así que se
   * muestran por lo que falta mandar (`cupoCafe`) y sin reparto por sucursal.
   */
  private async pendientesCompartidos() {
    /* Los candidatos: compartidos con alguna compra para Coffit o con stock
     * que se le cobró al marcarlos exclusivos (y después se desmarcaron). */
    const [conCompra, conMarca] = await Promise.all([
      this.db.selectDistinct({ id: comprobanteItems.productoId }).from(comprobanteItems)
        .innerJoin(productos, eq(productos.id, comprobanteItems.productoId))
        .where(and(eq(comprobanteItems.paraCafeteria, true), eq(productos.soloCafeteria, false))),
      this.db.selectDistinct({ id: coffitMovimientos.productoId }).from(coffitMovimientos)
        .innerJoin(productos, eq(productos.id, coffitMovimientos.productoId))
        .where(and(eq(coffitMovimientos.tipo, 'marca_exclusivo'), eq(coffitMovimientos.anulado, false), eq(productos.soloCafeteria, false))),
    ]);
    const candidatos = [...new Set([...conCompra, ...conMarca].map((f) => Number(f.id)))];
    if (!candidatos.length) return [];
    const cupo = await this.cupoCafe(this.db, candidatos);
    /* También el cupo NEGATIVO: se mandó como ya pagado y después se anuló la
     * compra. Queda a la vista hasta que la próxima compra para Coffit (o un
     * ajuste en la cuenta) lo cubra. */
    const ids = [...cupo].filter(([, v]) => Math.abs(v) > 1e-6).map(([k]) => k);
    if (!ids.length) return [];
    const ultima = await this.costoUltimaFactura(this.db, ids);
    const [prods, provs] = await Promise.all([
      this.db.select({
        id: productos.id, nombre: productos.nombre, tipo: productos.tipo, iva: productos.iva,
        codigoPropio: productos.codigoPropio,
      }).from(productos).where(inArray(productos.id, ids)),
      this.db.select().from(productoProveedores).where(inArray(productoProveedores.productoId, ids)),
    ]);
    return prods.map((p) => {
      const costoU = r2(ultima.get(p.id)
        ?? costoNetoEntry(formatoActivo(provs.filter((x) => x.productoId === p.id)) as any, p.iva));
      const total = r3(cupo.get(p.id) ?? 0);
      return {
        productoId: p.id, presentacionId: null, nombre: p.nombre, codigoPropio: p.codigoPropio || '',
        unidad: p.tipo === 'granel' ? 'kg' : 'u.', costoU,
        porSucursal: {} as Record<number, number>, total, valor: r2(total * costoU),
        /** Artículo que también vende la distribuidora: lo de Coffit es lo que falta mandar. */
        compartido: true,
        /** Se mandó como pagado más de lo que Coffit compró (compra anulada). */
        negativo: total < 0,
      };
    });
  }

  /* ==================================================================== *
   * LA CUENTA CORRIENTE CON COFFIT (0120) — ver `cuenta.ts`
   * ==================================================================== */

  /**
   * EL ESTADO DE CUENTA de un período: saldo anterior, cada renglón con su
   * saldo acumulado y el saldo final. Sin fechas, arranca el día después del
   * último cierre (o el 1 del mes si nunca se cerró) y llega a hoy.
   */
  async cuenta(q: { desde?: string; hasta?: string }) {
    const dia = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    const hoy = hoyAr();
    const cierre = await ultimoCierre(this.db);
    const desde = dia(q.desde) ?? (cierre ? sumarDias(cierre.hasta, 1) : `${hoy.slice(0, 8)}01`);
    const hasta = dia(q.hasta) ?? hoy;
    if (hasta < desde) throw new BadRequestException('La fecha «hasta» es anterior a «desde».');
    const [saldoAnterior, lineas, cierres] = await Promise.all([
      saldoAl(this.db, sumarDias(desde, -1)),
      lineasCuenta(this.db, inicioDia(desde), finDia(hasta)),
      this.db.select({
        id: coffitCierres.id, desde: coffitCierres.desde, hasta: coffitCierres.hasta,
        saldoAnterior: coffitCierres.saldoAnterior, saldoFinal: coffitCierres.saldoFinal,
        totales: coffitCierres.totales, observaciones: coffitCierres.observaciones,
        creadoEn: coffitCierres.creadoEn, usuario: usuarios.nombre, anulado: coffitCierres.anulado,
        motivoAnulacion: coffitCierres.motivoAnulacion,
      }).from(coffitCierres).leftJoin(usuarios, eq(usuarios.id, coffitCierres.usuarioId))
        .orderBy(desc(coffitCierres.hasta), desc(coffitCierres.id)).limit(36),
    ]);
    let s = saldoAnterior;
    const conSaldo = lineas.map((l) => ({ ...l, saldo: (s = r2(s + l.importe)) }));
    const saldoFinal = r2(s);
    return {
      desde, hasta, hoy, saldoAnterior, lineas: conSaldo, totales: totalesDeLineas(lineas), saldoFinal,
      saldoHoy: hasta >= hoy ? saldoFinal : await saldoAl(this.db, hoy),
      ultimoCierre: cierre ? { id: cierre.id, hasta: cierre.hasta, saldoFinal: cierre.saldoFinal } : null,
      cierres,
    };
  }

  /** Un pago, una compensación, un ajuste o el saldo inicial. */
  async crearMovimiento(dto: MovimientoCuentaDto, usuarioId?: number | null) {
    const descripcion = (dto.descripcion ?? '').trim();
    if (!descripcion) throw new BadRequestException('Escribí de qué es el movimiento.');
    const hoy = hoyAr();
    const dia = dto.fecha && /^\d{4}-\d{2}-\d{2}$/.test(dto.fecha) ? dto.fecha : hoy;
    if (dia > hoy) throw new BadRequestException('La fecha no puede ser futura.');
    /* Hoy lleva la hora real (ordena bien con lo demás del día); otro día, el mediodía. */
    const fecha = dia === hoy ? new Date() : new Date(`${dia}T12:00:00`);
    await exigirCuentaAbierta(this.db, fecha, 'registrar un movimiento con esa fecha');
    if (dto.tipo === 'saldo_inicial') {
      const [ya] = await this.db.select({ id: coffitMovimientos.id }).from(coffitMovimientos)
        .where(and(eq(coffitMovimientos.tipo, 'saldo_inicial'), eq(coffitMovimientos.anulado, false))).limit(1);
      if (ya) throw new BadRequestException('Ya hay un saldo inicial cargado: anulalo primero si hay que cambiarlo.');
    }
    const [m] = await this.db.insert(coffitMovimientos).values({
      fecha, tipo: dto.tipo, aFavor: dto.aFavor, importe: r2(dto.importe), descripcion,
      medio: (dto.medio ?? '').trim(), referencia: (dto.referencia ?? '').trim(), usuarioId: usuarioId ?? null,
    }).returning();
    return m;
  }

  async anularMovimiento(id: number, motivo: string, usuarioId?: number | null) {
    if (!motivo?.trim()) throw new BadRequestException('Escribí por qué se anula.');
    const [m] = await this.db.select().from(coffitMovimientos).where(eq(coffitMovimientos.id, id)).limit(1);
    if (!m) throw new NotFoundException('Movimiento inexistente.');
    if (m.anulado) throw new BadRequestException('Ya está anulado.');
    await exigirCuentaAbierta(this.db, m.fecha, 'anular un movimiento de un mes cerrado');
    await this.db.update(coffitMovimientos).set({
      anulado: true, motivoAnulacion: motivo.trim(), anuladoPor: usuarioId ?? null, anuladoEn: new Date(),
    }).where(and(eq(coffitMovimientos.id, id), eq(coffitMovimientos.anulado, false)));
    return { ok: true };
  }

  /**
   * EL CIERRE DEL MES: congela el saldo al último día del período y la foto de
   * los renglones que lo explican. Arranca el día siguiente al cierre anterior
   * (o el 1 del mes de `hasta` la primera vez, con todo lo anterior como saldo
   * anterior). Solo días que ya pasaron. `saldoEsperado` es el que se vio en
   * pantalla: si alguien cargó algo en el medio, no se cierra a ciegas.
   */
  async cerrarCuenta(dto: CerrarCuentaDto, usuarioId?: number | null) {
    const hasta = String(dto.hasta ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(hasta)) throw new BadRequestException('La fecha del cierre va como AAAA-MM-DD.');
    if (hasta >= hoyAr()) throw new BadRequestException('Solo se cierra hasta ayer: el día de hoy todavía puede tener movimientos.');
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('cafe:cierre'))`);
      const previo = await ultimoCierre(tx);
      if (previo && hasta <= previo.hasta) {
        throw new BadRequestException(`Ya está cerrado hasta el ${previo.hasta}: el próximo cierre tiene que ser posterior.`);
      }
      const desde = previo ? sumarDias(previo.hasta, 1) : `${hasta.slice(0, 8)}01`;
      const saldoAnterior = previo ? r2(Number(previo.saldoFinal)) : await saldoAl(tx, sumarDias(desde, -1));
      const lineas = await lineasCuenta(tx, inicioDia(desde), finDia(hasta));
      const totales = totalesDeLineas(lineas);
      const saldoFinal = r2(saldoAnterior + sumaTotales(totales));
      if (Math.abs(saldoFinal - Number(dto.saldoEsperado)) > 0.005) {
        throw new ConflictException(
          `El saldo cambió desde que abriste la pantalla (ahora da ${saldoFinal}). Actualizá, revisalo y volvé a cerrar.`,
        );
      }
      const [c] = await tx.insert(coffitCierres).values({
        desde, hasta, saldoAnterior, totales, saldoFinal, detalle: lineas,
        observaciones: (dto.observaciones ?? '').trim(), usuarioId: usuarioId ?? null,
      }).returning();
      return c;
    });
  }

  /** Solo el ÚLTIMO cierre se reabre: los anteriores ya son la base de este. */
  async reabrirCierre(id: number, motivo: string, usuarioId?: number | null) {
    if (!motivo?.trim()) throw new BadRequestException('Escribí por qué se reabre.');
    const c = await ultimoCierre(this.db);
    if (!c || c.id !== id) throw new BadRequestException('Solo se puede reabrir el último cierre.');
    await this.db.update(coffitCierres).set({
      anulado: true, motivoAnulacion: motivo.trim(), anuladoPor: usuarioId ?? null, anuladoEn: new Date(),
    }).where(and(eq(coffitCierres.id, id), eq(coffitCierres.anulado, false)));
    return { ok: true };
  }

  async verCierre(id: number) {
    const [c] = await this.db.select().from(coffitCierres).where(eq(coffitCierres.id, id)).limit(1);
    if (!c) throw new NotFoundException('Cierre inexistente.');
    return c;
  }

  /* ==================================================================== *
   * LAS COMPRAS Y LOS GASTOS DE COFFIT, EN DETALLE (29/9/2026)
   * ==================================================================== *
   * Pedido del dueño: ver qué se compró para el café, factura por factura y
   * artículo por artículo, y aparte los gastos. Los totales son los MISMOS
   * números que el resumen y Gerencia (`compradoDirecto` y `gastos`): mismas
   * condiciones, mismo signo por tipo de documento.
   */
  async comprasDelCafe(q: { desde?: string; hasta?: string }) {
    const desde = fechaLocal(q.desde);
    const hasta = fechaLocal(q.hasta);
    if (hasta) hasta.setHours(23, 59, 59, 999);
    const conds: any[] = [eq(comprobantes.estado, 'confirmado'), gt(comprobantes.netoCafeteria, 0),
      inArray(comprobantes.tipo, ['factura', 'liquidacion', 'nota_debito', 'nota_credito'])];
    const condsRemito: any[] = [eq(comprobantes.estado, 'confirmado'), eq(comprobantes.tipo, 'remito')];
    /* Por la fecha en que entran a la cuenta con Coffit (0120): la de la
     * factura, salvo que haya llegado después del cierre de su mes. */
    const fechaCuenta = sql`coalesce(${comprobantes.cuentaFecha}, ${comprobantes.fecha})`;
    if (desde) { conds.push(sql`${fechaCuenta} >= ${desde}`); condsRemito.push(gte(comprobantes.fecha, desde)); }
    if (hasta) { conds.push(sql`${fechaCuenta} <= ${hasta}`); condsRemito.push(lte(comprobantes.fecha, hasta)); }

    const cabecera = {
      id: comprobantes.id, tipo: comprobantes.tipo, letra: comprobantes.letra, puntoVenta: comprobantes.puntoVenta,
      numero: comprobantes.numero, fecha: comprobantes.fecha, proveedor: proveedores.nombre,
      sucursal: sucursales.nombre, subtotalNeto: comprobantes.subtotalNeto, total: comprobantes.total,
      netoCafeteria: comprobantes.netoCafeteria,
    };
    const [docs, remitos] = await Promise.all([
      this.db.select(cabecera).from(comprobantes)
        .innerJoin(proveedores, eq(proveedores.id, comprobantes.proveedorId))
        .leftJoin(sucursales, eq(sucursales.id, comprobantes.sucursalId))
        .where(and(...conds)).orderBy(desc(comprobantes.fecha), desc(comprobantes.id)).limit(2000),
      /* Los remitos todavía no tienen plata (llega con la factura): se listan
       * aparte para que se vea que la mercadería ya está, sin sumarlos. */
      this.db.select(cabecera).from(comprobantes)
        .innerJoin(proveedores, eq(proveedores.id, comprobantes.proveedorId))
        .leftJoin(sucursales, eq(sucursales.id, comprobantes.sucursalId))
        .where(and(...condsRemito, sql`exists (select 1 from ${comprobanteItems}
          where ${comprobanteItems.comprobanteId} = ${comprobantes.id} and ${comprobanteItems.paraCafeteria})`))
        .orderBy(desc(comprobantes.fecha), desc(comprobantes.id)).limit(500),
    ]);
    const ids = [...docs, ...remitos].map((d) => d.id);
    const items = ids.length
      ? await this.db.select({
        comprobanteId: comprobanteItems.comprobanteId, productoId: comprobanteItems.productoId,
        nombre: productos.nombre, codigoPropio: productos.codigoPropio, tipoProd: productos.tipo,
        tamKg: presentaciones.tamKg, cantidad: comprobanteItems.cantidad,
        costoUnitario: comprobanteItems.costoUnitario, descuento: comprobanteItems.descuento,
        subtotal: comprobanteItems.subtotal,
      }).from(comprobanteItems)
        .innerJoin(productos, eq(productos.id, comprobanteItems.productoId))
        .leftJoin(presentaciones, eq(presentaciones.id, comprobanteItems.presentacionId))
        .where(and(inArray(comprobanteItems.comprobanteId, ids), eq(comprobanteItems.paraCafeteria, true)))
        .orderBy(comprobanteItems.id)
      : [];
    const porDoc = new Map<number, any[]>();
    for (const it of items) {
      const arr = porDoc.get(it.comprobanteId) ?? [];
      arr.push(it);
      porDoc.set(it.comprobanteId, arr);
    }
    const unidadDe = (it: any) => (it.tamKg != null ? 'paq.' : (it.tipoProd === 'granel' ? 'kg' : 'u.'));
    /* La NC resta; el resto suma. Lo mismo que la cuenta (`cuenta.ts`). */
    const signoDe = (tipo: string) => (tipo === 'nota_credito' ? -1 : 1);
    const armar = (d: any, signo: number) => ({
      id: d.id, tipo: d.tipo, letra: d.letra, puntoVenta: d.puntoVenta, numero: d.numero, fecha: d.fecha,
      proveedor: d.proveedor, sucursal: d.sucursal ?? '',
      neto: r2(signo * Number(d.netoCafeteria)),
      subtotalNeto: r2(signo * Number(d.subtotalNeto)),
      /** Toda la factura es de Coffit: su parte es el neto entero. */
      todo: Math.abs(Number(d.netoCafeteria) - Number(d.subtotalNeto)) < 0.02,
      items: (porDoc.get(d.id) ?? []).map((it) => ({
        productoId: it.productoId, nombre: it.nombre, codigoPropio: it.codigoPropio || '',
        unidad: unidadDe(it), cantidad: r3(signo * Number(it.cantidad)),
        costoUnitario: r2(Number(it.costoUnitario)), descuento: Number(it.descuento) || 0,
        subtotal: r2(signo * Number(it.subtotal)),
      })),
    });
    const documentos = docs.map((d) => armar(d, signoDe(d.tipo)));

    /* Por artículo: cuánto se compró de cada cosa en el período. */
    const porArt = new Map<string, any>();
    for (const d of documentos) {
      for (const it of d.items) {
        const k = `${it.productoId}|${it.unidad}`;
        let a = porArt.get(k);
        if (!a) {
          a = { productoId: it.productoId, nombre: it.nombre, codigoPropio: it.codigoPropio, unidad: it.unidad, cantidad: 0, neto: 0, documentos: new Set<number>() };
          porArt.set(k, a);
        }
        a.cantidad += it.cantidad;
        a.neto += it.subtotal;
        a.documentos.add(d.id);
      }
    }
    const articulos = [...porArt.values()].map((a) => ({
      productoId: a.productoId, nombre: a.nombre, codigoPropio: a.codigoPropio, unidad: a.unidad,
      cantidad: r3(a.cantidad), neto: r2(a.neto),
      costoPromedio: Math.abs(a.cantidad) > 1e-9 ? r2(a.neto / a.cantidad) : 0,
      documentos: a.documentos.size,
    })).sort((x, y) => y.neto - x.neto);

    return {
      documentos,
      articulos,
      remitos: remitos.map((d) => armar(d, 1)),
      total: r2(documentos.reduce((a, d) => a + d.neto, 0)),
      facturas: documentos.filter((d) => d.tipo === 'factura' || d.tipo === 'liquidacion').length,
      limitado: docs.length >= 2000,
    };
  }

  async gastosDelCafe(q: { desde?: string; hasta?: string }) {
    const desde = fechaLocal(q.desde);
    const hasta = fechaLocal(q.hasta);
    if (hasta) hasta.setHours(23, 59, 59, 999);
    const conds: any[] = [eq(gastos.negocio, 'cafeteria'), ne(gastos.estado, 'anulado')];
    const fechaCuenta = sql`coalesce(${gastos.cuentaFecha}, ${gastos.fecha})`;
    if (desde) conds.push(sql`${fechaCuenta} >= ${desde}`);
    if (hasta) conds.push(sql`${fechaCuenta} <= ${hasta}`);
    const filas = await this.db.select({
      id: gastos.id, fecha: gastos.fecha, tipoDoc: gastos.tipoDoc, letra: gastos.letra, numero: gastos.numero,
      proveedor: proveedores.nombre, proveedorTexto: gastos.proveedorTexto, rubro: gastoCategorias.nombre,
      sucursal: sucursales.nombre, descripcion: gastos.descripcion, neto: gastos.neto, iva: gastos.iva,
      percDgi: gastos.percDgi, percDgr: gastos.percDgr,
      total: gastos.total, pagado: gastos.pagado, estado: gastos.estado,
    }).from(gastos)
      .innerJoin(gastoCategorias, eq(gastoCategorias.id, gastos.categoriaId))
      .leftJoin(proveedores, eq(proveedores.id, gastos.proveedorId))
      .leftJoin(sucursales, eq(sucursales.id, gastos.sucursalId))
      .where(and(...conds)).orderBy(desc(gastos.fecha), desc(gastos.id)).limit(2000);
    const renglones = filas.length
      ? await this.db.select({ gastoId: gastoItems.gastoId, concepto: gastoItems.concepto, monto: gastoItems.monto })
        .from(gastoItems).where(inArray(gastoItems.gastoId, filas.map((f) => f.id))).orderBy(gastoItems.id)
      : [];
    const porGasto = new Map<number, any[]>();
    for (const r of renglones) {
      const arr = porGasto.get(r.gastoId) ?? [];
      arr.push({ concepto: r.concepto, monto: r2(Number(r.monto)) });
      porGasto.set(r.gastoId, arr);
    }
    const lista = filas.map((f) => ({
      id: f.id, fecha: f.fecha, tipoDoc: f.tipoDoc, letra: f.letra, numero: f.numero,
      proveedor: f.proveedor || f.proveedorTexto || '', rubro: f.rubro, sucursal: f.sucursal ?? '',
      descripcion: f.descripcion, neto: r2(Number(f.neto)), iva: r2(Number(f.iva)),
      total: r2(Number(f.total)), pagado: r2(Number(f.pagado)), estado: f.estado,
      /** Lo que entra a la cuenta con Coffit: sin lo que recupera la empresa (0120). */
      paraCuenta: r2(Number(f.total) - Number(f.iva) - Number(f.percDgi) - Number(f.percDgr)),
      renglones: porGasto.get(f.id) ?? [],
    }));
    const rubros = new Map<string, { rubro: string; total: number; cantidad: number }>();
    for (const g of lista) {
      const r = rubros.get(g.rubro) ?? { rubro: g.rubro, total: 0, cantidad: 0 };
      r.total = r2(r.total + g.total);
      r.cantidad += 1;
      rubros.set(g.rubro, r);
    }
    return {
      gastos: lista,
      porRubro: [...rubros.values()].sort((a, b) => b.total - a.total),
      total: r2(lista.reduce((a, g) => a + g.total, 0)),
      /** La suma que entra a la cuenta corriente (= «gastos» del resumen). */
      totalCuenta: r2(lista.reduce((a, g) => a + g.paraCuenta, 0)),
      limitado: filas.length >= 2000,
    };
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

/** Ver `PERMISO_METRICAS_CAFE` en auth.guard: solo el superadmin. */
const PERMISO_METRICAS = PERMISO_METRICAS_CAFE;

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

  /* Resumen y Métrica: solo el superadmin (`PERMISO_METRICAS`). La pantalla
   * NO los pide si no tiene la llave — van en la misma carga que la lista de
   * envíos, y un 403 ahí tumbaba la pantalla entera. */
  @Get('resumen')
  @Permiso(PERMISO_METRICAS)
  resumen(@Query('desde') desde?: string, @Query('hasta') hasta?: string) {
    return this.svc.resumen({ desde, hasta });
  }

  /* ---- La cuenta corriente con Coffit (0120): plata, la llave de las métricas ---- */
  @Get('cuenta')
  @Permiso(PERMISO_METRICAS)
  cuenta(@Query('desde') desde?: string, @Query('hasta') hasta?: string) {
    return this.svc.cuenta({ desde, hasta });
  }

  @Post('cuenta/movimientos')
  @Permiso(PERMISO_METRICAS)
  crearMovimiento(@Body() dto: MovimientoCuentaDto, @Auth() sesion: Sesion) {
    return this.svc.crearMovimiento(dto, sesion?.usuarioId ?? null);
  }

  @Post('cuenta/movimientos/:id/anular')
  @Permiso(PERMISO_METRICAS)
  anularMovimiento(@Param('id', ParseIntPipe) id: number, @Body() dto: MotivoDto, @Auth() sesion: Sesion) {
    return this.svc.anularMovimiento(id, dto.motivo, sesion?.usuarioId ?? null);
  }

  @Post('cuenta/cierres')
  @Permiso(PERMISO_METRICAS)
  cerrarCuenta(@Body() dto: CerrarCuentaDto, @Auth() sesion: Sesion) {
    return this.svc.cerrarCuenta(dto, sesion?.usuarioId ?? null);
  }

  @Get('cuenta/cierres/:id')
  @Permiso(PERMISO_METRICAS)
  verCierre(@Param('id', ParseIntPipe) id: number) {
    return this.svc.verCierre(id);
  }

  @Post('cuenta/cierres/:id/reabrir')
  @Permiso(PERMISO_METRICAS)
  reabrirCierre(@Param('id', ParseIntPipe) id: number, @Body() dto: MotivoDto, @Auth() sesion: Sesion) {
    return this.svc.reabrirCierre(id, dto.motivo, sesion?.usuarioId ?? null);
  }

  /** El costo al que va a salir cada producto (última factura): la pantalla del envío. */
  @Get('costos-salida')
  @Permiso('almacen.cafeteria')
  costosSalida(@Query('ids') ids?: string) {
    return this.svc.costosSalida(String(ids ?? '').split(',').map((x) => Number(x)));
  }

  /* Compras y gastos de Coffit en detalle (29/9/2026): plata, misma llave que el resumen. */
  @Get('compras')
  @Permiso(PERMISO_METRICAS)
  compras(@Query('desde') desde?: string, @Query('hasta') hasta?: string) {
    return this.svc.comprasDelCafe({ desde, hasta });
  }

  @Get('gastos')
  @Permiso(PERMISO_METRICAS)
  gastosDelCafe(@Query('desde') desde?: string, @Query('hasta') hasta?: string) {
    return this.svc.gastosDelCafe({ desde, hasta });
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
    @Body() dto: EditarProductoCafeDto,
    @Auth() sesion: Sesion,
  ) {
    return this.svc.editarProductoDelCafe(id, dto, sesion?.usuarioId ?? null);
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
  async deposito(@Auth() sesion: Sesion) {
    const d = await this.svc.deposito();
    /* El detalle (qué hay, dónde y a cuánto) es operativo: con eso se pide. El
     * total en plata es una métrica y viaja solo al superadmin. */
    return veMetricasDelCafe(sesion?.permisos) ? d : { ...d, valor: null };
  }

  @Get('costos-entrada')
  @Permiso('almacen.cafeteria', 'almacen.cafeteria-entradas')
  costosEntrada() {
    return this.svc.costosEntrada();
  }

  @Get('metrica')
  @Permiso(PERMISO_METRICAS)
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
   * esa cabecera sigue valiendo la sesión del ERP, así que **hoy no rompe nada**
   * y el día que se coordine con coffit alcanza con cargarle el secreto.
   *
   * Por qué hacía falta: hasta acá coffit se autenticaba con un token de sesión
   * común de 12 h, o sea con usuario y contraseña de alguien del ERP guardados
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
   * el ERP, alguien tiene que poder verlo. La cafetería también los ve todos,
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
    return this.svc.pedidosPendientes(soloSuSucursal(sesion), sesion);
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
  @Post('pedidos/:id/anular') anularPedido(
    @Param('id', ParseIntPipe) id: number, @Body() dto: AnularPedidoDto, @Auth() sesion: Sesion,
  ) {
    return this.svc.anularPedido(id, dto, !tienePermiso(sesion.permisos ?? [], ['almacen.cafeteria']));
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

  /** Controlar y recibir (0113). Quién puede, lo decide `exigirReceptor`. */
  @Post('envios/:id/recibir')
  @Permiso('almacen.cafeteria', 'almacen.cafeteria-entradas')
  recibir(@Param('id', ParseIntPipe) id: number, @Body() dto: RecibirEnvioDto, @Auth() sesion: Sesion) {
    return this.svc.recibir(id, dto, sesion);
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
