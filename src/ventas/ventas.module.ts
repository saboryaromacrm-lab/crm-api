/**
 * VENTAS
 * ============================================================================
 * Comprobante de venta: tabla propia, numeración asignada por el sistema y
 * estado que no vuelve atrás (confirmada → anulada, nunca editada).
 *
 * El punto de venta trabaja con **borradores**: una venta puede quedar abierta
 * mientras el cliente va a buscar otra cosa, y el cajero sigue atendiendo. Un
 * borrador vive en esta misma tabla con `estado='borrador'`, y por eso:
 *   - NO consume numeración (el índice único de `numero` es parcial),
 *   - NO descuenta stock ni exige caja ni pagos,
 *   - SÍ se puede editar, delegar a otro vendedor y descartar.
 * Confirmar es el único momento en que la venta toca el inventario y la caja.
 *
 * Convención de importes: los precios son NETOS (sin IVA), igual que en los
 * comprobantes de compra. El IVA se suma aparte. Un solo criterio en todo el
 * sistema evita el clásico descuadre de centavos entre compras y ventas.
 */
import {
  Body, Controller, Delete, ForbiddenException, Get, Inject, Injectable, Module,
  BadRequestException, NotFoundException, Param, ParseIntPipe, Patch, Post, Put, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { and, desc, eq, gte, ilike, inArray, lte, ne, or, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  categorias, clientes, clienteListas, cobranzaImputaciones, cobranzas, descuentos, marcas,
  etiquetas, productoEtiquetas, productoListas, presentaciones, productoProveedores, productos,
  presupuestoItems, presupuestos, proveedores, roles, stock, sucursales, usuarios,
  listasVenta, ventaExtras, ventaItems, ventaPagos, ventas,
} from '../db/schema';
import { ALICUOTAS_IVA } from '../common/iva';
import { Auth, Permiso, Sesion } from '../auth/auth.decoradores';
import { esJefe, sucursalDeOperacion, tienePermiso } from '../auth/auth.guard';
import { ClientesModule, ClientesService } from '../clientes/clientes.module';
import { ConfiguracionModule, ConfiguracionService } from '../configuracion/configuracion.module';
import { CajaModule, CajaService } from '../caja/caja.module';
import { ListasModule, ListasService } from '../listas/listas.module';
import { OfertasModule, OfertasService } from '../ofertas/ofertas.module';
import { InventarioModule } from '../inventario/inventario.module';
import { InventarioService } from '../inventario/inventario.service';
import { costoNetoPresentacion, costoPrecioEntry, costosFormato, formatoActivo, precioVentaFila } from '../inventario/pricing';
import { ArcaModule, ArcaService } from '../arca/arca.module';
import { urlQrFiscal, codigoComprobante } from '../arca/qr';

const TIPOS = ['ticket', 'factura_a', 'factura_b', 'factura_c', 'nota_credito', 'nota_debito'] as const;
const MEDIOS = ['efectivo', 'transferencia', 'tarjeta_debito', 'tarjeta_credito', 'cheque', 'qr', 'otro'] as const;

/**
 * Las secciones del módulo Ventas, con las mismas claves del catálogo de
 * permisos (usuarios.module.ts). Sirven para los endpoints que no son de una
 * pantalla en particular sino del módulo entero — hoy el bootstrap.
 */
const SECCIONES_VENTAS = [
  'ventas.pos', 'ventas.listado', 'ventas.ordenes', 'ventas.presupuestos',
  'ventas.clientes', 'ventas.cobranzas', 'ventas.caja', 'ventas.listas',
  'ventas.ofertas', 'ventas.cambios', 'ventas.configuracion',
] as const;

/** Redondeo monetario a 2 decimales (evita el arrastre de flotantes). */
export const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** El precio de una oferta se carga CON IVA; las cuentas van en neto. */
const netoDe = (precioFinal: number, iva: number) => (Number(precioFinal) || 0) / (1 + (Number(iva) || 0) / 100);

/**
 * ¿ESTA OFERTA ALCANZA A ESTE RENGLÓN? Espejo de `alcanzaRenglon` del motor del
 * POS (`domain/ofertas.js`), del lado que manda.
 *
 * Faltaba por completo: el servidor comprobaba que la promo estuviera ACTIVA y
 * nada más, así que con cualquier oferta viva en el sistema se le colgaba su
 * descuento a un producto que no estaba en ella. Con un 3×2 de galletitas
 * activo, un renglón de aceite de $80.000 se cobraba $1.
 *
 * El paquete fraccionado es el caso fino y va igual que en el POS: lo alcanza su
 * propia `presentacion`, y las de la madre solo si la oferta lo dice
 * (`incluyeFraccionados`).
 */
function ofertaAlcanza(
  o: { alcances?: { tipo: string; refId: number }[]; incluyeFraccionados?: boolean; tipo?: string;
    componentes?: { productoId: number }[] },
  r: { productoId: number; presentacionId: number | null; marcaId: number | null;
    categoriaId: number | null; etiquetas: number[] },
): boolean {
  // El alcance del COMBO son sus componentes, no la tabla de alcances.
  if (o.tipo === 'combo') {
    return (o.componentes ?? []).some((c) => c.productoId === r.productoId);
  }
  const esPaquete = r.presentacionId != null;
  return (o.alcances ?? []).some((a) => {
    if (a.tipo === 'presentacion') return esPaquete && r.presentacionId === a.refId;
    if (esPaquete && !o.incluyeFraccionados) return false;
    switch (a.tipo) {
      case 'producto': return r.productoId === a.refId;
      case 'marca': return r.marcaId === a.refId;
      case 'categoria': return r.categoriaId === a.refId;
      case 'etiqueta': return (r.etiquetas ?? []).includes(a.refId);
      default: return false;
    }
  });
}

/**
 * LO MÁXIMO QUE ESTA MECÁNICA PUEDE DESCONTAR en un renglón. `null` = no se
 * puede acotar con lo que hay acá (el combo reparte su ahorro entre renglones de
 * productos distintos, así que su techo por renglón es el bruto).
 *
 * Antes solo se acotaban las de porcentaje; para `nxm`, `pack` y `precio_fijo`
 * el único límite era el 100% del renglón, o sea ninguno. Los tres techos de acá
 * son EXACTOS —salen de la misma cuenta que hace el motor del POS— y se miden
 * sobre el neto ya bonificado, que es donde el navegador también los mide.
 */
function techoDeOferta(
  o: { tipo: string; porcentaje?: number; precio?: number; lleva?: number; paga?: number },
  datos: { cantidad: number; precioUnitario: number; descuento: number; iva: number },
): number | null {
  const { cantidad: c, iva } = datos;
  const p = datos.precioUnitario * (1 - datos.descuento / 100);
  const lleva = Number(o.lleva) || 0;
  const paga = Number(o.paga) || 0;

  switch (o.tipo) {
    case 'porcentaje':
      return money(c * p * ((Number(o.porcentaje) || 0) / 100));
    case 'segunda_unidad':
      // Un par por cada dos unidades, y el descuento cae sobre la segunda.
      return money(Math.floor(c / 2) * p * ((Number(o.porcentaje) || 0) / 100));
    case 'nxm': {
      if (lleva < 2 || paga < 1 || paga >= lleva) return 0;
      return money(Math.floor(c / lleva) * (lleva - paga) * p);
    }
    case 'precio_fijo': {
      const pf = netoDe(Number(o.precio) || 0, iva);
      return pf >= p ? 0 : money(c * (p - pf));
    }
    case 'pack': {
      if (lleva < 2) return 0;
      const ahorro = lleva * p - netoDe(Number(o.precio) || 0, iva);
      return ahorro <= 0 ? 0 : money(Math.floor(c / lleva) * ahorro);
    }
    default:
      // 'ticket' y 'combo': el importe no se deriva de este renglón solo.
      return null;
  }
}

/**
 * LA FECHA DE UN DOCUMENTO DE MOSTRADOR. Es AHORA, salvo para un jefe.
 *
 * Un cajero podía emitir un ticket fechado dos meses atrás y colgarlo del turno
 * abierto de hoy: quedaba fuera de cualquier corte por fecha y adentro del
 * arqueo de hoy. El jefe sí necesita fechar distinto (carga diferida,
 * corrección), pero la fecha tiene que ser real: `new Date('chau')` es un
 * `Invalid Date` que llegaba crudo al insert y salía un 500 donde va un 400.
 *
 * Vive acá y exportada porque la venta y la COBRANZA son el mismo caso, y la
 * cobranza nació sin esta regla: se podía fechar un recibo en noviembre, la
 * plata entraba al turno de hoy y ningún corte del mes lo veía.
 */
export function fechaDeDocumento(pedida: string | undefined, esJefeSesion: boolean) {
  if (!pedida || !esJefeSesion) return new Date();
  const f = new Date(pedida);
  if (Number.isNaN(f.getTime())) throw new BadRequestException(`Fecha inválida: ${pedida}`);
  return f;
}

/* ---------------- Días de un filtro de fechas ----------------
 *
 * `new Date('2026-08-10')` es medianoche UTC = 21:00 del 9 en Argentina: un
 * filtro "de hoy a hoy" se comía las ventas de la mañana y sumaba las de
 * anoche. Con la hora explícita el string se interpreta en la zona del server,
 * que es la del negocio. Misma trampa que en los vencimientos de pago.
 */
const desdeDia = (s?: string) => (s ? new Date(`${s}T00:00:00`) : null);
const hastaDia = (s?: string) => (s ? new Date(`${s}T23:59:59.999`) : null);

/**
 * Tipo de comprobante que corresponde emitir. Depende de NUESTRA condición
 * fiscal y de la del cliente; con ARCA apagado siempre es ticket interno.
 */
export function tipoVentaPara(cliente: { condicionIva: string }, config: Record<string, any>) {
  if (!config.arcaHabilitado) return 'ticket';
  return letraFacturaPara(cliente, config);
}

/**
 * Letra que corresponde cuando se decide FACTURAR explícitamente (F7 en la
 * caja). A diferencia de `tipoVentaPara`, no mira `arcaHabilitado`: el cajero
 * pidió factura, así que se emite el comprobante fiscal igual — con ARCA
 * apagado sale sin CAE, que es exactamente la etapa en la que estamos.
 */
export function letraFacturaPara(cliente: { condicionIva: string }, config: Record<string, any>) {
  const empresa = config.condicionIvaEmpresa;
  if (empresa === 'monotributo' || empresa === 'exento') return 'factura_c';
  return cliente.condicionIva === 'responsable_inscripto' ? 'factura_a' : 'factura_b';
}

/* ------------------------------- DTOs ------------------------------- */

const ORIGENES_LISTA = ['base', 'cliente', 'auto', 'manual', 'marca', 'monto', 'presupuesto'] as const;

/**
 * Renglón YA pasado por `resolverRenglones`. El tipo es distinto del DTO a
 * propósito: `iva` no existe en lo que manda el cliente y sí existe acá, así que
 * el compilador impide calcular totales con renglones sin resolver.
 */
type RenglonResuelto = VentaItemDto & {
  iva: number;
  precioUnitario: number;
  precioLista: number;
  descuento: number;
  ofertaDescuento: number;
  /** Descuento con nombre que GANÓ en este renglón (null si no ganó ninguno). */
  descuentoId: number | null;
  descuentoNombre: string;
  /**
   * El que el renglón traía por su cuenta, antes del nombrado. Se guarda para
   * que reabrir el borrador no confunda un porcentaje autorizado con uno
   * tipeado a mano — ver el comentario de `descuentoBase` en el esquema.
   */
  descuentoBase: number;
  /** El costo congelado al resolver (0072) — ver el comentario en el esquema. */
  costoUnitario: number;
  ivaAbsorbidoUnitario: number;
  porcSinFactura: number;
};

/** Un descuento con nombre ya validado y listo para aplicar. */
type DescuentoResuelto = {
  id: number;
  nombre: string;
  porcentaje: number;
  listaId: number;
  medioPago: string | null;
};

/**
 * Lo que el CONTROLLER resolvió de la sesión y el body no puede decir.
 *
 * Está en un objeto aparte del DTO justamente para que se vea la frontera: todo
 * lo de acá lo decide el servidor mirando quién llamó, no lo que mandó.
 */
export interface OpcionesVenta {
  /**
   * DÓNDE SE GRABA la venta nueva: la sucursal de la sesión, o la pedida si
   * quien llama es un jefe (`sucursalDeOperacion`).
   */
  sucursalSesion?: number;
  /**
   * QUÉ SE PUEDE TOCAR de lo que ya existe. `undefined` = sin restricción (jefe);
   * un número = solo los documentos de esa sucursal.
   *
   * Son dos cosas distintas y por eso son dos campos: el jefe GRABA en la
   * sucursal que elige y además puede TOCAR la de cualquiera; el cajero hace las
   * dos cosas únicamente en la suya. Cuando esto era un solo campo, el jefe
   * quedaba encerrado en su propia sucursal para editar y anular.
   */
  soloSuSucursal?: number;
  /** Permiso `precio_manual`: pisar el precio, la lista y el tope de descuento. */
  puedePisarPrecio?: boolean;
  /** Rol admin/superadmin: puede fechar la venta y anular contra un turno cerrado. */
  esJefe?: boolean;
}

class VentaItemDto {
  @IsInt() productoId!: number;
  @IsOptional() @IsInt() presentacionId?: number;
  /* Con techo: `1e12` unidades no es un error de tipeo del cajero, y sin `@Max`
   * el subtotal se va a Infinity y contamina cualquier suma que lo incluya. */
  @IsNumber() @Min(0) @Max(1_000_000) cantidad!: number;
  @IsOptional() @IsInt() listaId?: number;
  @IsOptional() @IsString() lista?: string;
  @IsOptional() @IsIn(ORIGENES_LISTA as unknown as string[]) listaOrigen?: string;
  @IsOptional() @IsNumber() @Min(0) precioLista?: number;
  @IsOptional() @IsNumber() @Min(0) precioUnitario?: number;
  /** PORCENTAJE. El tope del vendedor lo pone la configuración; 100 es el techo físico. */
  @IsOptional() @IsNumber() @Min(0) @Max(100) descuento?: number;
  /** Oferta aplicada por el motor del POS: referencia + nombre + importe neto. */
  @IsOptional() @IsInt() ofertaId?: number;
  @IsOptional() @IsString() oferta?: string;
  @IsOptional() @IsNumber() @Min(0) ofertaDescuento?: number;
  /*
   * `iva` NO está acá: la alícuota es del PRODUCTO y la pone el servidor (ver
   * `resolverRenglones`). Cuando la elegía el cliente, un `iva: -200` daba un
   * total negativo y una venta en cuenta corriente le BAJABA la deuda al cliente
   * — invisible en Cobranzas, que solo lista saldos positivos.
   */
}

class VentaExtraDto {
  @IsString() @MaxLength(120) concepto!: string;
  @IsNumber() @Min(0) @Max(100_000_000) importe!: number;
  /* Acá sí la elige el cargador —un flete no es un producto del catálogo— pero
   * solo entre las alícuotas que existen en la ley. */
  @IsOptional() @IsIn(ALICUOTAS_IVA as unknown as number[]) iva?: number;
}

class VentaPagoDto {
  @IsIn(MEDIOS as unknown as string[]) medio!: (typeof MEDIOS)[number];
  @IsNumber() @Min(0) @Max(100_000_000) importe!: number;
  @IsOptional() @IsString() @MaxLength(120) referencia?: string;
}

export class CreateVentaDto {
  @IsOptional() @IsInt() clienteId?: number;
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsInt() usuarioId?: number;
  @IsOptional() @IsInt() cajaSesionId?: number;
  @IsOptional() @IsIn(TIPOS as unknown as string[]) tipo?: (typeof TIPOS)[number];
  /** 'borrador' deja la venta abierta en el punto de venta. */
  @IsOptional() @IsIn(['borrador', 'confirmada']) estado?: 'borrador' | 'confirmada';
  @IsOptional() @IsIn(['contado', 'cuenta_corriente']) condicionPago?: 'contado' | 'cuenta_corriente';
  @IsOptional() @IsString() fecha?: string;
  @IsOptional() @IsString() listaPrecio?: string;
  @IsOptional() @IsString() observaciones?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => VentaItemDto)
  items?: VentaItemDto[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => VentaExtraDto)
  extras?: VentaExtraDto[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => VentaPagoDto)
  pagos?: VentaPagoDto[];
  /** Venta que nace de (o cierra) un presupuesto confirmado. */
  @IsOptional() @IsInt() presupuestoId?: number;
  /**
   * DESCUENTOS CON NOMBRE aplicados al ticket, por ID. Nunca porcentajes.
   *
   * Es la misma frontera que ya rige para el precio y la lista: el cliente dice
   * CUÁL, el servidor dice CUÁNTO. Un `porcentaje` que llegara por acá sería
   * exactamente el agujero que se cerró en Ventas — se lee de la tabla, se
   * valida vigencia, sucursal, lista y permiso, y recién ahí se aplica.
   *
   * Uno por lista: dos de la misma lista competirían por los mismos renglones.
   */
  @IsOptional() @IsArray() @IsInt({ each: true }) descuentos?: number[];
}

class ConfirmarVentaDto {
  /**
   * Cómo se cierra: 'ticket' = liquidar (comprobante interno), 'factura' =
   * facturar (la letra la resuelve el backend según las dos condiciones de
   * IVA). Si no viene, se respeta el tipo con el que nació el borrador.
   */
  @IsOptional() @IsIn(['ticket', 'factura']) tipo?: 'ticket' | 'factura';
  @IsOptional() @IsIn(['contado', 'cuenta_corriente']) condicionPago?: 'contado' | 'cuenta_corriente';
  @IsOptional() @IsInt() cajaSesionId?: number;
  @IsOptional() @IsInt() usuarioId?: number;
  @IsOptional() @IsString() observaciones?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => VentaPagoDto)
  pagos?: VentaPagoDto[];
}

/*
 * DELEGAR ES EL CASO EN QUE EL id NO ES EL PROPIO: se le pasa el borrador a
 * otro vendedor. Por eso el campo se llama `paraUsuarioId` y no `usuarioId` —
 * si se llamara igual que el autor, el interceptor que pone el autor del lado
 * del servidor lo pisaria y delegar terminaria delegandose a uno mismo.
 */
class DelegarVentaDto {
  @IsInt() paraUsuarioId!: number;
}

/**
 * ANULAR PIDE MOTIVO, y es obligatorio a propósito: es lo único que distingue
 * una devolución legítima de un faltante tapado. Queda en `anuladoMotivo` (0059)
 * junto a quién y cuándo.
 */
class AnularVentaDto {
  @IsString() @MaxLength(300) motivo!: string;
}

/**
 * Filtros del listado de ventas. Van por query string (es una LECTURA: se
 * comparte por link y se recarga), así que llegan como texto y se normalizan
 * en el controlador.
 */
type ListadoVentasQ = {
  desde?: string; hasta?: string;
  sucursalId?: number; usuarioId?: number; clienteId?: number; cajaSesionId?: number;
  estado?: string; medioPago?: string; origen?: string;
  conOferta?: boolean; sinFacturar?: boolean; q?: string;
  offset?: number; limit?: number;
};

@Injectable()
export class VentasService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly inv: InventarioService,
    private readonly cfg: ConfiguracionService,
    private readonly cli: ClientesService,
    private readonly caja: CajaService,
    private readonly listas: ListasService,
    private readonly ofertas: OfertasService,
    private readonly arca: ArcaService,
  ) {}

  /* ------------------------------ Lectura ------------------------------ */

  /**
   * Importe ya cobrado de cada venta (solo cobranzas confirmadas). Se resuelve
   * en UNA consulta agrupada en vez de una por documento.
   */
  private async imputadoPorVenta(ventaIds: number[]) {
    const mapa = new Map<number, number>();
    if (!ventaIds.length) return mapa;
    const filas = await this.db
      .select({
        ventaId: cobranzaImputaciones.ventaId,
        importe: sql<number>`coalesce(sum(${cobranzaImputaciones.importe}), 0)`,
      })
      .from(cobranzaImputaciones)
      .innerJoin(cobranzas, eq(cobranzas.id, cobranzaImputaciones.cobranzaId))
      .where(and(eq(cobranzas.estado, 'confirmada'), inArray(cobranzaImputaciones.ventaId, ventaIds)))
      .groupBy(cobranzaImputaciones.ventaId);
    for (const f of filas) mapa.set(f.ventaId, Number(f.importe) || 0);
    return mapa;
  }

  async list(q: {
    clienteId?: number; sucursalId?: number; estado?: string;
    desde?: string; hasta?: string; limit?: number; incluirItems?: boolean;
  }) {
    const conds: any[] = [];
    if (q.clienteId) conds.push(eq(ventas.clienteId, Number(q.clienteId)));
    if (q.sucursalId) conds.push(eq(ventas.sucursalId, Number(q.sucursalId)));
    if (q.estado) conds.push(eq(ventas.estado, q.estado as any));
    const d = desdeDia(q.desde); if (d) conds.push(gte(ventas.fecha, d));
    const h = hastaDia(q.hasta); if (h) conds.push(lte(ventas.fecha, h));

    // Límite por defecto: el listado nunca trae la tabla entera.
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    const rows = await this.db.select().from(ventas)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(ventas.id))
      .limit(limit);
    if (!rows.length) return [];

    const ids = rows.map((v) => v.id);
    const imput = await this.imputadoPorVenta(ids);

    // Los ítems se piden solo si el llamador los necesita (la lista de ventas
    // abiertas los usa para mostrar el último producto cargado); una consulta
    // para todo el lote, no una por venta.
    const items = q.incluirItems
      ? await this.db.select().from(ventaItems).where(inArray(ventaItems.ventaId, ids))
      : null;

    return rows.map((v) => {
      const cobrado = imput.get(v.id) ?? 0;
      const base = { ...v, cobrado, saldo: money(v.total - cobrado) };
      return items ? { ...base, items: items.filter((i) => i.ventaId === v.id) } : base;
    });
  }

  /**
   * EL LISTADO DE VENTAS — la pregunta "¿qué se vendió?" con todos sus cortes.
   *
   * Tres cosas lo separan de `list()`, que es el primitivo que usan el POS y la
   * ficha del cliente:
   *
   *   1. PAGINADO DE VERDAD (`offset` + `total`): la tabla de ventas crece para
   *      siempre y una pantalla no puede depender de un `limit` que corta en
   *      silencio.
   *   2. Viene RESUELTA: nombres de cliente, cajero y sucursal, medios de pago,
   *      renglones y lo que descontó cada promo. Sin eso la pantalla tendría
   *      que pedir una consulta por fila.
   *   3. TOTALES DEL FILTRO ENTERO, no de la página: "vendí $X hoy" tiene que
   *      sumar las 300 ventas del día, no las 25 que se están viendo. Y suman
   *      SOLO las no anuladas — una anulada figura en la lista (hay que poder
   *      auditarla) pero no es plata que entró.
   *
   * El BORRADOR no es una venta: si no se pide un estado puntual, queda afuera
   * (los tickets abiertos viven en el Punto de venta, que es donde se retoman).
   */
  private condicionesListado(q: ListadoVentasQ) {
    const conds: any[] = [];
    if (q.sucursalId) conds.push(eq(ventas.sucursalId, Number(q.sucursalId)));
    if (q.usuarioId) conds.push(eq(ventas.usuarioId, Number(q.usuarioId)));
    if (q.clienteId) conds.push(eq(ventas.clienteId, Number(q.clienteId)));
    if (q.cajaSesionId) conds.push(eq(ventas.cajaSesionId, Number(q.cajaSesionId)));
    if (q.estado) conds.push(eq(ventas.estado, q.estado as any));
    else conds.push(ne(ventas.estado, 'borrador'));
    const d = desdeDia(q.desde); if (d) conds.push(gte(ventas.fecha, d));
    const h = hastaDia(q.hasta); if (h) conds.push(lte(ventas.fecha, h));
    /* Origen: la venta de mostrador nace sin presupuesto detrás. La que viene
     * de un pedido (mayorista cotizado o del sitio web) tiene `presupuestoId`,
     * y NO la hizo el cajero en la caja. */
    if (q.origen === 'pos') conds.push(sql`${ventas.presupuestoId} is null`);
    if (q.origen === 'presupuesto') conds.push(sql`${ventas.presupuestoId} is not null`);
    if (q.medioPago) {
      conds.push(sql`exists (select 1 from venta_pagos vp where vp.venta_id = ${ventas.id} and vp.medio = ${q.medioPago})`);
    }
    if (q.conOferta) {
      conds.push(sql`exists (select 1 from venta_items vi where vi.venta_id = ${ventas.id} and vi.oferta_id is not null)`);
    }
    // La pestaña "Sin facturar" (0073): tickets provisorios esperando ARCA.
    if (q.sinFacturar) conds.push(eq(ventas.facturarPendiente, true));
    if (q.q) {
      // Un número de ticket o un pedazo del nombre del cliente: lo que uno
      // tiene a mano cuando alguien vuelve con una bolsa y un papel.
      const t = q.q.trim();
      const digitos = t.replace(/\D/g, '');
      const ors: any[] = [ilike(clientes.nombre, `%${t}%`)];
      if (digitos) ors.push(eq(ventas.numero, Number(digitos)));
      conds.push(or(...ors));
    }
    return conds;
  }

  async listado(q: ListadoVentasQ) {
    const conds = this.condicionesListado(q);
    const donde = and(...conds);
    const limit = Math.min(Math.max(Number(q.limit) || 25, 1), 200);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const vivas = and(...conds, ne(ventas.estado, 'anulada'));

    const [filas, [tot], porMedio, [ofe]] = await Promise.all([
      this.db.select({
        v: ventas,
        clienteNombre: clientes.nombre,
        sucursalNombre: sucursales.nombre,
        cajeroNombre: usuarios.nombre,
      }).from(ventas)
        .innerJoin(clientes, eq(clientes.id, ventas.clienteId))
        .leftJoin(sucursales, eq(sucursales.id, ventas.sucursalId))
        .leftJoin(usuarios, eq(usuarios.id, ventas.usuarioId))
        .where(donde)
        .orderBy(desc(ventas.fecha), desc(ventas.id))
        .limit(limit).offset(offset),

      this.db.select({
        registros: sql<number>`count(*)::int`,
        anuladas: sql<number>`count(*) filter (where ${ventas.estado} = 'anulada')::int`,
        tickets: sql<number>`count(*) filter (where ${ventas.estado} <> 'anulada')::int`,
        plata: sql<number>`coalesce(sum(${ventas.total}) filter (where ${ventas.estado} <> 'anulada'), 0)`,
        neto: sql<number>`coalesce(sum(${ventas.subtotalNeto}) filter (where ${ventas.estado} <> 'anulada'), 0)`,
        iva: sql<number>`coalesce(sum(${ventas.ivaTotal}) filter (where ${ventas.estado} <> 'anulada'), 0)`,
        descuentos: sql<number>`coalesce(sum(${ventas.descuentoTotal}) filter (where ${ventas.estado} <> 'anulada'), 0)`,
        plataAnulada: sql<number>`coalesce(sum(${ventas.total}) filter (where ${ventas.estado} = 'anulada'), 0)`,
        // Tickets provisorios esperando ARCA, DEL FILTRO: alimenta la pestaña.
        sinFacturar: sql<number>`count(*) filter (where ${ventas.facturarPendiente} and ${ventas.estado} <> 'anulada')::int`,
      }).from(ventas)
        .innerJoin(clientes, eq(clientes.id, ventas.clienteId))
        .where(donde),

      this.db.select({
        medio: ventaPagos.medio,
        importe: sql<number>`coalesce(sum(${ventaPagos.importe}), 0)`,
      }).from(ventaPagos)
        .innerJoin(ventas, eq(ventas.id, ventaPagos.ventaId))
        .innerJoin(clientes, eq(clientes.id, ventas.clienteId))
        .where(vivas)
        .groupBy(ventaPagos.medio),

      this.db.select({
        plata: sql<number>`coalesce(sum(${ventaItems.ofertaDescuento}), 0)`,
        ventas: sql<number>`count(distinct ${ventaItems.ventaId}) filter (where ${ventaItems.ofertaId} is not null)::int`,
      }).from(ventaItems)
        .innerJoin(ventas, eq(ventas.id, ventaItems.ventaId))
        .innerJoin(clientes, eq(clientes.id, ventas.clienteId))
        .where(vivas),
    ]);

    const ids = filas.map((f) => f.v.id);
    const [pagos, agg, imput] = ids.length
      ? await Promise.all([
        this.db.select().from(ventaPagos).where(inArray(ventaPagos.ventaId, ids)),
        this.db.select({
          ventaId: ventaItems.ventaId,
          renglones: sql<number>`count(*)::int`,
          unidades: sql<number>`coalesce(sum(${ventaItems.cantidad}), 0)`,
          ofertaDescuento: sql<number>`coalesce(sum(${ventaItems.ofertaDescuento}), 0)`,
          // Los nombres CONGELADOS al vender: el ticket viejo dice qué promo se
          // le aplicó aunque hoy esa oferta ya no exista.
          ofertas: sql<string[]>`array_remove(array_agg(distinct nullif(${ventaItems.oferta}, '')), null)`,
          listas: sql<string[]>`array_remove(array_agg(distinct nullif(${ventaItems.lista}, '')), null)`,
        }).from(ventaItems).where(inArray(ventaItems.ventaId, ids)).groupBy(ventaItems.ventaId),
        this.imputadoPorVenta(ids),
      ])
      : [[], [], new Map<number, number>()];

    const registros = Number(tot?.registros) || 0;
    const tickets = Number(tot?.tickets) || 0;
    const plata = money(Number(tot?.plata));
    return {
      filas: filas.map(({ v, clienteNombre, sucursalNombre, cajeroNombre }) => {
        const a = agg.find((x: any) => x.ventaId === v.id);
        const cobrado = imput.get(v.id) ?? 0;
        return {
          ...v,
          clienteNombre,
          sucursalNombre: sucursalNombre ?? '—',
          cajeroNombre: cajeroNombre ?? '—',
          cobrado,
          saldo: money(v.total - cobrado),
          medios: pagos.filter((p: any) => p.ventaId === v.id).map((p: any) => ({ medio: p.medio, importe: p.importe })),
          renglones: Number(a?.renglones) || 0,
          unidades: money(Number(a?.unidades)),
          ofertaDescuento: money(Number(a?.ofertaDescuento)),
          ofertas: a?.ofertas ?? [],
          listas: a?.listas ?? [],
          /** De mostrador o nacida de un pedido: la pantalla lo distingue. */
          origen: v.presupuestoId ? 'presupuesto' : 'pos',
        };
      }),
      // `total` es de lo que MATCHEA (incluidas las anuladas): es el universo
      // que el paginado recorre.
      total: registros,
      paginado: { offset, limit },
      totales: {
        registros,
        tickets,
        anuladas: Number(tot?.anuladas) || 0,
        plata,
        neto: money(Number(tot?.neto)),
        iva: money(Number(tot?.iva)),
        descuentos: money(Number(tot?.descuentos)),
        plataAnulada: money(Number(tot?.plataAnulada)),
        promedio: tickets ? money(plata / tickets) : 0,
        sinFacturar: Number(tot?.sinFacturar) || 0,
        ofertas: { plata: money(Number(ofe?.plata)), ventas: Number(ofe?.ventas) || 0 },
        porMedio: porMedio.map((m) => ({ medio: m.medio, importe: money(Number(m.importe)) })),
      },
    };
  }

  async get(id: number) {
    const [v] = await this.db.select().from(ventas).where(eq(ventas.id, id)).limit(1);
    if (!v) throw new NotFoundException('Venta inexistente.');
    const [items, extras, pagos, imput] = await Promise.all([
      this.db.select().from(ventaItems).where(eq(ventaItems.ventaId, id)).orderBy(ventaItems.id),
      this.db.select().from(ventaExtras).where(eq(ventaExtras.ventaId, id)).orderBy(ventaExtras.id),
      this.db.select().from(ventaPagos).where(eq(ventaPagos.ventaId, id)),
      this.imputadoPorVenta([id]),
    ]);
    const cobrado = imput.get(id) ?? 0;

    /*
     * Los NOMBRES, que hasta acá no venían: el ticket se reimprime desde el
     * listado y desde el POS, y sin esto salía "#12" en lugar del producto y
     * sin el nombre del cliente. El nombre del producto NO está congelado en el
     * renglón (a diferencia de la lista y la oferta), así que se resuelve al
     * leer: si alguien renombró el producto, el ticket reimpreso dice el nombre
     * de hoy — que es el que el cliente reconoce en la góndola.
     */
    const prodIds = [...new Set(items.map((i) => i.productoId))];
    const presIds = [...new Set(items.map((i) => i.presentacionId).filter(Boolean) as number[])];
    const prods = new Map<number, { nombre: string; tipo: string }>();
    const tamDe = new Map<number, number>();
    if (prodIds.length) {
      const filas = await this.db.select({ id: productos.id, nombre: productos.nombre, tipo: productos.tipo })
        .from(productos).where(inArray(productos.id, prodIds));
      for (const p of filas) prods.set(p.id, { nombre: p.nombre, tipo: p.tipo });
    }
    if (presIds.length) {
      const filas = await this.db.select({ id: presentaciones.id, tamKg: presentaciones.tamKg })
        .from(presentaciones).where(inArray(presentaciones.id, presIds));
      for (const p of filas) tamDe.set(p.id, p.tamKg);
    }
    /* Los datos FISCALES del cliente, no solo el nombre: una factura impresa
     * los lleva por ley (documento, condición frente al IVA y domicilio), y el
     * QR de la RG 4892 necesita tipo y número de documento. */
    const [cli] = await this.db.select({
      nombre: clientes.nombre,
      tipoDoc: clientes.tipoDoc,
      numeroDoc: clientes.numeroDoc,
      condicionIva: clientes.condicionIva,
      direccion: clientes.direccion,
      localidad: clientes.localidad,
    }).from(clientes).where(eq(clientes.id, v.clienteId)).limit(1);
    const [suc] = v.sucursalId
      ? await this.db.select({ nombre: sucursales.nombre })
        .from(sucursales).where(eq(sucursales.id, v.sucursalId)).limit(1)
      : [];
    const [usr] = v.usuarioId
      ? await this.db.select({ nombre: usuarios.nombre })
        .from(usuarios).where(eq(usuarios.id, v.usuarioId)).limit(1)
      : [];
    const tam = (kg: number) => (kg < 1 ? `${Math.round(kg * 1000)} g` : `${kg} kg`);

    return {
      ...v,
      clienteNombre: cli?.nombre ?? '—',
      cliente: cli ?? null,
      /* El QR de la RG 4892, ya armado. Lo calcula la API porque acá viven la
       * tabla de códigos y el CUIT del certificado; el navegador solo lo
       * dibuja. `null` = este comprobante no lleva QR (ticket interno, o sin
       * CAE todavía). */
      qrArca: urlQrFiscal({
        tipo: v.tipo, puntoVenta: v.puntoVenta, numero: v.numero,
        fecha: v.fecha, total: v.total, cae: v.cae,
        receptor: cli ? { tipoDoc: cli.tipoDoc, numeroDoc: cli.numeroDoc } : null,
      }),
      codigoComprobante: codigoComprobante(v.tipo),
      sucursalNombre: suc?.nombre ?? '—',
      cajeroNombre: usr?.nombre ?? '—',
      items: items.map((it) => {
        const p = prods.get(it.productoId);
        const kg = it.presentacionId ? tamDe.get(it.presentacionId) : undefined;
        const base = p?.nombre ?? `#${it.productoId}`;
        return {
          ...it,
          nombre: kg !== undefined ? `${base} · ${tam(kg)}` : base,
          unidad: kg !== undefined ? 'paq.' : (p?.tipo === 'granel' ? 'kg' : 'u.'),
        };
      }),
      extras,
      pagos,
      cobrado,
      saldo: money(v.total - cobrado),
    };
  }

  /**
   * Cuenta corriente del cliente: saldo global + los comprobantes que todavía
   * deben algo. Es lo que consume la pantalla de cobranzas para imputar.
   */
  async cuenta(clienteId: number) {
    const cliente = await this.cli.get(clienteId);

    const pendientes = await this.db.select().from(ventas)
      .where(and(
        eq(ventas.clienteId, clienteId),
        eq(ventas.estado, 'confirmada'),
        eq(ventas.condicionPago, 'cuenta_corriente'),
      ))
      .orderBy(ventas.fecha, ventas.id);

    const imput = await this.imputadoPorVenta(pendientes.map((v) => v.id));

    const comprobantes = pendientes.map((v) => {
      const cobrado = imput.get(v.id) ?? 0;
      return { ...v, cobrado, saldo: money(v.total - cobrado) };
    });

    // El saldo global incluye lo cobrado "a cuenta" (no imputado a un documento),
    // por eso se calcula sobre los totales y no sumando los saldos de arriba.
    const [agg] = await this.db
      .select({ t: sql<number>`coalesce(sum(${cobranzas.total}), 0)` })
      .from(cobranzas)
      .where(and(eq(cobranzas.clienteId, clienteId), eq(cobranzas.estado, 'confirmada')));

    const facturado = pendientes.reduce((a, v) => a + v.total, 0);
    const cobradoTotal = Number(agg?.t) || 0;
    const saldo = money(facturado - cobradoTotal);
    const disponible = cliente.limiteCredito > 0 ? money(cliente.limiteCredito - saldo) : null;

    return {
      clienteId,
      saldo,
      facturado: money(facturado),
      cobrado: money(cobradoTotal),
      limiteCredito: cliente.limiteCredito,
      disponible,
      comprobantes: comprobantes.filter((c) => c.saldo > 0.009),
    };
  }

  /* ------------------------------ Catálogo POS ------------------------------ */

  /**
   * Todo lo VENDIBLE, con precios y stock ya resueltos.
   *
   * Devuelve una fila por cosa que se puede tipear en la caja: el producto
   * entero, el granel suelto (por kg) y cada presentación fraccionada. El punto
   * de venta lo pide UNA vez al abrir y busca en memoria — a 200 tickets por
   * día no se puede pagar un viaje a la API por tecla.
   *
   * Cada fila trae el stock de la sucursal (`stock`), el de todas
   * (`stockSucursales`) y su FORMATO DE VENTA: el precio en cada lista que el
   * producto tenga cargada, con el mínimo de unidades que la habilita
   * (`precios: [{listaId, precio, unidadesMinimas}]`).
   *
   * La condición viaja con el ARTÍCULO, no con la lista: la misma "Mayorista 1"
   * puede pedir 12 unidades en un producto y ninguna en otro. Lo que viaja una
   * sola vez en `listas` es la identidad (modalidad, número, nombre, orden),
   * que sí es común — repetirla por artículo multiplicaría la respuesta sin
   * aportar nada. El frontend cruza por `listaId`.
   *
   * Se arma con 7 consultas y se cruza en memoria; no hay N+1.
   */
  async catalogo(sucursalId: number) {
    const [prods, provs, formatos, cat, press, existencias, sucs, cfg, ms, cs, etiqs, ofs, etiqCat, provCat] = await Promise.all([
      /* Sin los ARCHIVADOS: fuera de catálogo es fuera de la caja. El
       * DISCONTINUADO sí viaja — dejó de comprarse, pero lo que hay en góndola
       * se vende hasta agotar (para eso son dos estados y no un interruptor). */
      this.db.select().from(productos)
        .where(ne(productos.estado, 'archivado')).orderBy(productos.nombre),
      this.db.select().from(productoProveedores),
      this.db.select().from(productoListas),
      this.listas.catalogo(),
      this.db.select().from(presentaciones),
      this.db.select().from(stock).where(eq(stock.estado, 'disponible')),
      this.db.select().from(sucursales).orderBy(sucursales.nombre),
      this.cfg.get('ventas'),
      this.db.select({ id: marcas.id, nombre: marcas.nombre }).from(marcas),
      this.db.select({ id: categorias.id, nombre: categorias.nombre }).from(categorias),
      this.db.select().from(productoEtiquetas),
      this.ofertas.activas(),
      this.db.select({ id: etiquetas.id, nombre: etiquetas.nombre }).from(etiquetas),
      this.db.select({ id: proveedores.id, nombre: proveedores.nombre }).from(proveedores).orderBy(proveedores.nombre),
    ]);
    // Proveedores por producto: es lo que permite filtrar la consulta de
    // existencias por proveedor (un producto puede venir de varios).
    const proveedoresDe = new Map<number, number[]>();
    for (const f of provs) {
      const arr = proveedoresDe.get(f.productoId);
      if (arr) { if (!arr.includes(f.proveedorId)) arr.push(f.proveedorId); }
      else proveedoresDe.set(f.productoId, [f.proveedorId]);
    }
    // Etiquetas por producto: el motor de ofertas matchea el alcance por id.
    const etiquetasDe = new Map<number, number[]>();
    for (const e of etiqs) {
      const arr = etiquetasDe.get(e.productoId);
      if (arr) arr.push(e.etiquetaId); else etiquetasDe.set(e.productoId, [e.etiquetaId]);
    }
    // Nombres resueltos una vez: los filtros de la búsqueda masiva los muestran
    // y el motor de listas compara por id, así que viajan los dos.
    const nombreMarca = new Map(ms.map((m) => [m.id, m.nombre]));
    const nombreCategoria = new Map(cs.map((c) => [c.id, c.nombre]));
    const redondeo = cfg.redondeoPrecio;
    const activas = cat.listas.filter((l: any) => l.activa);
    const porLista = new Map<number, any>(activas.map((l: any) => [l.id, l]));
    const listaBase = activas.find((l: any) => l.id === cfg.listaBaseId) || activas[0] || null;

    const costoPorProd = new Map<number, number>();
    for (const p of prods) {
      const suyos = provs.filter((x) => x.productoId === p.id);
      // La BASE del precio (0072): la parte sin factura entra sin el IVA que
      // el negocio absorbe. El costo real no viaja al POS — acá se cotiza.
      costoPorProd.set(p.id, costoPrecioEntry(formatoActivo(suyos), p.iva));
    }

    /** Stock por (producto, presentación, sucursal); presentación `null` = suelto. */
    const clave = (prodId: number, presId: number | null, sucId: number) => `${prodId}:${presId ?? ''}:${sucId}`;
    const stockDe = new Map<string, number>();
    for (const e of existencias) {
      const k = clave(e.productoId, e.presentacionId, e.sucursalId);
      stockDe.set(k, (stockDe.get(k) ?? 0) + e.cantidad);
    }
    const desglose = (prodId: number, presId: number | null) =>
      sucs.map((su) => ({
        sucursalId: su.id,
        nombre: su.nombre,
        cantidad: money(stockDe.get(clave(prodId, presId, su.id)) ?? 0),
      }));

    const items: any[] = [];
    for (const p of prods) {
      const costoNeto = costoPorProd.get(p.id) ?? 0;
      // El redondeo del producto pisa al de configuración — mismo criterio que
      // la ficha y el historial: si acá difiriera, el POS mostraría un final
      // que ninguna etiqueta imprimió.
      const opts = { iva: p.iva, redondeo: p.redondeo ?? redondeo };

      /*
       * El formato de venta, ordenado por preferencia de lista. Solo esto llega
       * al POS: lo que no está cargado, no se vende. Cada fila resuelve su precio
       * con el MISMO helper que la ficha del producto (markup o precio definido).
       *
       * `presId` elige de quién son las filas: null = el producto suelto, un id =
       * uno de sus paquetes, que se cotiza solo desde la 0053. Sin ese filtro, la
       * madre mostraría como propios los precios de sus hijos.
       */
      const efectivasDe = (presId: number | null, costo: number) => formatos
        .filter((f) => f.productoId === p.id && (f.presentacionId ?? null) === presId && porLista.has(f.listaId))
        .map((f) => {
          /* Los DOS precios de la fila: el neto es la moneda del motor (el
           * renglón del ticket trabaja en neto y el IVA se suma al total); el
           * FINAL es el que ve el cliente — todo lo que MUESTRA un precio de
           * lista (Alt+F3, buscadores del POS) usa el final, porque acá los
           * precios al público llevan el IVA adentro (19/8/2026). */
          const pv = precioVentaFila(costo, f, opts);
          return {
            ...f,
            orden: porLista.get(f.listaId)!.orden,
            netoUnitario: pv.netoUnitario,
            finalUnitario: pv.finalUnitario,
          };
        })
        .sort((a, b) => a.orden - b.orden);

      const efectivas = efectivasDe(null, costoNeto);

      // El precio "de vidriera" es el del piso: lo que se paga sin habilitar
      // nada. Si el producto no tiene el piso cargado, la más cara de las suyas.
      const filaBase = efectivas.find((ef) => ef.listaId === listaBase?.id)
        ?? efectivas[efectivas.length - 1] ?? null;

      /*
       * El "solo para fraccionar" (la Pimienta de Jamaica que llega 1 kg y se
       * fracciona entera en paquetes) NO viaja suelto al POS: no está a la
       * venta por kg. Sus paquetes, abajo, van normal. Esto es solo lo que se
       * OFRECE — el candado que vale está en la venta (validarSoloFraccionar).
       */
      if (!p.soloFraccionar) items.push({
        key: `p${p.id}`,
        productoId: p.id,
        presentacionId: null,
        codigo: p.codigoBarras || p.codigoPropio,
        /** Código INTERNO del producto: es el que se muestra en las búsquedas. */
        codigoPropio: p.codigoPropio,
        nombre: p.nombre,
        marcaId: p.marcaId,
        marca: nombreMarca.get(p.marcaId as number) ?? '',
        categoriaId: p.categoriaId,
        categoria: nombreCategoria.get(p.categoriaId as number) ?? '',
        etiquetas: etiquetasDe.get(p.id) ?? [],
        proveedorIds: proveedoresDe.get(p.id) ?? [],
        detalle: p.tipo === 'granel' ? 'Suelto (por kg)' : 'Unidad',
        tipo: p.tipo,
        unidad: p.tipo === 'granel' ? 'kg' : 'u',
        fraccionable: p.tipo === 'granel',   // admite cantidad decimal
        iva: p.iva,
        codigoBarras: p.codigoBarras,
        precio: money(filaBase?.netoUnitario ?? 0),
        /** El de la etiqueta: lo que paga el cliente. Solo para MOSTRAR. */
        precioFinal: money(filaBase?.finalUnitario ?? 0),
        precios: efectivas.map((ef) => ({
          listaId: ef.listaId,
          precio: money(ef.netoUnitario),
          precioFinal: money(ef.finalUnitario),
          unidadesMinimas: ef.unidadesMinimas,
          unidades: ef.unidades,
        })),
        /**
         * Formatos con identidad propia (código de caja o venta por N): al
         * escanear el código de la caja, la caja registradora carga las N
         * unidades de una — y el motor de listas hace el resto.
         */
        formatosVenta: efectivas
          .filter((ef) => ef.codigoBarras || ef.unidades > 1)
          .map((ef) => ({ listaId: ef.listaId, codigoBarras: ef.codigoBarras, unidades: ef.unidades })),
        stock: money(stockDe.get(clave(p.id, null, sucursalId)) ?? 0),
        stockSucursales: desglose(p.id, null),
      });

      for (const pres of press.filter((x) => x.productoId === p.id)) {
        /*
         * EL PAQUETE SE COTIZA SOLO (0053). Su costo es el del kilo por lo que
         * consume; el precio sale de SUS filas, no de las de la madre. Sin filas
         * no tiene precio y eso NO es cero: viaja `sinFormato` y el POS lo
         * bloquea con el motivo. Un cero se vendería.
         */
        const suyas = efectivasDe(pres.id, costoNetoPresentacion(costoNeto, pres.tamKg));
        const pisoPres = suyas.find((ef) => ef.listaId === listaBase?.id) ?? suyas[suyas.length - 1] ?? null;
        items.push({
          key: `s${pres.id}`,
          productoId: p.id,
          presentacionId: pres.id,
          codigo: pres.codigoBarras,
          codigoPropio: p.codigoPropio,
          nombre: p.nombre,
          marcaId: p.marcaId,
          marca: nombreMarca.get(p.marcaId as number) ?? '',
          categoriaId: p.categoriaId,
          categoria: nombreCategoria.get(p.categoriaId as number) ?? '',
          etiquetas: etiquetasDe.get(p.id) ?? [],
          proveedorIds: proveedoresDe.get(p.id) ?? [],
          detalle: pres.tamKg < 1 ? `${Math.round(pres.tamKg * 1000)} g` : `${pres.tamKg} kg`,
          tipo: p.tipo,
          unidad: 'u',
          fraccionable: false,
          iva: p.iva,
          codigoBarras: pres.codigoBarras,
          precio: pisoPres ? money(pisoPres.netoUnitario) : 0,
          precioFinal: pisoPres ? money(pisoPres.finalUnitario) : 0,
          /** Sin formato de venta cargado: el POS lo muestra y explica por qué no se puede vender. */
          sinFormato: suyas.length === 0,
          precios: suyas.map((ef) => ({
            listaId: ef.listaId,
            precio: money(ef.netoUnitario),
            precioFinal: money(ef.finalUnitario),
            unidadesMinimas: ef.unidadesMinimas,
            unidades: ef.unidades,
          })),
          /** La caja de N paquetes tiene su propio código, igual que en el producto. */
          formatosVenta: suyas
            .filter((ef) => ef.codigoBarras || ef.unidades > 1)
            .map((ef) => ({ listaId: ef.listaId, codigoBarras: ef.codigoBarras, unidades: ef.unidades })),
          stock: money(stockDe.get(clave(p.id, pres.id, sucursalId)) ?? 0),
          stockSucursales: desglose(p.id, pres.id),
        });
      }
    }

    /**
     * Las listas viajan solo con su IDENTIDAD: markup y mínimos son del
     * artículo y ya están en `items[].precios`. Acá van las dos reglas que
     * SÍ son globales — las de marca y la de monto — para que el motor del POS
     * pueda evaluarlas sin recorrer el catálogo.
     */
    return {
      listas: activas.map((l: any) => ({
        listaId: l.id,
        modalidadId: l.modalidadId,
        modalidad: l.modalidad,
        // Para agrupar por modalidad sin adivinar (búsqueda masiva del POS).
        modalidadOrden: l.modalidadOrden ?? 0,
        numero: l.numero,
        nombre: l.nombre,
        etiqueta: l.etiqueta,
        orden: l.orden,
        esBase: l.id === listaBase?.id,
      })),
      /** "12 unidades de Coca-Cola habilitan Mayorista." Desbloquean la MODALIDAD. */
      reglasMarca: (cat.reglasMarca ?? [])
        .filter((r: any) => r.activa && r.unidadesMinimas > 0)
        .map((r: any) => ({
          // El motor compara por id (inmune a acentos y renombres); el nombre
          // viaja solo para que el cartel del POS diga de qué marca habla.
          marcaId: r.marcaId,
          marca: r.marca,
          unidadesMinimas: r.unidadesMinimas,
          modalidadId: r.modalidadId,
          modalidad: r.modalidad,
        })),
      /**
       * Acceso por monto de ticket. Se SUGIERE, nunca se aplica solo: se mide
       * sobre precios y aplicarlo baja el total, así que auto-aplicarlo podría
       * dejar el ticket bajo el umbral y revertirse en un ciclo.
       */
      montoMayorista: cfg.montoMinimoMayorista > 0 && cfg.modalidadMontoId
        ? {
            monto: cfg.montoMinimoMayorista,
            modalidadId: cfg.modalidadMontoId,
            modalidad: cat.modalidades.find((m: any) => m.id === cfg.modalidadMontoId)?.nombre ?? '',
            mediosPago: cfg.mediosPagoMonto ?? [],
          }
        : null,
      /**
       * Ofertas ACTIVAS con alcances y componentes. La vigencia fina (fecha,
       * día, sucursal) la evalúa el motor del POS con su reloj: el catálogo se
       * cachea al abrir la caja y una promo puede arrancar o vencer en medio
       * del turno.
       */
      ofertas: ofs,
      /** Nombres de las etiquetas, para el buscador de alcance del panel. */
      etiquetasCatalogo: etiqCat,
      /** Para el filtro por proveedor de la consulta de existencias. */
      proveedoresCatalogo: provCat,
      items,
    };
  }

  /* ------------------------------ Cálculo ------------------------------ */

  /**
   * EL PORTERO DEL RENGLÓN — corre ANTES de la aritmética, y es el que decide.
   * ==========================================================================
   * Hasta acá `calcularTotales` tomaba `precioUnitario`, `descuento` e `iva` tal
   * como venían del cliente. Con eso, un cajero con la consola del navegador
   * abierta se llevaba la mercadería gratis en un request:
   *
   *   items: [{ productoId: 312, cantidad: 10, precioUnitario: 8000, descuento: 100 }]
   *   pagos: [{ medio: 'efectivo', importe: 0.01 }]
   *
   * neto 0 → total 0 → `validarPagos` compara |0,01 − 0| > 0,01 y pasa. Ticket
   * numerado, diez unidades menos de stock, y el arqueo esperando un centavo. La
   * variante silenciosa era peor: `descuento: 40` con `listaOrigen: 'auto'` daba
   * precio mayorista a un consumidor final y el renglón quedaba registrado como
   * si la regla lo hubiera habilitado.
   *
   * Tres cosas dejan de ser del cliente:
   *
   *  1. EL IVA sale del producto. No es una opinión del punto de venta: es la
   *     alícuota del artículo. Mandaba `iva: -200` y el total daba NEGATIVO, así
   *     que la venta en cuenta corriente le BAJABA la deuda al cliente — y como
   *     Cobranzas solo lista saldos > 0, el comprobante no aparecía en pantalla.
   *  2. EL PRECIO se recalcula contra la fila de `producto_listas` de la lista
   *     con la que dice venderse, con el mismo helper que la ficha del producto.
   *     El que no coincide se rechaza.
   *  3. LA LISTA tiene que estar habilitada por una de las cuatro puertas del
   *     motor (cliente, unidades del producto, regla de marca, monto del ticket),
   *     medidas acá contra el ticket real. Mandar el `listaId` mayorista con su
   *     precio mayorista ya no alcanza: hay que haberlo ganado.
   *
   * El permiso `precio_manual` levanta 2 y 3, y el tope de descuento: es la
   * decisión del dueño de que alguien pueda regatear en el mostrador. Sin él, lo
   * que se cobra es lo que dice el catálogo.
   *
   * `congelados` es la SEXTA puerta y la agregó el mordisco que se llevó este
   * mismo portero: un presupuesto se cotiza hoy y se cobra la semana que viene,
   * así que su precio ya no coincide con el de la lista. Con esto, un renglón
   * que viene de un presupuesto confirmado y vigente se cobra al precio con el
   * que se prometió, sin pedir `precio_manual` — que era lo que dejaba al
   * vendedor sin poder cerrar el pedido que la casa ya había firmado.
   */
  /**
   * Los precios que la casa ya prometió por escrito, para que el portero los
   * reconozca. Devuelve un mapa vacío —o sea, ninguna excepción— salvo que la
   * venta declare un presupuesto que exista, sea **de este cliente**, esté
   * **confirmado** y **no esté vencido**. Las tres condiciones importan: sin la
   * del cliente, cualquiera invocaría el presupuesto ajeno para llevarse su
   * precio; sin la del estado, valdría un borrador que se escribe solo; y sin la
   * del vencimiento, un precio de hace un año seguiría vigente para siempre.
   */
  private async congeladosDePresupuesto(
    presupuestoId: number | undefined, clienteId: number, sucursalId?: number | null,
  ) {
    const vacio = new Map<string, { precioLista: number; listaId: number | null }>();
    if (!presupuestoId) return vacio;

    const [pre] = await this.db.select().from(presupuestos)
      .where(eq(presupuestos.id, Number(presupuestoId))).limit(1);
    if (!pre) throw new BadRequestException('El presupuesto que se quiere cerrar no existe.');
    /*
     * SE AVISA ACÁ, en el alta del borrador, y no recién al cobrar.
     *
     * `cerrarPresupuesto` valida lo mismo, pero corre al CONFIRMAR: un ticket
     * armado contra el pedido de otro cliente o de otra sucursal se aceptaba
     * entero y explotaba con el cliente esperando en el mostrador. Las dos
     * validaciones tienen que existir —la de allá es la que protege la
     * transacción— pero esta es la que hace que el error llegue a tiempo.
     */
    if (pre.clienteId !== clienteId) {
      throw new BadRequestException('Ese presupuesto es de otro cliente.');
    }
    if (sucursalId != null && pre.sucursalId !== sucursalId) {
      throw new BadRequestException(
        'Ese presupuesto se cotizó en otra sucursal: tiene la mercadería reservada allá.',
      );
    }
    // Estado y vencimiento NO cortan: un pedido todavía no confirmado, o vencido,
    // se puede cerrar igual — lo que no se hereda es su precio congelado.
    if (pre.estado !== 'confirmado') return vacio;
    if (pre.vencimiento && pre.vencimiento.getTime() < Date.now()) return vacio;

    const renglones = await this.db.select().from(presupuestoItems)
      .where(eq(presupuestoItems.presupuestoId, pre.id));
    for (const r of renglones) {
      vacio.set(`${r.productoId}:${r.presentacionId ?? ''}`, {
        precioLista: money(r.precioLista),
        listaId: r.listaId ?? null,
      });
    }
    return vacio;
  }

  /**
   * DE IDS A DESCUENTOS REALES — el portero de los descuentos con nombre.
   *
   * El cliente HTTP manda ids y nada más. Todo lo que decide cuánto se descuenta
   * sale de la tabla, y todo lo que decide SI SE PUEDE sale de la sesión. Es la
   * misma frontera que ya rige para el precio y la lista, y por el mismo motivo:
   * un porcentaje que viniera del navegador es un descuento que se lo pone el
   * que compra.
   *
   * Cinco candados, en el orden en que fallan más seguido:
   *
   *  1. EXISTE Y ESTÁ ACTIVO. Un descuento dado de baja no se aplica más, y el
   *     mensaje lo dice por nombre para que la cajera sepa cuál sacar.
   *  2. VIGENTE. `vence` guarda el instante FINAL del día elegido, así que
   *     alcanza con compararlo contra ahora: el descuento vale todo su último
   *     día, que es lo que pidió el dueño. Nulo = sin vencimiento.
   *  3. LA SUCURSAL SALE DE LA SESIÓN, no del body. Un descuento de Fontana no
   *     se aplica desde Centro ni mandando `sucursalId` a mano. Nulo = todas.
   *  4. EL PERMISO. Los que piden admin no los puede aplicar una cajera; sin
   *     esto, publicar un 25% sería subirle el tope a todo el mundo.
   *  5. UNO POR LISTA. Dos descuentos de la misma lista competirían por los
   *     mismos renglones y el resultado dependería del orden del array.
   */
  private async resolverDescuentos(
    ids: number[] = [],
    /* Anulable porque la venta lo es. Con `null` no hay sucursal contra la cual
     * validar, así que solo pasan los descuentos de alcance general: un
     * descuento de Fontana no se cuela por un ticket sin sucursal. */
    sucursalId: number | null,
    puedeAdmin: boolean,
    /**
     * Los que YA estaban en el ticket antes de esta edición.
     *
     * El permiso se pide para APLICAR, no para convivir. La escena que esto
     * habilita es la única para la que `requiereAdmin` existe: el encargado se
     * acerca, autoriza el 25% por la demora, y se va; la cajera sigue con el
     * ticket. Sin esta excepción, ese ticket le queda radiactivo — no puede
     * agregar un producto ni guardar, porque cada autoguardado reenvía el
     * descuento y se lo rebota su propio permiso.
     */
    yaAplicados: Set<number> = new Set(),
  ): Promise<Map<number, DescuentoResuelto>> {
    const porLista = new Map<number, DescuentoResuelto>();
    const unicos = [...new Set((ids ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    if (!unicos.length) return porLista;

    const filas = await this.db.select().from(descuentos).where(inArray(descuentos.id, unicos));
    const ahora = new Date();

    for (const id of unicos) {
      const d = filas.find((f) => f.id === id);
      if (!d) throw new BadRequestException('Uno de los descuentos aplicados ya no existe. Quitalo y volvé a intentar.');
      if (!d.activo) throw new BadRequestException(`El descuento "${d.nombre}" está desactivado.`);
      if (d.vence && d.vence.getTime() < ahora.getTime()) {
        throw new BadRequestException(`El descuento "${d.nombre}" venció.`);
      }
      if (d.sucursalId != null && d.sucursalId !== sucursalId) {
        throw new BadRequestException(`El descuento "${d.nombre}" no es de esta sucursal.`);
      }
      if (d.requiereAdmin && !puedeAdmin && !yaAplicados.has(d.id)) {
        throw new BadRequestException(`El descuento "${d.nombre}" lo tiene que aplicar un administrador.`);
      }
      const ya = porLista.get(d.listaId);
      if (ya) {
        throw new BadRequestException(
          `"${ya.nombre}" y "${d.nombre}" son de la misma lista de precios: solo se puede aplicar uno.`,
        );
      }
      porLista.set(d.listaId, {
        id: d.id, nombre: d.nombre, porcentaje: Number(d.porcentaje) || 0,
        listaId: d.listaId, medioPago: d.medioPago ?? null,
      });
    }
    return porLista;
  }

  private async resolverRenglones(
    itemsDto: VentaItemDto[],
    cliente: { id: number },
    config: any,
    puedePisarPrecio: boolean,
    congelados: Map<string, { precioLista: number; listaId: number | null }> = new Map(),
    descuentosPorLista: Map<number, DescuentoResuelto> = new Map(),
  ): Promise<RenglonResuelto[]> {
    const items = itemsDto ?? [];
    if (!items.length) return [];

    const ids = [...new Set(items.map((it) => Number(it.productoId)))];
    /* Las etiquetas del producto son para el ALCANCE de las ofertas: una promo
     * puede apuntar a una etiqueta ('Sin TACC'), y sin esta consulta el alcance
     * por etiqueta rechazaría promos legítimas. */
    const [prods, press, provs, filas, cat, asignadas, etiqs] = await Promise.all([
      this.db.select().from(productos).where(inArray(productos.id, ids)),
      this.db.select().from(presentaciones).where(inArray(presentaciones.productoId, ids)),
      this.db.select().from(productoProveedores).where(inArray(productoProveedores.productoId, ids)),
      this.db.select().from(productoListas).where(inArray(productoListas.productoId, ids)),
      this.listas.catalogo(),
      this.db.select().from(clienteListas).where(eq(clienteListas.clienteId, cliente.id)),
      this.db.select().from(productoEtiquetas).where(inArray(productoEtiquetas.productoId, ids)),
    ]);
    const etiquetasDe = new Map<number, number[]>();
    for (const e of etiqs) {
      const arr = etiquetasDe.get(e.productoId);
      if (arr) arr.push(e.etiquetaId); else etiquetasDe.set(e.productoId, [e.etiquetaId]);
    }

    const prodDe = new Map(prods.map((p) => [p.id, p]));
    const presDe = new Map(press.map((p) => [p.id, p]));
    const redondeo = config.redondeoPrecio;
    const activas = (cat.listas ?? []).filter((l: any) => l.activa);
    const listaDe = new Map<number, any>(activas.map((l: any) => [l.id, l]));
    const baseId = activas.find((l: any) => l.id === config.listaBaseId)?.id
      ?? activas[0]?.id ?? null;
    const delCliente = new Set(asignadas.map((a) => a.listaId));

    /*
     * Los AGREGADOS del ticket: unidades por producto y por marca. Se cuentan
     * sobre las cantidades y no sobre los precios, igual que en el motor del POS
     * y por la misma razón — si dependieran del precio, aplicar una lista
     * cambiaría la calificación y el resultado dependería del orden de carga.
     */
    const porProducto = new Map<number, number>();
    const porMarca = new Map<number, number>();
    for (const it of items) {
      const c = Number(it.cantidad) || 0;
      if (!(c > 0)) continue;
      const pid = Number(it.productoId);
      porProducto.set(pid, (porProducto.get(pid) ?? 0) + c);
      const marcaId = prodDe.get(pid)?.marcaId;
      if (marcaId) porMarca.set(marcaId, (porMarca.get(marcaId) ?? 0) + c);
    }

    /** Modalidades que las reglas de MARCA le abren a cada marca. */
    const modalidadesDeMarca = new Map<number, Set<number>>();
    for (const r of (cat.reglasMarca ?? []) as any[]) {
      const min = Number(r.unidadesMinimas) || 0;
      if (!r.activa || !(min > 0)) continue;
      if ((porMarca.get(r.marcaId) ?? 0) + 1e-9 < min) continue;
      const s = modalidadesDeMarca.get(r.marcaId) ?? new Set<number>();
      s.add(r.modalidadId);
      modalidadesDeMarca.set(r.marcaId, s);
    }

    /*
     * La puerta del MONTO se mide sobre pesos, y acá se mide con los precios que
     * el ticket declara. Es la dirección generosa a propósito: el motor del POS
     * la sugiere después de aplicar el beneficio (que baja el total), así que
     * medirla sobre el bruto rechazaría ventas legítimas. El medio de pago que
     * esa modalidad exige lo sigue validando `validarMediosPagoMonto`.
     */
    const brutoTicket = items.reduce(
      (a, it) => a + (Number(it.cantidad) || 0) * (Number(it.precioUnitario ?? it.precioLista) || 0), 0,
    );
    const modalidadPorMonto = config.montoMinimoMayorista > 0 && config.modalidadMontoId
      && brutoTicket + 1e-9 >= config.montoMinimoMayorista
      ? config.modalidadMontoId
      : null;

    /*
     * Ofertas activas, para acotar cuánto puede descontar una promo. Se piden
     * SOLO si algún renglón declara un descuento de oferta: este método corre en
     * cada autoguardado del ticket (una vez por tecla, con retardo) y el catálogo
     * de ofertas son tres consultas —ofertas + alcances + componentes— que en el
     * 95% de los tickets no se leen. El resto de la validación no las mira.
     */
    const declaranOferta = items.some((it) => (Number(it.ofertaDescuento) || 0) > 0);
    const ofertasActivas = new Map<number, any>(
      declaranOferta ? ((await this.ofertas.activas()) as any[]).map((o) => [o.id, o]) : [],
    );

    const resueltos = items.map((it) => {
      const prod = prodDe.get(Number(it.productoId));
      if (!prod) throw new BadRequestException('Uno de los artículos del ticket no existe.');
      const presId = it.presentacionId ?? null;
      const pres = presId ? presDe.get(presId) : null;
      if (presId && (!pres || pres.productoId !== prod.id)) {
        throw new BadRequestException(`El envasado que se está vendiendo no es de ${prod.nombre}.`);
      }
      const etiqueta = `${prod.nombre}${pres ? ` (${pres.tamKg} kg)` : ''}`;
      const cantidad = Number(it.cantidad) || 0;

      /* -- El costo con el que se cotiza, igual que en el catálogo del POS -- */
      const suyos = provs.filter((x) => x.productoId === prod.id);
      const cf = costosFormato(formatoActivo(suyos) as any, prod.iva);
      const costo = pres
        ? costoNetoPresentacion(cf.costoPrecioUnitario, pres.tamKg)
        : cf.costoPrecioUnitario;
      /*
       * Y EL COSTO QUE SE CONGELA EN EL RENGLÓN (0072), que es OTRO: el real,
       * con la parte sin factura entera. Se escribe acá —el único momento en
       * que el costo y la venta coinciden en el tiempo— porque el margen de
       * marzo no puede cambiar porque en julio subió el catálogo. El paquete
       * hereda el del kilo por su tamaño, igual que su precio.
       */
      const escala = pres ? Number(pres.tamKg) || 0 : 1;
      const costoCongelado = cf.costoNetoUnitario * escala;
      const ivaAbsorbidoCongelado = cf.ivaAbsorbidoUnitario * escala;

      /* -- El formato de venta del artículo, ordenado por preferencia -- */
      const suyas = filas
        .filter((f) => f.productoId === prod.id && (f.presentacionId ?? null) === presId && listaDe.has(f.listaId))
        .map((f) => ({ fila: f, lista: listaDe.get(f.listaId)! }))
        .sort((a, b) => a.lista.orden - b.lista.orden);
      if (!suyas.length) {
        throw new BadRequestException(
          `${etiqueta} no tiene formato de venta cargado: no se puede vender hasta que tenga precio.`,
        );
      }

      /*
       * EL PISO. Es la lista base si el artículo la tiene cargada; si no, la
       * última de las suyas — misma caída que el motor del POS, para que un
       * producto sin el piso siga siendo vendible en vez de quedar trabado.
       */
      const piso = suyas.find((s) => s.lista.id === baseId) ?? suyas[suyas.length - 1];

      const elegida = it.listaId ? suyas.find((s) => s.fila.listaId === it.listaId) : piso;
      if (!elegida) {
        throw new BadRequestException(
          `${etiqueta} no se vende con esa lista de precios. Elegí una de las que tiene cargadas.`,
        );
      }

      /*
       * ¿VIENE COTIZADO? El renglón del presupuesto confirmado y vigente que
       * esta venta cierra, si lo hay. Es la puerta que se abre antes que las
       * otras: la casa ya le puso precio por escrito a este artículo.
       */
      const congelado = congelados.get(`${prod.id}:${presId ?? ''}`) ?? null;

      /* -- ¿Se ganó esa lista? Las cuatro puertas, en O -- */
      const esPiso = elegida.fila.listaId === piso.fila.listaId;
      const minimo = Number(elegida.fila.unidadesMinimas) || 0;
      /*
       * El mínimo se mide contra lo que el TICKET lleva de ese producto, no
       * contra este renglón: es la misma cuenta que hace el motor del POS
       * (`agregadosTicket`). Si midiera el renglón, un ticket con el mismo
       * producto en dos renglones tendría el precio habilitado en la pantalla y
       * rechazado por la API — y el cajero se enteraría al cobrar.
       */
      const llevadas = porProducto.get(prod.id) ?? cantidad;
      const habilitada = esPiso
        || !!congelado
        || delCliente.has(elegida.fila.listaId)
        || (minimo > 0 && llevadas + 1e-9 >= minimo)
        || !!modalidadesDeMarca.get(prod.marcaId as number)?.has(elegida.lista.modalidadId)
        || (modalidadPorMonto != null && elegida.lista.modalidadId === modalidadPorMonto);
      if (!habilitada && !puedePisarPrecio) {
        throw new BadRequestException(
          `${etiqueta}: el ticket no habilita la lista ${elegida.lista.nombre}`
          + `${minimo > 0 ? ` (pide ${minimo} unidades y el ticket lleva ${llevadas})` : ''}`
          + '. Hace falta el permiso para pisar precios.',
        );
      }

      /* -- El precio: el de la fila, salvo que se pise con permiso -- */
      const netoLista = money(precioVentaFila(costo, elegida.fila, { iva: prod.iva, redondeo }).netoUnitario);
      const pedido = it.precioUnitario != null ? money(it.precioUnitario) : netoLista;
      const difiere = Math.abs(pedido - netoLista) > 0.01;
      /*
       * EL PRECIO COTIZADO NO ES UN PRECIO PISADO.
       *
       * Un presupuesto existe para que el precio no se mueva entre que se cotiza
       * y que se cobra — para eso tiene vencimiento. Sin esta excepción, todo
       * pedido cotizado con una lista que no fuera la base dejaba de poder
       * cerrarse en el POS apenas los precios cambiaban: el vendedor veía
       * "hace falta el permiso para pisar precios" sobre un pedido que la casa
       * ya había prometido por escrito.
       *
       * No es un agujero: el precio tiene que coincidir con el renglón de un
       * presupuesto CONFIRMADO y VIGENTE de ESTE cliente, cargado de la base
       * (ver `congeladosDePresupuesto`). No es un número que el cliente HTTP
       * elige — es uno que ya está escrito en un documento.
       */
      const honraCotizado = !!congelado && Math.abs(pedido - congelado.precioLista) <= 0.01;
      const pisado = difiere && !honraCotizado;
      if (pisado && !puedePisarPrecio) {
        throw new BadRequestException(
          `${etiqueta}: el precio de la lista ${elegida.lista.nombre} es $${netoLista.toFixed(2)} `
          + `y se está cobrando $${pedido.toFixed(2)}. Hace falta el permiso para pisar precios.`,
        );
      }
      if (pisado && pedido < 0) throw new BadRequestException(`${etiqueta}: el precio no puede ser negativo.`);

      /* -- El descuento: 0..100 por DTO, y el tope de la configuración acá -- */
      let desc = Number(it.descuento) || 0;
      const tope = Number(config.descuentoMaxVendedor) || 0;
      if (desc > tope + 1e-9 && !puedePisarPrecio) {
        throw new BadRequestException(
          `${etiqueta}: el descuento de ${desc}% supera el tope de ${tope}%. Hace falta el permiso para pisar precios.`,
        );
      }

      /*
       * LA OFERTA. El importe que descuenta lo calcula el motor del POS, así que
       * acá no se recalcula: se ACOTA. La promo tiene que existir y estar activa,
       * y si es de las que se expresan en porcentaje, no puede descontar más que
       * ese porcentaje del renglón.
       *
       * PENDIENTE anotado en /info: para `nxm`, `pack`, `precio_fijo` y `combo` el
       * techo sigue siendo el bruto del renglón, porque el importe exacto depende
       * del alcance y de los componentes — eso pide reevaluar las ofertas en el
       * servidor, que es trabajo aparte.
       */
      let ofertaDesc = Math.max(0, Number(it.ofertaDescuento) || 0);
      let ofertaId = it.ofertaId ?? null;
      if (ofertaDesc > 0) {
        const of = ofertaId ? ofertasActivas.get(ofertaId) : null;
        if (!of) {
          throw new BadRequestException(`${etiqueta}: la oferta que descuenta ese importe no está activa.`);
        }
        /*
         * PRIMERO EL ALCANCE, que no se miraba en absoluto: alcanzaba con que
         * existiera UNA promo activa en el sistema para colgarle su descuento a
         * cualquier producto. Con un 3×2 de galletitas vivo, un renglón de aceite
         * de $80.000 se cobraba $1 y quedaba registrado como "promo aplicada".
         */
        if (!ofertaAlcanza(of, {
          productoId: prod.id, presentacionId: presId,
          marcaId: prod.marcaId as number | null, categoriaId: prod.categoriaId as number | null,
          etiquetas: etiquetasDe.get(prod.id) ?? [],
        })) {
          throw new BadRequestException(
            `${etiqueta}: la oferta "${of.nombre}" no incluye este artículo.`,
          );
        }
        /*
         * Y LA LISTA SOBRE LA QUE CORRE (0065), que tampoco se miraba: la
         * restricción vivía únicamente en el motor del navegador, así que un
         * pedido armado a mano le colgaba una promo de mostrador a un renglón
         * cotizado a precio mayorista — que es exactamente el doble beneficio
         * que esa restricción existe para impedir.
         *
         * Vacío = corre en todas. Y se compara contra la lista con la que el
         * renglón quedó cotizado, no contra su origen.
         */
        const listasOferta = String((of as any).listas ?? '').split(',')
          .map((x) => parseInt(x.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
        if (listasOferta.length && !listasOferta.includes(elegida.fila.listaId as number)) {
          throw new BadRequestException(
            `${etiqueta}: la oferta "${of.nombre}" no corre sobre la lista ${elegida.lista.etiqueta || elegida.lista.nombre}.`,
          );
        }
        /*
         * Y DESPUÉS EL TECHO, ahora por mecánica y no solo para las de
         * porcentaje. El importe exacto lo sigue calculando el motor del POS
         * (recalcula con cada tecla); acá se acota cuánto puede llegar a ser.
         *
         * `null` es el combo y la de ticket: su ahorro se reparte entre renglones
         * de productos distintos, así que no se puede derivar de este renglón
         * solo. Para esos dos el techo sigue siendo el bruto —queda anotado en
         * Pendientes— pero ya no se les puede pedir prestado el descuento para
         * otro producto, que era la parte grave.
         */
        const techo = techoDeOferta(of, {
          cantidad, precioUnitario: pedido, descuento: desc, iva: prod.iva,
        });
        if (techo != null && ofertaDesc > techo + 0.01) {
          throw new BadRequestException(
            `${etiqueta}: la oferta "${of.nombre}" descuenta hasta $${techo.toFixed(2)} y se está aplicando $${ofertaDesc.toFixed(2)}.`,
          );
        }
      } else {
        // Sin importe no hay promo: se limpia la etiqueta para que el ticket no
        // diga "3×2" en un renglón que se cobró entero.
        ofertaId = null;
        ofertaDesc = 0;
      }

      /*
       * EL DESCUENTO CON NOMBRE, y va último por dos motivos que no son de estilo.
       *
       * DESPUÉS DEL TOPE: el porcentaje de acá lo autorizó el dueño al crear el
       * descuento, no la cajera al tipearlo, así que no pasa por
       * `descuentoMaxVendedor`. Si se evaluara antes, "Atención por tardanza 25%"
       * sería rechazado por el tope del 10% y el descuento no serviría para nada.
       * El tope sigue vivo para lo que el vendedor pone a mano, que es lo que
       * esa configuración existe para acotar.
       *
       * DESPUÉS DE LA OFERTA, y solo si no hay: un renglón en 3×2 o con precio
       * fijo ya tiene su beneficio, y sumarle un 20% es pagar dos veces la misma
       * promoción (decisión del dueño, 14/8/2026).
       *
       * Y GANA EL MAYOR, nunca se suman. Dos descuentos del 25% sumados dejan el
       * producto a mitad de precio; encadenados, en 43%. El cliente entiende
       * "te hago el mejor de los dos", y es el único criterio que no puede
       * regalar de más por accidente.
       *
       * `descuentoId` se llena SOLO si ganó: si el 25% del cliente le gana al
       * 20% de "Familiares", ese renglón no es de Familiares, y el reporte de
       * cuánto cuesta cada autorización no tiene que contarlo.
       */
      let descuentoId: number | null = null;
      let descuentoNombre = '';
      /* Lo que el renglón traía por su cuenta, capturado ANTES de que el
       * nombrado lo pise. Es lo único que permite volver atrás sin adivinar. */
      const descuentoBase = desc;
      if (ofertaDesc === 0) {
        const dNom = descuentosPorLista.get(elegida.fila.listaId as number);
        if (dNom && dNom.porcentaje > desc + 1e-9) {
          desc = dNom.porcentaje;
          descuentoId = dNom.id;
          descuentoNombre = dNom.nombre;
        }
      }

      return {
        ...it,
        descuentoId,
        descuentoNombre,
        descuentoBase,
        cantidad,
        listaId: elegida.fila.listaId,
        lista: elegida.lista.etiqueta || elegida.lista.nombre || '',
        /*
         * El origen lo dice el SERVIDOR, no es una etiqueta que el cliente elige
         * para que su renglón parezca legal. 'presupuesto' va primero porque es
         * lo contrario de 'manual' aunque los dos se salgan del precio de lista:
         * uno está respaldado por un documento y el otro es alguien tocándolo en
         * el mostrador. Confundirlos volvería inútil esta columna, que existe
         * justamente para poder auditar quién regala precio mayorista.
         */
        listaOrigen: honraCotizado ? 'presupuesto' : (pisado ? 'manual' : (esPiso ? 'base' : 'auto')),
        /*
         * `precioLista` es el de la fila... salvo en el cotizado, donde el precio
         * de referencia ES el que se prometió: si acá quedara el de hoy, el
         * ticket mostraría un "descuento" fantasma por la diferencia entre el
         * precio viejo y el nuevo, y ese número entra en los reportes.
         */
        precioLista: honraCotizado ? congelado!.precioLista : netoLista,
        precioUnitario: pedido,
        descuento: desc,
        ofertaId,
        ofertaDescuento: ofertaDesc,
        iva: prod.iva,
        /* El costo congelado (0072): margen real = neto − costo; el aparente
         * le devuelve el IVA absorbido. El % viaja para agrupar después. */
        costoUnitario: costoCongelado,
        ivaAbsorbidoUnitario: ivaAbsorbidoCongelado,
        porcSinFactura: cf.porcSinFactura,
      } as RenglonResuelto;
    });

    /*
     * Y UN DESCUENTO NO PUEDE QUEDAR COLGADO DE UNA LISTA QUE EL TICKET NO USA.
     *
     * La lista de cada renglón la decide el SERVIDOR (por condición, por monto,
     * por presupuesto), así que el POS puede haber ofrecido el descuento con un
     * ticket que después cambió de lista solo. Sin este chequeo el descuento
     * quedaría "aplicado" sin tocar un peso: la pantalla lo muestra activo, el
     * total no baja, y nadie entiende por qué.
     *
     * Va acá y no antes porque recién ahora se sabe con qué lista quedó cada
     * renglón.
     */
    for (const d of descuentosPorLista.values()) {
      if (!resueltos.some((r) => r.listaId === d.listaId)) {
        throw new BadRequestException(
          `El descuento "${d.nombre}" es de otra lista de precios: ningún renglón de este ticket la usa.`,
        );
      }
    }
    return resueltos;
  }

  /**
   * Neto, descuento, IVA y total de ítems + extras. Un único lugar para que el
   * borrador, la edición y la confirmación no puedan descuadrar entre sí.
   *
   * Recibe los renglones YA resueltos por `resolverRenglones`: acá solo hay
   * aritmética, y ningún número de esta función viene del cliente sin pasar por
   * ese portero.
   *
   * SE REDONDEA RENGLÓN POR RENGLÓN, y no una sola vez al final. Son dos cosas:
   *
   *  1. El renglón se GUARDA redondeado (`subtotal: money(neto)`), así que
   *     acumular el neto crudo dejaba una cabecera que no era la suma de sus
   *     propias filas: el ticket impreso no cerraba consigo mismo.
   *  2. El POS suma exactamente así (`totalesTicket` en domain/pos.js redondea
   *     cada renglón). Con cuatro renglones de granel de medio centavo la
   *     diferencia llegaba a $0,02 y `validarPagos` —que tolera un centavo—
   *     rechazaba el cobro con "los pagos suman $X y el total es $Y", con el
   *     cliente enfrente y sin nada para corregir en pantalla.
   */
  private calcularTotales(itemsDto: RenglonResuelto[] = [], extrasDto: VentaExtraDto[] = []) {
    let subtotalNeto = 0;
    let descuentoTotal = 0;
    let ivaTotal = 0;

    const items = itemsDto.map((it) => {
      const cantidad = Number(it.cantidad) || 0;
      if (cantidad <= 0) throw new BadRequestException('Todas las cantidades deben ser mayores a 0.');
      const precioUnitario = Number(it.precioUnitario ?? it.precioLista) || 0;
      const precioListaItem = Number(it.precioLista ?? it.precioUnitario) || 0;
      const desc = Number(it.descuento) || 0;
      const ivaP = it.iva != null ? Number(it.iva) : 21;

      const brutoCrudo = cantidad * precioUnitario;
      const bonificado = brutoCrudo * (1 - desc / 100);
      // La oferta resta un IMPORTE neto después del descuento porcentual; el
      // tope en 0 evita que una promo mal calculada deje un renglón negativo.
      const ofertaDesc = Math.min(Math.max(0, Number(it.ofertaDescuento) || 0), bonificado);
      const netoCrudo = bonificado - ofertaDesc;
      const bruto = money(brutoCrudo);
      const neto = money(netoCrudo);
      subtotalNeto += neto;
      descuentoTotal += bruto - neto;
      // El IVA sale del neto SIN redondear y se redondea después, igual que
      // `calcularRenglon` del POS: mismo número en la pantalla y en el papel.
      ivaTotal += money((netoCrudo * ivaP) / 100);

      return {
        productoId: it.productoId,
        presentacionId: it.presentacionId ?? null,
        listaId: it.listaId ?? null,
        lista: (it.lista ?? '').trim(),
        listaOrigen: (it.listaOrigen ?? 'base') as any,
        cantidad,
        precioLista: precioListaItem,
        descuento: desc,
        precioUnitario,
        ofertaId: it.ofertaId ?? null,
        oferta: (it.oferta ?? '').trim(),
        ofertaDescuento: money(ofertaDesc),
        /*
         * ESTA FUNCIÓN ARMA EL RENGLÓN CAMPO POR CAMPO, no con un spread. Es a
         * propósito —nada llega a la tabla sin estar nombrado acá— pero tiene su
         * contracara: una columna nueva que no se agregue en esta lista se
         * pierde EN SILENCIO al guardar. Sin estas dos líneas, el descuento se
         * aplicaría al total y el ticket no diría de dónde salió.
         */
        descuentoId: (it as any).descuentoId ?? null,
        descuentoNombre: ((it as any).descuentoNombre ?? '').trim(),
        /* Y sin ESTA, reabrir el borrador devolvería el porcentaje autorizado
         * como si lo hubiera tipeado el vendedor: el autoguardado siguiente lo
         * rebotaría contra el tope y el ticket quedaría trabado. */
        descuentoBase: (it as any).descuentoBase ?? desc,
        /* El costo congelado (0072). `?? null`, no `?? 0`: si un camino no lo
         * resolvió, "sin dato" tiene que quedar como NULL — un cero acá es un
         * margen del 100% inventado en los reportes. */
        costoUnitario: (it as any).costoUnitario ?? null,
        ivaAbsorbidoUnitario: (it as any).ivaAbsorbidoUnitario ?? null,
        porcSinFactura: (it as any).porcSinFactura ?? null,
        iva: ivaP,
        subtotal: money(neto),
      };
    });

    const extras = (extrasDto ?? [])
      .filter((e) => Number(e.importe) > 0)
      .map((e) => {
        const importe = money(e.importe);
        const ivaP = e.iva != null ? Number(e.iva) : 21;
        subtotalNeto += importe;
        ivaTotal += (importe * ivaP) / 100;
        return { concepto: (e.concepto || 'Extra').trim(), importe, iva: ivaP };
      });

    subtotalNeto = money(subtotalNeto);
    ivaTotal = money(ivaTotal);
    return {
      items, extras, subtotalNeto,
      descuentoTotal: money(descuentoTotal),
      ivaTotal,
      total: money(subtotalNeto + ivaTotal),
    };
  }

  /* ------------------------------ Validaciones ------------------------------ */

  /** Al contado los pagos cubren el total exacto; en cta. cte. no hay pagos. */
  private validarPagos(condicionPago: string, pagos: VentaPagoDto[], total: number) {
    const validos = (pagos ?? []).filter((p) => Number(p.importe) > 0);
    if (condicionPago === 'contado') {
      if (!validos.length) throw new BadRequestException('Indicá con qué se paga la venta.');
      const pagado = money(validos.reduce((a, p) => a + Number(p.importe), 0));
      if (Math.abs(pagado - total) > 0.01) {
        throw new BadRequestException(`Los pagos suman $${pagado.toFixed(2)} y el total es $${total.toFixed(2)}.`);
      }
    } else if (validos.length) {
      throw new BadRequestException('Una venta en cuenta corriente no lleva pagos: se cobra con un recibo.');
    }
    return validos;
  }

  /**
   * El precio desbloqueado POR MONTO puede exigir un medio de pago ("mayorista
   * solo en efectivo"). No se puede chequear al cargar el ticket —el medio se
   * elige al cobrar, después de que el precio ya se armó— así que se valida
   * acá, que es el último momento en que todavía se puede rechazar.
   *
   * Solo mira los renglones con `listaOrigen: 'monto'`: los que llegaron por
   * cantidad o por regla de marca se ganaron el precio con volumen y no dependen
   * de cómo se pague.
   */
  /* ---------------------- Facturación electrónica ---------------------- */

  /**
   * LOS RENGLONES DE LA VENTA COMO LOS QUIERE ARCA: neto y alícuota.
   *
   * Los `extras` (envío, packaging) entran igual que la mercadería — son parte
   * del comprobante y cada uno tiene su propia alícuota. Dejarlos afuera haría
   * que las bases no sumen el neto y ARCA rechace todo.
   */
  private renglonesFiscales(items: any[], extras: any[]) {
    return [
      ...(items ?? []).map((it) => ({ neto: Number(it.subtotal) || 0, iva: Number(it.iva) ?? 21 })),
      ...(extras ?? []).map((e) => ({ neto: Number(e.importe) || 0, iva: Number(e.iva) ?? 21 })),
    ].filter((r) => Math.abs(r.neto) > 0.0001);
  }

  /**
   * RESUELVE EL COMPROBANTE FISCAL, con el fallback de ARCA caído (0073/0075).
   *
   * Si lo pedido no es factura, pasa de largo. Si es factura, pide el CAE:
   *   - ARCA contesta → sale la factura con su letra, su CAE y **el número que
   *     dio ARCA** (ver abajo).
   *   - ARCA no contesta, o rechaza → **la venta NO se cae**: sale como ticket
   *     provisorio con `facturarPendiente` y el motivo guardado. El cliente se
   *     lleva su mercadería y el papel fiscal se emite después.
   *   - ARCA apagado → factura interna sin CAE, numeración local, como hasta
   *     hoy. Es la etapa previa y no cambia nada.
   *
   * **EL NÚMERO Y EL PUNTO DE VENTA VIENEN DE ARCA.** No es un detalle: la
   * numeración fiscal la lleva ARCA y un contador local no puede competir con
   * ella. Y el punto de venta de web services es OTRO que el de los tickets
   * internos (tienen numeraciones independientes), así que el comprobante
   * fiscal se guarda con el suyo.
   *
   * Corre ANTES de la transacción de stock, a propósito: un web service lento
   * adentro de una transacción abierta es veneno para toda la caja.
   */
  private async resolverFiscal(
    quiereFactura: boolean,
    cliente: any,
    config: any,
    venta: { total: number; neto: number; iva: number; items: any[]; extras: any[]; fecha?: Date },
    opciones: {
      reservado?: { cbteNro: number; cbteTipo: number } | null;
      reservar?: (nro: number, tipo: number) => Promise<void>;
    } = {},
  ) {
    const vacio = {
      tipo: null as string | null,
      cae: '', caeVencimiento: null as Date | null,
      cbteNro: null as number | null, puntoVenta: null as string | null,
      facturarPendiente: false, facturarMotivo: '',
      facturarCbteNro: null as number | null, facturarCbteTipo: null as number | null,
    };
    if (!quiereFactura) return vacio;

    const letra = letraFacturaPara(cliente, config);

    /*
     * DOS COSAS DISTINTAS, Y HACEN FALTA LAS DOS:
     *
     *   `arcaHabilitado`   la INTENCIÓN — el dueño quiere facturar
     *                      electrónicamente. Vive en la configuración y se
     *                      prende desde una pantalla.
     *   `arca.disponible()` la CAPACIDAD — hay certificado, CUIT y punto de
     *                      venta cargados. Vive en el entorno del servidor.
     *
     * Apagado el interruptor, el comprobante sale con la numeración local y
     * sin CAE: es la etapa previa y no cambia nada de lo que ya funcionaba.
     */
    if (!config.arcaHabilitado) return { ...vacio, tipo: letra };

    /*
     * Prendido pero sin poder: NO se emite una factura sin CAE haciéndose la
     * distraída. Sale el ticket provisorio y el motivo dice exactamente qué
     * falta (`motivoNoDisponible` recorre las cinco causas). Es además el modo
     * ENSAYO: prender el interruptor sin certificado ejercita el circuito de
     * caída completo, que es como se probó.
     */
    if (!this.arca.disponible()) {
      return {
        ...vacio, tipo: 'ticket', facturarPendiente: true,
        facturarMotivo: this.arca.motivo() ?? 'La facturación electrónica no está configurada.',
      };
    }

    const r = await this.arca.emitir({
      tipo: letra,
      receptor: {
        tipoDoc: cliente.tipoDoc,
        numeroDoc: cliente.numeroDoc,
        condicionIva: cliente.condicionIva,
        esConsumidorFinal: !!cliente.esConsumidorFinal,
      },
      renglones: this.renglonesFiscales(venta.items, venta.extras),
      neto: venta.neto,
      iva: venta.iva,
      total: venta.total,
      fecha: venta.fecha,
      reservado: opciones.reservado ?? null,
      reservar: opciones.reservar,
    });

    if (r.ok) {
      return {
        ...vacio,
        tipo: letra,
        cae: r.cae,
        caeVencimiento: r.caeVencimiento,
        cbteNro: r.cbteNro,
        puntoVenta: r.puntoVenta,
      };
    }
    return {
      ...vacio,
      tipo: 'ticket',
      facturarPendiente: true,
      facturarMotivo: r.motivo,
    };
  }

  /**
   * MEDIOS QUE EXIGEN FACTURA (19/8/2026, pedido del dueño). Si un peso del
   * cobro entra por un medio tildado en la configuración, la venta no puede
   * salir como ticket interno: se factura o se cambia el medio. Corre sobre el
   * TIPO PEDIDO, no el emitido — si el cajero pidió factura y ARCA cayó, el
   * ticket provisorio pendiente de facturar cumple el espíritu de la regla
   * (la intención de facturar quedó registrada y el papel sale después).
   * Mira solo los pagos con importe: una transferencia en $0 no obliga a nada.
   *
   * El POS bloquea "Liquidar" con el motivo a la vista; esto es el candado del
   * lado que manda, para el ticket armado por API o un POS desactualizado.
   */
  private validarMediosFacturar(tipo: string, pagos: VentaPagoDto[], config: any) {
    if (tipo !== 'ticket') return;                                   // factura/NC/ND: nada que exigir
    const exigen: string[] = config.mediosFacturar ?? [];
    if (!exigen.length) return;
    const usado = (pagos ?? []).find((p) => Number(p.importe) > 0 && exigen.includes(p.medio));
    if (usado) {
      throw new BadRequestException(
        `El medio "${usado.medio.replace(/_/g, ' ')}" exige factura: esta venta no puede salir como ticket. `
        + 'Facturala (F8) o cobrala con otro medio.',
      );
    }
  }

  private validarMediosPagoMonto(items: any[], condicionPago: string, pagos: VentaPagoDto[], config: any) {
    const permitidos: string[] = config.mediosPagoMonto ?? [];
    if (!permitidos.length) return;                                  // sin restricción
    if (!items.some((it) => it.listaOrigen === 'monto')) return;     // nada que proteger

    const legibles = permitidos.join(' / ');
    if (condicionPago !== 'contado') {
      throw new BadRequestException(
        `El precio por monto de compra solo vale pagando al contado (${legibles}). Quitá el beneficio o cambiá la condición de pago.`,
      );
    }
    const usados = (pagos ?? []).filter((p) => Number(p.importe) > 0).map((p) => p.medio);
    const invalido = usados.find((m) => !permitidos.includes(m));
    if (invalido) {
      throw new BadRequestException(
        `El precio por monto de compra solo vale pagando con ${legibles}. Se está usando "${invalido}".`,
      );
    }
  }

  /**
   * Igual que el precio por monto, una oferta de ticket puede exigir medio de
   * pago ("10% pagando en efectivo"). Se valida al confirmar, que es cuando el
   * medio existe. Las ofertas por cantidad no dependen de cómo se pague.
   */
  private async validarMediosPagoOfertas(items: any[], condicionPago: string, pagos: VentaPagoDto[]) {
    const ids = [...new Set(items.map((it: any) => it.ofertaId).filter(Boolean))] as number[];
    const exigentes = await this.ofertas.ticketConMedios(ids);
    for (const o of exigentes) {
      const permitidos = o.mediosPago.split(',').map((m: string) => m.trim()).filter(Boolean);
      const legibles = permitidos.join(' / ');
      if (condicionPago !== 'contado') {
        throw new BadRequestException(
          `La oferta "${o.nombre}" solo vale pagando al contado (${legibles}). Quitala o cambiá la condición de pago.`,
        );
      }
      const usados = (pagos ?? []).filter((p) => Number(p.importe) > 0).map((p) => p.medio);
      const invalido = usados.find((m) => !permitidos.includes(m));
      if (invalido) {
        throw new BadRequestException(
          `La oferta "${o.nombre}" solo vale pagando con ${legibles}. Se está usando "${invalido}".`,
        );
      }
    }
  }

  /**
   * EL CANDADO DEL MEDIO DE PAGO — decisión del dueño, 14/8/2026.
   *
   * Un descuento puede exigir una forma de pago ("15% pagando en efectivo"). El
   * problema es el ORDEN de las pantallas: el descuento se aplica en el ticket y
   * el medio se elige después, al cobrar. Así que el candado tiene que estar
   * acá, en la confirmación, que es lo último que pasa.
   *
   * Y la regla es ÍNTEGRO, no "que haya algo de ese medio". Sin eso, el POS
   * —que permite pagar con varios medios a la vez— convierte el descuento en
   * algo que se compra: una transferencia de $1 y el resto en efectivo se lleva
   * el 25% sobre toda la venta. Se pide que NINGÚN pago sea de otro medio, que
   * con los importes ya validados contra el total equivale a que el medio
   * exigido lo cubra entero. Varios renglones del mismo medio están bien: son
   * dos billetes, no dos formas de pago.
   *
   * La cuenta corriente no puede cumplirlo: al confirmar no hay ningún pago
   * todavía —la plata entra después, con el recibo— así que no hay nada que
   * verificar. Se rechaza en vez de dejarlo pasar sin control.
   */
  private validarMediosPagoDescuentos(
    items: any[],
    condicionPago: string,
    pagos: VentaPagoDto[],
    /* Iterable y no el Map por lista: el alta lo tiene armado, pero la
     * CONFIRMACIÓN —que es por donde cobra la caja— parte de renglones ya
     * guardados y los lee de la base. Los dos caminos tienen que pasar por
     * este mismo candado. */
    aplicables: Iterable<{ id: number; nombre: string; medioPago: string | null }>,
  ) {
    // Solo los que de verdad GANARON en algún renglón: uno que quedó tapado por
    // el descuento del cliente no bajó un peso, y no tiene por qué condicionar
    // con qué se paga.
    const aplicados = new Set(items.map((it: any) => it.descuentoId).filter(Boolean) as number[]);
    if (!aplicados.size) return;

    for (const d of aplicables) {
      if (!d.medioPago || !aplicados.has(d.id)) continue;
      if (condicionPago !== 'contado') {
        throw new BadRequestException(
          `El descuento "${d.nombre}" solo vale pagando al contado con ${d.medioPago}. `
          + 'Quitalo o cambiá la condición de pago.',
        );
      }
      const otro = (pagos ?? []).find((p) => Number(p.importe) > 0 && p.medio !== d.medioPago);
      if (otro) {
        throw new BadRequestException(
          `El descuento "${d.nombre}" exige que TODA la venta se pague con ${d.medioPago}, `
          + `y se está usando "${otro.medio}". Sacá el descuento o cobrá todo con ${d.medioPago}.`,
        );
      }
    }
  }

  /**
   * LO QUE SE REVISA DE LOS DESCUENTOS CON NOMBRE AL COBRAR UN BORRADOR.
   *
   * Las seis validaciones de `resolverDescuentos` ya corrieron al guardar. Acá
   * se miran las dos cosas que solo se pueden saber ahora:
   *
   *   · EL MEDIO DE PAGO, que se elige recién en el modal de cobro.
   *   · LA VIGENCIA, porque un ticket puede quedar abierto horas. Sin esto, un
   *     ticket armado a las 23:50 y cobrado a las 00:10 se lleva el descuento de
   *     ayer con el porcentaje ya congelado en el renglón.
   *
   * El mensaje del vencido dice qué hacer, y el POS acompaña: en su desplegable
   * ese descuento ya figura vencido, así que quitarlo es un clic y el
   * autoguardado devuelve los renglones a su precio.
   */
  private async validarDescuentosAlCobrar(items: any[], condicionPago: string, pagos: VentaPagoDto[]) {
    const ids = [...new Set(items.map((it: any) => it.descuentoId).filter(Boolean) as number[])];
    if (!ids.length) return;
    const filas = await this.db.select().from(descuentos).where(inArray(descuentos.id, ids));
    const ahora = Date.now();
    for (const d of filas) {
      if (d.vence && d.vence.getTime() < ahora) {
        throw new BadRequestException(
          `El descuento "${d.nombre}" venció y este ticket todavía lo tiene aplicado. `
          + 'Quitalo del ticket y volvé a cobrar.',
        );
      }
    }
    this.validarMediosPagoDescuentos(items, condicionPago, pagos, filas);
  }

  private async validarCredito(cliente: any, config: any, condicionPago: string, total: number) {
    if (condicionPago !== 'cuenta_corriente') return;
    if (!config.ctaCteHabilitada) throw new BadRequestException('La venta en cuenta corriente está deshabilitada en la configuración.');
    if (!cliente.ctaCteHabilitada) throw new BadRequestException(`${cliente.nombre} no tiene cuenta corriente habilitada.`);
    if (config.ctaCteBloquearSuperado && cliente.limiteCredito > 0) {
      const { saldo } = await this.cuenta(cliente.id);
      if (saldo + total > cliente.limiteCredito + 1e-9) {
        throw new BadRequestException(
          `Supera el límite de crédito. Saldo $${saldo.toFixed(2)} + $${total.toFixed(2)} > límite $${cliente.limiteCredito.toFixed(2)}.`,
        );
      }
    }
  }

  /**
   * Turno de caja. Se exige solo al CONTADO: es la venta que mueve dinero
   * físico y por lo tanto la que hay que arquear. Una venta en cuenta corriente
   * no toca el cajón (el efectivo entra después, con el recibo), así que no
   * debería frenarse por no haber abierto caja — igual se cuelga del turno
   * abierto si lo hay, para que aparezca en el arqueo.
   */
  private async resolverTurno(cajaSesionId: number | undefined, sucursalId: number, condicionPago: string, config: any) {
    // El id que manda el punto de venta es solo una PISTA: pudo quedar viejo
    // (se cerró la caja en otra pantalla, se resembró la base). Si no sirve, se
    // resuelve por sucursal en vez de hacer fracasar el cobro con un
    // "turno inexistente" que el cajero no puede interpretar.
    if (cajaSesionId) {
      const sugerido = await this.caja.getOpcional(cajaSesionId);
      if (sugerido && sugerido.estado === 'abierta' && sugerido.sucursalId === sucursalId) return sugerido;
    }
    return this.caja.exigirTurno(sucursalId, condicionPago === 'contado' && !!config.cajaObligatoria);
  }

  /** Correlativo siguiente para ese tipo y punto de venta. */
  private async siguienteNumero(tx: any, tipo: string, puntoVenta: string) {
    const [r] = await tx
      .select({ max: sql<number>`coalesce(max(${ventas.numero}), 0)` })
      .from(ventas)
      .where(and(eq(ventas.tipo, tipo as any), eq(ventas.puntoVenta, puntoVenta)));
    return (Number(r?.max) || 0) + 1;
  }

  /* ------------------------------ Escritura ------------------------------ */

  /**
   * "SOLO PARA FRACCIONAR": el granel marcado así no se vende suelto — existe
   * únicamente para convertirse en paquetes (la Pimienta de Jamaica llega 1 kg
   * y se fracciona entera). El POS ya no lo ofrece suelto; este es el candado
   * de verdad, porque lo que se acepta no puede depender de lo que se ofrece.
   * Sus presentaciones se venden normal (llevan presentacionId).
   */
  private async validarSoloFraccionar(items: Array<{ productoId: number; presentacionId?: number | null }>) {
    const sueltos = [...new Set((items ?? []).filter((it) => !it.presentacionId).map((it) => it.productoId))];
    if (!sueltos.length) return;
    const [prohibido] = await this.db.select({ nombre: productos.nombre }).from(productos)
      .where(and(inArray(productos.id, sueltos), eq(productos.soloFraccionar, true))).limit(1);
    if (prohibido) {
      throw new BadRequestException(
        `${prohibido.nombre} no se vende suelto: es solo para fraccionar. Vendé sus paquetes.`,
      );
    }
  }

  /**
   * ARCHIVADO no se vende. El DISCONTINUADO sí: dejó de comprarse pero lo que
   * queda en góndola se termina de vender — es la razón de que sean dos estados
   * y no un interruptor. El candado va acá y no solo en el catálogo del POS,
   * porque el catálogo se cachea al abrir la caja: un producto archivado en el
   * medio del turno seguiría estando en la pantalla del cajero.
   */
  private async validarEstadoVendible(items: Array<{ productoId: number }>) {
    const ids = [...new Set((items ?? []).map((it) => it.productoId))];
    if (!ids.length) return;
    const [archivado] = await this.db.select({ nombre: productos.nombre }).from(productos)
      .where(and(inArray(productos.id, ids), eq(productos.estado, 'archivado'))).limit(1);
    if (archivado) {
      throw new BadRequestException(
        `${archivado.nombre} está archivado: ya no se vende. Si volvió a entrar, reactivalo en Compras › Productos.`,
      );
    }
  }

  /**
   * `opciones` es lo que el CONTROLLER resolvió de la sesión, y no puede venir
   * del body: la sucursal donde se vende y si esta persona puede pisar precios.
   */
  async create(dto: CreateVentaDto, opciones: OpcionesVenta = {}) {
    const config = await this.cfg.get('ventas');
    const cliente = dto.clienteId ? await this.cli.get(dto.clienteId) : await this.cli.consumidorFinal();
    if (!cliente.activo) throw new BadRequestException('El cliente está desactivado.');

    const esBorrador = dto.estado === 'borrador';
    if (!esBorrador && !dto.items?.length) throw new BadRequestException('Agregá al menos un ítem.');

    // También en el borrador: un ticket que nunca va a poder confirmarse no
    // tiene por qué poder armarse.
    await this.validarSoloFraccionar(dto.items ?? []);
    await this.validarEstadoVendible(dto.items ?? []);

    // La sucursal se resuelve ANTES del portero: el presupuesto que el ticket
    // dice cerrar se valida contra ella.
    const sucursalId = opciones.sucursalSesion ?? cliente.sucursalId ?? null;
    if (!sucursalId) throw new BadRequestException('Indicá la sucursal de la venta.');

    /* El portero corre TAMBIÉN en el borrador: el precio del renglón se guarda
     * al armarlo, y `confirmar` cobra lo que está guardado sin recalcular. Si
     * solo se validara al confirmar, el precio inventado ya estaría adentro. */
    const congelados = await this.congeladosDePresupuesto(dto.presupuestoId, cliente.id, sucursalId);
    /*
     * La sucursal sale de la resuelta arriba (sesión), y el permiso para los
     * descuentos que piden admin es `precio_manual`: el mismo que ya levanta el
     * tope de descuento. Quien puede tipear 25% a mano no gana nada nuevo
     * eligiéndolo de una lista, y al revés —dejarlo tipear pero no elegir— sería
     * una incoherencia que además empuja a hacerlo por el camino sin rastro.
     */
    const descuentosPorLista = await this.resolverDescuentos(
      dto.descuentos, sucursalId, !!opciones.puedePisarPrecio,
    );
    const items = await this.resolverRenglones(
      dto.items ?? [], cliente, config, !!opciones.puedePisarPrecio, congelados, descuentosPorLista,
    );
    const tot = this.calcularTotales(items, dto.extras ?? []);
    const condicionPago = dto.condicionPago ?? 'contado';
    /*
     * TOTAL POSITIVO. Con el IVA del producto ya no puede dar negativo, pero un
     * ticket de $0 igual no es una venta: es mercadería que sale sin cobrarse.
     * Una devolución se hace con nota de crédito, no con un total en cero.
     */
    if (!esBorrador && !(tot.total > 0)) {
      throw new BadRequestException('El total de la venta tiene que ser mayor a 0.');
    }

    const tipo = dto.tipo ?? (tipoVentaPara(cliente, config) as (typeof TIPOS)[number]);
    const puntoVenta = String(config.puntoVenta || '0001');
    /*
     * LA FECHA es AHORA, salvo para un jefe. Un cajero podía emitir un ticket
     * fechado dos meses atrás y colgarlo del turno abierto de hoy: quedaba fuera
     * de cualquier corte por fecha y adentro del arqueo de hoy. Y una fecha
     * inválida (`"chau"`) llegaba como `Invalid Date` al insert y salía un 500.
     */
    const fecha = fechaDeDocumento(dto.fecha, !!opciones.esJefe);

    /* -- Borrador: queda abierto, sin número, sin stock, sin caja -- */
    if (esBorrador) {
      const [v] = await this.db.insert(ventas).values({
        tipo, puntoVenta, numero: null, fecha, clienteId: cliente.id, sucursalId,
        usuarioId: dto.usuarioId ?? null, cajaSesionId: null,
        estado: 'borrador', condicionPago, vencimientoPago: null,
        presupuestoId: dto.presupuestoId ?? null,
        listaPrecio: dto.listaPrecio ?? '',
        subtotalNeto: tot.subtotalNeto, descuentoTotal: tot.descuentoTotal,
        ivaTotal: tot.ivaTotal, total: tot.total,
        observaciones: dto.observaciones ?? '',
      }).returning();

      if (tot.items.length) await this.db.insert(ventaItems).values(tot.items.map((it) => ({ ...it, ventaId: v.id })));
      if (tot.extras.length) await this.db.insert(ventaExtras).values(tot.extras.map((e) => ({ ...e, ventaId: v.id })));
      return this.get(v.id);
    }

    /* -- Confirmada de una: el camino de la API y del seed -- */
    const pagos = this.validarPagos(condicionPago, dto.pagos ?? [], tot.total);
    // Sobre el tipo PEDIDO: si se pidió factura y ARCA cae, el ticket
    // provisorio pendiente cumple la regla (la intención quedó registrada).
    this.validarMediosFacturar(tipo, pagos, config);
    this.validarMediosPagoMonto(tot.items, condicionPago, pagos, config);
    await this.validarMediosPagoOfertas(tot.items, condicionPago, pagos);
    this.validarMediosPagoDescuentos(tot.items, condicionPago, pagos, descuentosPorLista.values());
    await this.validarCredito(cliente, config, condicionPago, tot.total);
    const turno = await this.resolverTurno(dto.cajaSesionId, sucursalId, condicionPago, config);

    /* ARCA, ANTES de la transacción (0073): si se pidió factura y el servicio
     * no contesta, la venta sale como ticket provisorio pendiente — no se cae.
     *
     * Este camino (venta confirmada de una) es el de la API y el seed, NO el
     * de la caja: acá no hay fila previa donde reservar el número, así que la
     * red contra la respuesta perdida es la consulta inmediata que hace
     * `ArcaService`. El camino del mostrador —`confirmar()`— sí reserva. */
    const fiscal = await this.resolverFiscal(String(tipo).startsWith('factura'), cliente, config, {
      total: tot.total, neto: tot.subtotalNeto, iva: tot.ivaTotal,
      items: tot.items, extras: tot.extras, fecha,
    });
    const tipoFinal = (fiscal.tipo ?? tipo) as (typeof TIPOS)[number];
    const puntoVentaFinal = fiscal.puntoVenta ?? puntoVenta;

    const vencimientoPago = condicionPago === 'cuenta_corriente' && cliente.diasPlazo > 0
      ? new Date(fecha.getTime() + cliente.diasPlazo * 86400000)
      : null;

    const id = await this.db.transaction(async (tx) => {
      // Con CAE el número lo dio ARCA; sin CAE sigue el correlativo local.
      const numero = fiscal.cbteNro ?? await this.siguienteNumero(tx, tipoFinal, puntoVentaFinal);
      const [v] = await tx.insert(ventas).values({
        tipo: tipoFinal, puntoVenta: puntoVentaFinal, numero, fecha, clienteId: cliente.id, sucursalId,
        usuarioId: dto.usuarioId ?? null, cajaSesionId: turno?.id ?? null,
        estado: 'confirmada', condicionPago, vencimientoPago,
        presupuestoId: dto.presupuestoId ?? null,
        listaPrecio: dto.listaPrecio ?? '',
        subtotalNeto: tot.subtotalNeto, descuentoTotal: tot.descuentoTotal,
        ivaTotal: tot.ivaTotal, total: tot.total,
        cae: fiscal.cae, caeVencimiento: fiscal.caeVencimiento,
        facturarPendiente: fiscal.facturarPendiente, facturarMotivo: fiscal.facturarMotivo,
        observaciones: dto.observaciones ?? '',
      }).returning();

      await tx.insert(ventaItems).values(tot.items.map((it) => ({ ...it, ventaId: v.id })));
      if (tot.extras.length) await tx.insert(ventaExtras).values(tot.extras.map((e) => ({ ...e, ventaId: v.id })));
      if (pagos.length) {
        await tx.insert(ventaPagos).values(pagos.map((p) => ({
          ventaId: v.id, medio: p.medio, importe: money(p.importe), referencia: p.referencia ?? '',
        })));
      }

      if (dto.presupuestoId) {
        await this.cerrarPresupuesto(tx, Number(dto.presupuestoId), v.id, sucursalId, cliente.id, dto.usuarioId);
      }

      await this.inv.egresarStockItems(tx, {
        sucursalId,
        usuarioId: dto.usuarioId,
        permitirNegativo: !!config.permitirStockNegativo,
        descripcion: `Venta ${puntoVenta}-${String(numero).padStart(8, '0')} · ${cliente.nombre}`,
        items: tot.items,
      });
      return v.id;
    });

    return this.get(id);
  }

  /**
   * Venta que CIERRA un presupuesto (dentro de la transacción de la venta):
   * reclama el estado — dos cierres simultáneos → uno gana — y LIBERA la
   * reserva ANTES del egreso, así la mercadería apartada vuelve a disponible
   * y sale por la venta, aunque el cajero haya agregado o sacado renglones
   * respecto de lo cotizado.
   */
  private async cerrarPresupuesto(
    tx: any, presupuestoId: number, ventaId: number, sucursalId: number,
    clienteId: number, usuarioId?: number | null,
  ) {
    const [pre] = await tx.select().from(presupuestos).where(eq(presupuestos.id, presupuestoId)).limit(1);
    if (!pre) throw new BadRequestException('El presupuesto ya no existe.');
    if (pre.estado !== 'confirmado') throw new BadRequestException('Solo se cierra un presupuesto confirmado — actualizá la pantalla.');
    /*
     * EL PRESUPUESTO TIENE QUE SER DE ESTE CLIENTE Y DE ESTA SUCURSAL.
     *
     * No se verificaba ninguna de las dos, y `presupuestoId` viaja en el body:
     * un ticket de $1 a Consumidor Final con `presupuestoId: 57` cerraba el
     * pedido de $480.000 de otro — desaparecía de la bandeja de armado, quedaba
     * apuntando a esa venta de un peso, y los 300 kg reservados volvían a
     * disponible para que los comprara cualquiera.
     *
     * La de sucursal era peor todavía, porque fallaba en SILENCIO: la reserva se
     * liberaba con la sucursal de la VENTA, así que un pedido reservado en
     * Fontana y cerrado desde otra caja liberaba stock donde no había nada
     * comprometido —`move()` devuelve `false` y nadie mira el retorno— y la
     * mercadería de Fontana quedaba apartada para siempre, sin ningún documento
     * abierto que explicara por qué.
     */
    if (pre.clienteId !== clienteId) {
      throw new BadRequestException('Ese presupuesto es de otro cliente.');
    }
    if (pre.sucursalId !== sucursalId) {
      throw new BadRequestException(
        'Ese presupuesto se cotizó en otra sucursal: tiene la mercadería reservada allá. '
        + 'Cerralo desde esa caja.',
      );
    }
    const gano = await tx.update(presupuestos)
      .set({ estado: 'cerrado', ventaId })
      .where(and(eq(presupuestos.id, pre.id), eq(presupuestos.estado, 'confirmado')))
      .returning({ id: presupuestos.id });
    if (!gano.length) throw new BadRequestException('El presupuesto cambió de estado — actualizá la pantalla.');
    if (pre.reservado) {
      const preItems = await tx.select().from(presupuestoItems)
        .where(eq(presupuestoItems.presupuestoId, pre.id));
      // Con la sucursal DEL PRESUPUESTO: es donde está lo comprometido.
      await this.inv.reservarItems(tx, {
        sucursalId: pre.sucursalId, usuarioId: usuarioId ?? null, liberar: true,
        descripcion: `${pre.codigo}: cerrado en venta`,
        items: preItems,
      });
    }
  }

  /** Solo un borrador se edita: una venta emitida se anula o se corrige por NC. */
  private async exigirBorrador(id: number) {
    const v = await this.get(id);
    if (v.estado !== 'borrador') {
      throw new BadRequestException('La venta ya está emitida: no se puede modificar.');
    }
    return v;
  }

  /**
   * Reemplaza el contenido del borrador. El punto de venta lo llama con el
   * ticket completo (no con un delta): así el estado del servidor siempre es
   * exactamente lo que el cajero ve en pantalla.
   */
  async actualizar(id: number, dto: CreateVentaDto, opciones: OpcionesVenta = {}) {
    const actual = await this.exigirBorrador(id);
    if (opciones.soloSuSucursal && actual.sucursalId !== opciones.soloSuSucursal) {
      throw new ForbiddenException('Ese ticket es de otra sucursal.');
    }
    const config = await this.cfg.get('ventas');
    const cliente = dto.clienteId ? await this.cli.get(dto.clienteId) : await this.cli.get(actual.clienteId);
    /* Mismo portero que en el alta: el borrador se edita en cada tecla del POS y
     * es de donde `confirmar` toma los precios sin volver a calcularlos. El
     * presupuesto sale del BORRADOR GUARDADO y no del DTO: el cajero sigue
     * editando el ticket, y el documento que lo respalda no se cambia tecleando. */
    const congelados = await this.congeladosDePresupuesto(actual.presupuestoId ?? undefined, cliente.id, actual.sucursalId);
    /* La sucursal es la de la VENTA que se edita, no la de la sesión: un jefe
     * corrigiendo desde Centro un ticket de Fontana no puede colarle un
     * descuento de Centro. */
    const descuentosPorLista = await this.resolverDescuentos(
      dto.descuentos, actual.sucursalId, !!opciones.puedePisarPrecio,
      /* Los que el ticket YA traía: el permiso se pide para aplicar, no para
       * seguir trabajando sobre un ticket que un admin autorizó recién. */
      new Set((actual.items ?? []).map((it: any) => it.descuentoId).filter(Boolean) as number[]),
    );
    const items = await this.resolverRenglones(
      dto.items ?? [], cliente, config, !!opciones.puedePisarPrecio, congelados, descuentosPorLista,
    );
    const tot = this.calcularTotales(items, dto.extras ?? []);

    await this.db.transaction(async (tx) => {
      await tx.update(ventas).set({
        clienteId: cliente.id,
        usuarioId: dto.usuarioId ?? actual.usuarioId,
        condicionPago: dto.condicionPago ?? actual.condicionPago,
        listaPrecio: dto.listaPrecio ?? '',
        observaciones: dto.observaciones ?? actual.observaciones,
        subtotalNeto: tot.subtotalNeto, descuentoTotal: tot.descuentoTotal,
        ivaTotal: tot.ivaTotal, total: tot.total,
      }).where(eq(ventas.id, id));

      await tx.delete(ventaItems).where(eq(ventaItems.ventaId, id));
      await tx.delete(ventaExtras).where(eq(ventaExtras.ventaId, id));
      if (tot.items.length) await tx.insert(ventaItems).values(tot.items.map((it) => ({ ...it, ventaId: id })));
      if (tot.extras.length) await tx.insert(ventaExtras).values(tot.extras.map((e) => ({ ...e, ventaId: id })));
    });

    return this.get(id);
  }

  /**
   * Cierra el borrador: recién acá se asigna número, se descuenta stock y se
   * registran los pagos. Los ítems son los que ya están guardados, para que lo
   * que se confirma sea exactamente lo último que se guardó.
   */
  async confirmar(id: number, dto: ConfirmarVentaDto, opciones: OpcionesVenta = {}) {
    const borrador = await this.exigirBorrador(id);
    if (opciones.soloSuSucursal && borrador.sucursalId !== opciones.soloSuSucursal) {
      throw new ForbiddenException('Ese ticket es de otra sucursal.');
    }
    if (!borrador.items.length) throw new BadRequestException('El ticket está vacío.');
    // El borrador pudo nacer antes de que el producto se marcara "solo para
    // fraccionar" o se archivara: se re-valida acá, que es donde el stock sale.
    await this.validarSoloFraccionar(borrador.items);
    await this.validarEstadoVendible(borrador.items);

    const config = await this.cfg.get('ventas');
    const cliente = await this.cli.get(borrador.clienteId);
    const condicionPago = dto.condicionPago ?? borrador.condicionPago;
    const sucursalId = borrador.sucursalId!;

    const pagos = this.validarPagos(condicionPago, dto.pagos ?? [], borrador.total);
    this.validarMediosPagoMonto(borrador.items, condicionPago, pagos, config);
    await this.validarMediosPagoOfertas(borrador.items, condicionPago, pagos);
    /*
     * LOS DESCUENTOS CON NOMBRE, RELEÍDOS DE LA BASE.
     *
     * Este es EL camino de la caja: el POS guarda el borrador y después cobra
     * por acá. El candado del medio de pago tiene que correr en los dos lados —
     * si viviera solo en el alta, la regla que pidió el dueño ("si exige un
     * medio, se bloquea ese medio y se avisa") no se aplicaría nunca donde de
     * verdad se cobra.
     *
     * Y se releen en vez de creerle al renglón porque entre el último
     * autoguardado y el cobro pueden pasar horas: el descuento pudo vencer, o el
     * dueño pudo agregarle una forma de pago. Lo que vale es lo de ahora.
     */
    await this.validarDescuentosAlCobrar(borrador.items, condicionPago, pagos);
    await this.validarCredito(cliente, config, condicionPago, borrador.total);
    const turno = await this.resolverTurno(dto.cajaSesionId, sucursalId, condicionPago, config);

    const fecha = new Date();
    const vencimientoPago = condicionPago === 'cuenta_corriente' && cliente.diasPlazo > 0
      ? new Date(fecha.getTime() + cliente.diasPlazo * 86400000)
      : null;

    // Liquidar o facturar. Cada tipo lleva su propio correlativo (el índice
    // único es por tipo + punto de venta), que es como debe ser fiscalmente.
    const pedido = dto.tipo === 'factura'
      ? (letraFacturaPara(cliente, config) as any)
      : dto.tipo === 'ticket' ? 'ticket' : borrador.tipo;
    // Sobre el tipo PEDIDO: un medio marcado "exige factura" no puede salir en
    // ticket a propósito — pero si se pidió factura y ARCA cae, el provisorio
    // pendiente cumple la regla. Este es EL camino de la caja.
    this.validarMediosFacturar(pedido, pagos, config);

    /* ARCA, ANTES de la transacción (0073): pedir el CAE con la caja esperando
     * es inevitable; hacerlo con la transacción de stock abierta, no. Si el
     * servicio no contesta, la venta sale igual como ticket provisorio.
     *
     * ESTE ES EL CAMINO DEL MOSTRADOR, y el único donde hay una fila previa
     * (el borrador): por eso acá SÍ se reserva el número antes de pedir el
     * CAE. Si el proceso muere con el pedido en vuelo, el rastro queda y el
     * reintento consulta ese número en vez de emitir una segunda factura. */
    const fiscal = await this.resolverFiscal(String(pedido).startsWith('factura'), cliente, config, {
      total: borrador.total, neto: borrador.subtotalNeto, iva: borrador.ivaTotal,
      items: borrador.items, extras: borrador.extras, fecha,
    }, {
      reservar: async (nro, cbteTipo) => {
        await this.db.update(ventas)
          .set({ facturarCbteNro: nro, facturarCbteTipo: cbteTipo })
          .where(eq(ventas.id, id));
      },
    });
    const tipo = (fiscal.tipo ?? pedido) as any;
    const puntoVentaFinal = fiscal.puntoVenta ?? borrador.puntoVenta;

    await this.db.transaction(async (tx) => {
      // Con CAE el número lo dio ARCA; sin CAE sigue el correlativo local.
      const numero = fiscal.cbteNro ?? await this.siguienteNumero(tx, tipo, puntoVentaFinal);
      await tx.update(ventas).set({
        tipo, numero, fecha, estado: 'confirmada', condicionPago, vencimientoPago,
        puntoVenta: puntoVentaFinal,
        cae: fiscal.cae, caeVencimiento: fiscal.caeVencimiento,
        facturarPendiente: fiscal.facturarPendiente, facturarMotivo: fiscal.facturarMotivo,
        /* La reserva se limpia al cerrar bien: si quedó pendiente, el número
         * SOBREVIVE para que el reintento pueda consultarlo. */
        facturarCbteNro: fiscal.facturarPendiente ? undefined : null,
        facturarCbteTipo: fiscal.facturarPendiente ? undefined : null,
        cajaSesionId: turno?.id ?? null,
        /*
         * LA VENTA ES DE QUIEN LA ARMÓ, y quien la cobró va aparte (0060).
         *
         * Esta línea decía `dto.usuarioId ?? borrador.usuarioId`, o sea que la
         * intención estaba escrita: respetar al vendedor del borrador. Pero el
         * `AutorInterceptor` pone `body.usuarioId` con el de la sesión en TODAS
         * las escrituras, así que `dto.usuarioId` nunca es `undefined` y el `??`
         * nunca caía del otro lado. Marta armaba el ticket toda la mañana, Juan
         * apretaba F2 para cobrarlo porque Marta fue al baño, y la venta quedaba
         * a nombre de Juan: en el listado, en los reportes por vendedor y en el
         * movimiento de stock. Con comisiones por vendedor, es plata.
         */
        usuarioId: borrador.usuarioId ?? dto.usuarioId ?? null,
        cobradoPor: dto.usuarioId ?? null,
        observaciones: dto.observaciones ?? borrador.observaciones,
      }).where(eq(ventas.id, id));

      if (pagos.length) {
        await tx.insert(ventaPagos).values(pagos.map((p) => ({
          ventaId: id, medio: p.medio, importe: money(p.importe), referencia: p.referencia ?? '',
        })));
      }

      // El borrador nació de un presupuesto: este cobro lo cierra.
      if (borrador.presupuestoId) {
        await this.cerrarPresupuesto(tx, borrador.presupuestoId, id, sucursalId, cliente.id, dto.usuarioId ?? borrador.usuarioId);
      }

      await this.inv.egresarStockItems(tx, {
        sucursalId,
        // Acá sí va QUIEN COBRÓ: es el que ejecutó el movimiento de stock.
        usuarioId: dto.usuarioId ?? borrador.usuarioId,
        permitirNegativo: !!config.permitirStockNegativo,
        descripcion: `Venta ${borrador.puntoVenta}-${String(numero).padStart(8, '0')} · ${cliente.nombre}`,
        items: borrador.items,
      });
    });

    return this.get(id);
  }

  /**
   * FACTURA UNA VENTA QUE QUEDÓ PENDIENTE (0073) — el botón "Facturar" de la
   * pestaña Sin facturar.
   *
   * El ticket provisorio ya movió el stock, cobró la plata y cerró el turno:
   * acá NO se toca nada de eso. Lo único que pasa es la emisión del papel
   * fiscal: se pide el CAE de nuevo y, si ARCA contesta, la venta PASA A SER
   * la factura — letra según el cliente de hoy, número nuevo de la serie de
   * facturas (el correlativo fiscal no puede tener agujeros), y el rastro del
   * provisorio queda escrito en las observaciones. Si ARCA sigue caído, el
   * error dice por qué y la venta sigue en la pestaña — reintentar no rompe
   * nada, se puede apretar mil veces.
   */
  async facturarAhora(id: number, opciones: OpcionesVenta = {}) {
    const [v] = await this.db.select().from(ventas).where(eq(ventas.id, id)).limit(1);
    if (!v) throw new NotFoundException('Esa venta no existe.');
    if (opciones.soloSuSucursal && v.sucursalId !== opciones.soloSuSucursal) {
      throw new ForbiddenException('Esa venta es de otra sucursal.');
    }
    if (v.estado !== 'confirmada') {
      throw new BadRequestException('Solo se factura una venta confirmada (esta está anulada o en borrador).');
    }
    if (!v.facturarPendiente) {
      throw new BadRequestException('Esta venta no está pendiente de facturar.');
    }

    const config = await this.cfg.get('ventas');
    const cliente = await this.cli.get(v.clienteId);
    const completa = await this.get(id);

    const fiscal = await this.resolverFiscal(true, cliente, config, {
      total: v.total, neto: v.subtotalNeto, iva: v.ivaTotal,
      items: completa.items, extras: completa.extras,
      /* La fecha del comprobante es la de HOY, no la de la venta: ARCA solo
       * acepta ±5 días para Concepto 1, y un provisorio de la semana pasada ya
       * quedó fuera de esa ventana. La fecha real de la operación no se pierde
       * — sigue en `fecha`, y el rastro queda en observaciones. */
      fecha: new Date(),
    }, {
      /* LA RECUPERACIÓN: si quedó un número reservado de un intento anterior,
       * se consulta ANTES de emitir. Si ese comprobante ya salió con nuestros
       * importes, se adopta su CAE en vez de emitir una segunda factura. */
      reservado: v.facturarCbteNro && v.facturarCbteTipo
        ? { cbteNro: v.facturarCbteNro, cbteTipo: v.facturarCbteTipo }
        : null,
      reservar: async (nro, cbteTipo) => {
        await this.db.update(ventas)
          .set({ facturarCbteNro: nro, facturarCbteTipo: cbteTipo })
          .where(eq(ventas.id, id));
      },
    });

    if (fiscal.facturarPendiente) {
      // Se guarda el motivo NUEVO: el de hace una hora puede no ser el de ahora.
      await this.db.update(ventas)
        .set({ facturarMotivo: fiscal.facturarMotivo })
        .where(eq(ventas.id, id));
      throw new BadRequestException(`No se pudo facturar: ${fiscal.facturarMotivo}`);
    }
    if (!fiscal.tipo || fiscal.tipo === 'ticket') {
      throw new BadRequestException(
        'La facturación electrónica está apagada: no hay con qué emitir el comprobante fiscal.',
      );
    }

    const provisorio = `${v.puntoVenta}-${String(v.numero ?? 0).padStart(8, '0')}`;
    const puntoVentaFinal = fiscal.puntoVenta ?? v.puntoVenta;
    await this.db.transaction(async (tx) => {
      const numero = fiscal.cbteNro ?? await this.siguienteNumero(tx, fiscal.tipo!, puntoVentaFinal);
      await tx.update(ventas).set({
        tipo: fiscal.tipo as any, numero, puntoVenta: puntoVentaFinal,
        cae: fiscal.cae, caeVencimiento: fiscal.caeVencimiento,
        facturarPendiente: false, facturarMotivo: '',
        facturarCbteNro: null, facturarCbteTipo: null,
        /* El rastro del provisorio: sin esto, el ticket de papel que se llevó
         * el cliente apunta a un comprobante que ya no existe con ese número. */
        observaciones: `${v.observaciones ? `${v.observaciones}\n` : ''}`
          + `[Facturada: era el ticket provisorio ${provisorio} — ${v.facturarMotivo || 'ARCA no disponible'}]`,
      }).where(eq(ventas.id, id));
    });
    return this.get(id);
  }

  /**
   * Pasa la venta abierta a otro vendedor (cambio de turno, mostrador ocupado).
   *
   * DOS candados, no tres. Este comentario prometía un tercero —"y en la misma
   * sucursal"— que el modelo no puede sostener: `usuarios` NO tiene sucursal,
   * porque la sucursal vive en la SESIÓN (es lo que permite que el mismo
   * empleado atienda hoy en Express 2 y mañana en la Distribuidora). Así que se
   * puede firmar el ticket a nombre de alguien que hoy está en otro mostrador.
   * El daño es acotado —el borrador no se mueve de esta sucursal, así que el
   * otro no puede retomarlo— pero es plantarle un ticket a un compañero.
   *
   * Cerrarlo de verdad pide decidir el modelo (¿el empleado tiene sucursal fija,
   * o se mira su última sesión?), y eso es del dueño. Queda anotado en /info; lo
   * que NO queda es un comentario diciendo que está resuelto.
   *
   * Los dos que sí están: el borrador tiene que ser de esta sucursal (o quien
   * pide es jefe), y el destinatario tiene que estar activo — sin eso se le
   * robaba el ticket a otro cajero y se le firmaba a un empleado dado de baja.
   */
  async delegar(id: number, usuarioId: number, opciones: OpcionesVenta = {}) {
    const borrador = await this.exigirBorrador(id);
    if (opciones.soloSuSucursal && borrador.sucursalId !== opciones.soloSuSucursal) {
      throw new ForbiddenException('Ese ticket es de otra sucursal.');
    }
    const [u] = await this.db.select().from(usuarios).where(eq(usuarios.id, usuarioId)).limit(1);
    if (!u) throw new BadRequestException('Usuario inexistente.');
    if (!u.activo) throw new BadRequestException(`${u.nombre} está dado de baja: no se le puede pasar el ticket.`);
    await this.db.update(ventas).set({ usuarioId }).where(eq(ventas.id, id));
    return this.get(id);
  }

  /**
   * Descarta un borrador. No dejó rastro en stock ni en numeración.
   *
   * Solo el de la propia sucursal: es un `delete` real, y un loop sobre los ids
   * que devuelve `GET /ventas?estado=borrador` limpiaba los tickets abiertos de
   * todas las cajas en el momento de más gente.
   */
  async descartar(id: number, opciones: OpcionesVenta = {}) {
    const borrador = await this.exigirBorrador(id);
    if (opciones.soloSuSucursal && borrador.sucursalId !== opciones.soloSuSucursal) {
      throw new ForbiddenException('Ese ticket es de otra sucursal.');
    }
    await this.db.delete(ventas).where(eq(ventas.id, id));
    return { ok: true };
  }

  /**
   * ANULACIÓN — la operación más delicada del módulo.
   *
   * Devuelve la mercadería al stock y saca la venta del arqueo: el turno deja de
   * esperar esa plata. En una venta al contado eso es exactamente la forma de
   * tapar un faltante — a las 10 se vende $50.000 en efectivo, a las 19:55 se
   * anula, el esperado baja $50.000, el stock vuelve (así que el inventario
   * también cuadra) y el cierre da diferencia 0. Por eso:
   *
   *  - pide el permiso `devoluciones` (en el controller);
   *  - guarda QUIÉN, CUÁNDO y POR QUÉ (0059), y el usuario llega hasta el
   *    movimiento de reingreso de stock — antes el controller no lo pasaba y el
   *    movimiento quedaba sin autor, que es justo lo que se necesita para
   *    investigar esto;
   *  - NO se puede anular contra un turno ya cerrado: ese arqueo está firmado.
   *    Una venta de un turno cerrado se corrige con nota de crédito, que deja el
   *    dinero donde está y registra el ajuste aparte.
   *
   * Se sigue bloqueando si hay una cobranza imputada: primero se anula la
   * cobranza, si no el saldo del cliente queda inconsistente.
   */
  async anular(id: number, motivo: string, usuarioId?: number, opciones: OpcionesVenta = {}) {
    const v = await this.get(id);
    if (v.estado === 'anulada') throw new BadRequestException('La venta ya está anulada.');
    if (v.estado === 'borrador') throw new BadRequestException('Es una venta abierta: descartala en vez de anularla.');
    if (v.cobrado > 0.009) throw new BadRequestException('Tiene cobranzas imputadas. Anulá primero la cobranza.');
    if (opciones.soloSuSucursal && v.sucursalId !== opciones.soloSuSucursal) {
      throw new ForbiddenException('Esa venta es de otra sucursal.');
    }
    const razon = (motivo ?? '').trim();
    if (!razon) throw new BadRequestException('Indicá por qué se anula la venta.');

    if (v.cajaSesionId) {
      const turno = await this.caja.getOpcional(v.cajaSesionId);
      if (turno && turno.estado === 'cerrada' && !opciones.esJefe) {
        throw new BadRequestException(
          'El turno de caja de esa venta ya está cerrado: su arqueo quedó firmado. '
          + 'Corregila con una nota de crédito en vez de anularla.',
        );
      }
    }

    await this.db.transaction(async (tx) => {
      await tx.update(ventas).set({
        estado: 'anulada',
        anuladoPor: usuarioId ?? null,
        anuladoEn: new Date(),
        anuladoMotivo: razon,
      }).where(eq(ventas.id, id));
      if (v.sucursalId) {
        await this.inv.reingresarStockItems(tx, {
          sucursalId: v.sucursalId,
          usuarioId,
          descripcion: `Anulación venta ${v.puntoVenta}-${String(v.numero ?? 0).padStart(8, '0')}: ${razon}`,
          items: v.items,
        });
      }
    });
    return this.get(id);
  }

  /**
   * Snapshot del módulo Ventas: SOLO catálogos chicos. Deliberadamente no trae
   * ventas ni cobranzas (crecen sin techo) — esas se piden paginadas por panel.
   */
  async bootstrap(sesion?: Sesion) {
    await this.cli.consumidorFinal(); // garantiza el cliente genérico
    const [cls, cfg, sucs, usrsRaw, rolesCat, asignaciones, cat, marcasCat] = await Promise.all([
      this.db.select().from(clientes).orderBy(clientes.nombre),
      this.cfg.get('ventas'),
      this.db.select().from(sucursales).orderBy(sucursales.nombre),
      this.db.select().from(usuarios).orderBy(usuarios.nombre),
      this.db.select().from(roles),
      this.db.select().from(clienteListas),
      this.listas.catalogo(),
      // Las marcas del catálogo, para cargar una regla eligiéndola de la lista.
      this.db.select({ id: marcas.id, nombre: marcas.nombre })
        .from(marcas).where(eq(marcas.activa, true)).orderBy(marcas.nombre),
    ]);
    /*
     * Usuarios SIN hash y con su rol resuelto. LOS PERMISOS VAN SOLO DEL PROPIO
     * USUARIO: antes viajaba el array completo de cada empleado, o sea el mapa de
     * quién puede qué en toda la empresa —quién tiene `precio_manual`, quién
     * `diferencias`— servido a cualquier sesión que abriera cualquier pantalla de
     * Ventas. Eso es el mapa de a quién apuntar.
     *
     * No rompe nada, y está verificado: los dos lugares que leen `permisos`
     * (`PosPanel` y `PresupuestosPanel`) buscan SU PROPIO usuario en la lista. El
     * resto solo necesita el nombre para los selectores.
     */
    const rolDe = new Map(rolesCat.map((r) => [r.id, r]));
    const usrs = usrsRaw.map((u) => {
      const r = rolDe.get(u.rolId);
      const esYo = u.id === sesion?.usuarioId;
      return {
        id: u.id, nombre: u.nombre, activo: u.activo, rolId: u.rolId,
        rolClave: r?.clave ?? '', rolNombre: r?.nombre ?? '',
        permisos: esYo ? (r?.permisos ?? []) : [],
      };
    });
    // Las listas predeterminadas de cada cliente en UNA consulta, no una por
    // cliente: el POS las necesita para cotizar y cambia de cliente en vivo.
    return {
      clientes: cls.map((c) => ({
        ...c,
        listas: asignaciones.filter((a) => a.clienteId === c.id).map((a) => a.listaId),
      })),
      config: cfg,
      sucursales: sucs,
      usuarios: usrs,
      listasCatalogo: cat,
      marcas: marcasCat,
    };
  }
}

/**
 * VENTAS — el mostrador.
 *
 * `ventas.pos` de base (es la pantalla desde donde se hace todo esto), y llaves
 * propias donde la acción no es "vender": el listado es su propia sección y
 * anular es la acción `devoluciones`.
 *
 * Todo lo que decide QUIÉN y DÓNDE sale de `@Auth()` y viaja en `OpcionesVenta`.
 * El `usuarioId` del body ya lo pone el `AutorInterceptor` global.
 */
@Controller('ventas')
@Permiso('ventas.pos')
export class VentasController {
  constructor(private readonly svc: VentasService) {}

  /**
   * Lo que el servidor resolvió de la sesión. Un solo lugar para los 6
   * escritores, así ninguno puede quedarse con una regla distinta.
   *
   * `sucursalPedida` es el `sucursalId` del body: una PISTA que solo se respeta
   * si quien llama es un jefe.
   */
  private opciones(sesion: Sesion, sucursalPedida?: number): OpcionesVenta {
    const jefe = esJefe(sesion);
    return {
      sucursalSesion: sucursalDeOperacion(sesion, sucursalPedida),
      // El jefe cruza sucursales (corrige la carga de otro mostrador); el cajero
      // solo toca lo suyo. `undefined` = sin restricción.
      soloSuSucursal: jefe ? undefined : sesion.sucursalId,
      // La llave que le da sentido del lado del servidor a `descuentoMaxVendedor`
      // y `overrideListaRequiereAdmin`, que hasta ahora solo vivían en el navegador.
      puedePisarPrecio: tienePermiso(sesion.permisos, ['precio_manual']),
      esJefe: jefe,
    };
  }

  /*
   * El BOOTSTRAP lo pide el shell del módulo antes de saber en qué panel va a
   * entrar, así que lo abre cualquier sección de Ventas: si pidiera `ventas.pos`,
   * un rol que solo administra clientes no podría entrar a su propia pantalla.
   */
  @Get('bootstrap') @Permiso(...SECCIONES_VENTAS)
  bootstrap(@Auth() sesion: Sesion) { return this.svc.bootstrap(sesion); }

  @Get('catalogo')
  catalogo(@Query('sucursalId', ParseIntPipe) sucursalId: number) {
    return this.svc.catalogo(sucursalId);
  }

  @Get('cuenta/:clienteId')
  cuenta(@Param('clienteId', ParseIntPipe) clienteId: number) { return this.svc.cuenta(clienteId); }

  /**
   * El listado de la pantalla Ventas: filtros + paginado + totales del filtro.
   *
   * LA SUCURSAL LA MANDA LA SESIÓN, no el query. El candado del cajero estaba
   * solo en React (`sucursalFija`): sin `?sucursalId=`, esta consulta devolvía las
   * ventas de las cinco sucursales con cliente, cajero, medios de pago y el
   * bloque de totales del período. La facturación del negocio en una URL.
   */
  @Get('listado')
  @Permiso('ventas.listado')
  listado(
    @Auth() sesion: Sesion,
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('sucursalId') sucursalId?: string,
    @Query('usuarioId') usuarioId?: string,
    @Query('clienteId') clienteId?: string,
    @Query('cajaSesionId') cajaSesionId?: string,
    @Query('estado') estado?: string,
    @Query('medioPago') medioPago?: string,
    @Query('origen') origen?: string,
    @Query('conOferta') conOferta?: string,
    @Query('sinFacturar') sinFacturar?: string,
    @Query('q') q?: string,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ) {
    const num = (v?: string) => (v ? Number(v) : undefined);
    /* Los enums se validan ACÁ: un `?estado=abc` llegaba a Postgres como valor
     * de enum inválido y salía un 500 donde corresponde un 400 (misma lección
     * que el `?desde=abc` de los pagos). */
    const uno = (v: string | undefined, validos: readonly string[], campo: string) => {
      if (!v) return undefined;
      if (!validos.includes(v)) throw new BadRequestException(`${campo} inválido: ${v}`);
      return v;
    };
    return this.svc.listado({
      desde, hasta, q,
      estado: uno(estado, ['borrador', 'confirmada', 'anulada', 'pendiente_cae'], 'Estado'),
      medioPago: uno(medioPago, MEDIOS, 'Medio de pago'),
      origen: uno(origen, ['pos', 'presupuesto'], 'Origen'),
      sucursalId: esJefe(sesion) ? num(sucursalId) : sesion.sucursalId,
      usuarioId: num(usuarioId),
      clienteId: num(clienteId), cajaSesionId: num(cajaSesionId),
      conOferta: conOferta === 'true',
      sinFacturar: sinFacturar === 'true',
      offset: num(offset), limit: num(limit),
    });
  }

  @Get()
  @Permiso('ventas.pos', 'ventas.listado')
  list(
    @Auth() sesion: Sesion,
    @Query('clienteId') clienteId?: string,
    @Query('sucursalId') sucursalId?: string,
    @Query('estado') estado?: string,
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('limit') limit?: string,
    @Query('incluirItems') incluirItems?: string,
  ) {
    /* El enum se valida ACÁ también: `?estado=xyz` entraba crudo a Postgres y
     * salía un 500 donde corresponde un 400. `listado` ya lo hacía; este método
     * era el que faltaba de los dos. */
    if (estado && !['borrador', 'confirmada', 'anulada', 'pendiente_cae'].includes(estado)) {
      throw new BadRequestException(`Estado inválido: ${estado}`);
    }
    return this.svc.list({
      clienteId: clienteId ? Number(clienteId) : undefined,
      // Misma regla que el listado: el cajero ve la suya y nada más.
      sucursalId: esJefe(sesion) ? (sucursalId ? Number(sucursalId) : undefined) : sesion.sucursalId,
      estado, desde, hasta,
      limit: limit ? Number(limit) : undefined,
      incluirItems: incluirItems === 'true',
    });
  }

  @Get(':id') @Permiso('ventas.pos', 'ventas.listado', 'ventas.cobranzas')
  get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }

  /*
   * VER EL PUNTO DE VENTA Y COBRAR SON DOS PERMISOS, y la API los confundía.
   *
   * `ventas.pos` es la clave de la PANTALLA y es la de la clase; `ventas` es la
   * ACCIÓN de cobrar, existe en el catálogo desde siempre y **no se exigía en
   * ningún endpoint** — el único lugar que la respetaba era un botón de otra
   * pantalla. O sea que un rol "Consulta de mostrador", creado para que vean
   * precios y stock, podía armar un ticket, confirmarlo, descontar stock y
   * meterle el efectivo al turno del cajero.
   *
   * Va sola y no junto a `ventas.pos`: las claves de un mismo `@Permiso` se
   * evalúan con O, así que ponerlas juntas lo dejaría igual que antes.
   * Verificado antes de aplicarlo: los cinco roles que hoy ven el POS ya tienen
   * la acción, así que a nadie se le corta el cobro.
   */
  @Post()
  @Permiso('ventas')
  create(@Body() dto: CreateVentaDto, @Auth() sesion: Sesion) {
    return this.svc.create(dto, this.opciones(sesion, dto.sucursalId));
  }

  @Put(':id')
  @Permiso('ventas')
  actualizar(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateVentaDto, @Auth() sesion: Sesion) {
    return this.svc.actualizar(id, dto, this.opciones(sesion, dto.sucursalId));
  }

  @Post(':id/confirmar')
  @Permiso('ventas')
  confirmar(@Param('id', ParseIntPipe) id: number, @Body() dto: ConfirmarVentaDto, @Auth() sesion: Sesion) {
    return this.svc.confirmar(id, dto, this.opciones(sesion));
  }

  @Post(':id/delegar')
  @Permiso('ventas')
  delegar(@Param('id', ParseIntPipe) id: number, @Body() dto: DelegarVentaDto, @Auth() sesion: Sesion) {
    return this.svc.delegar(id, dto.paraUsuarioId, this.opciones(sesion));
  }

  /**
   * FACTURAR UNA VENTA PENDIENTE (0073): el botón de la pestaña Sin facturar.
   * No toca plata ni stock — solo emite el comprobante fiscal que ARCA no dio
   * al cobrar. Reintentar es inocuo: si ARCA sigue caído, la venta queda como
   * estaba. El permiso es el del listado, que es donde vive el botón.
   */
  @Post(':id/facturar')
  @Permiso('ventas.listado')
  facturar(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) {
    return this.svc.facturarAhora(id, this.opciones(sesion));
  }

  /*
   * `devoluciones` y no `ventas.pos`: anular le saca el efectivo al arqueo del
   * turno, así que es la acción con la que se tapa un faltante. El usuario que
   * queda en `anuladoPor` es el de la sesión — el body no puede mentirlo.
   */
  @Post(':id/anular')
  @Permiso('devoluciones')
  anular(@Param('id', ParseIntPipe) id: number, @Body() dto: AnularVentaDto, @Auth() sesion: Sesion) {
    return this.svc.anular(id, dto.motivo, sesion.usuarioId, this.opciones(sesion));
  }

  @Delete(':id')
  @Permiso('ventas')
  descartar(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) {
    return this.svc.descartar(id, this.opciones(sesion));
  }
}

/* ==================================================================== *
 * DESCUENTOS CON NOMBRE — el ABM
 * ==================================================================== */

/**
 * `vence` viaja como 'AAAA-MM-DD' y se guarda como el instante FINAL de ese día
 * en hora argentina.
 *
 * Es la trampa que ya mordió dos veces a este proyecto y por eso está escrita
 * acá: `new Date('2026-08-12')` es medianoche UTC, que en UTC−3 es el 11 a las
 * 21:00. Guardado así, un descuento "hasta el 12" se moría el 11 a la tarde.
 * Como el dueño pidió que valga TODO el día, se guarda el 12 a las 23:59:59.999
 * de −03 — y de paso comparar contra `now()` alcanza, sin sumar días en cada
 * consulta.
 */
const FIN_DEL_DIA_AR = 'T23:59:59.999-03:00';
/*
 * LA CADENA VACÍA ESTÁ PERMITIDA, y no es un descuido.
 *
 * `@IsOptional()` de class-validator solo perdona `null` y `undefined`: un `''`
 * sí se valida y rebota. Y `''` es exactamente lo que manda un formulario con
 * el campo en blanco, que además es el caso MÁS COMÚN (un descuento sin
 * vencimiento y sin medio de pago exigido).
 *
 * Sin este `^$`, crear el descuento más simple de todos fallaba con "El
 * vencimiento va como AAAA-MM-DD" sobre un campo que el usuario nunca tocó.
 * Y en `editar`, la cadena vacía tiene un significado propio: BORRA el
 * vencimiento. Así que tiene que llegar, no ser rechazada.
 */
const SOLO_FECHA = /^$|^\d{4}-\d{2}-\d{2}$/;

const vencimientoDe = (v?: string | null): Date | null => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const d = new Date(`${s.slice(0, 10)}${FIN_DEL_DIA_AR}`);
  return Number.isNaN(d.getTime()) ? null : d;
};

class DescuentoDto {
  @IsOptional() @IsString() @MaxLength(60) nombre?: string;
  /* Tope 100: un descuento mayor regala el producto y encima da precio
   * negativo. El 0 se permite para poder dejarlo "en pausa" sin borrarlo. */
  @IsOptional() @IsNumber() @Min(0) @Max(100) porcentaje?: number;
  @IsOptional() @IsString() @Matches(SOLO_FECHA, { message: 'El vencimiento va como AAAA-MM-DD.' }) vence?: string;
  /** Vacío/ausente = cualquier forma de pago (por eso `''` entra en la lista). */
  @IsOptional() @IsIn(['', ...MEDIOS] as unknown as string[]) medioPago?: string;
  @IsOptional() @IsInt() listaId?: number;
  /** Ausente o null = TODAS las sucursales. */
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() requiereAdmin?: boolean;
  @IsOptional() activo?: boolean;
}

@Injectable()
export class DescuentosService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  list() {
    return this.db.select().from(descuentos).orderBy(desc(descuentos.activo), descuentos.nombre);
  }

  private async validar(dto: DescuentoDto, id?: number) {
    const nombre = (dto.nombre ?? '').trim();
    if (!nombre) throw new BadRequestException('Poné un nombre para el descuento (es el que ve la cajera).');
    const conds: any[] = [eq(descuentos.nombre, nombre)];
    if (id) conds.push(ne(descuentos.id, id));
    const [ya] = await this.db.select({ id: descuentos.id }).from(descuentos).where(and(...conds)).limit(1);
    if (ya) throw new BadRequestException(`Ya existe un descuento llamado "${nombre}".`);

    /*
     * LA LISTA ES OBLIGATORIA y no tiene default. Es la identidad del
     * descuento: sin ella no se sabe sobre qué renglones cae, y un descuento
     * "de todas las listas" rompería la regla de uno por lista.
     */
    const listaId = Number(dto.listaId) || 0;
    if (!listaId) throw new BadRequestException('Elegí a qué lista de precios se aplica el descuento.');
    const [l] = await this.db.select({ id: listasVenta.id }).from(listasVenta)
      .where(eq(listasVenta.id, listaId)).limit(1);
    if (!l) throw new BadRequestException('Esa lista de precios no existe.');

    if (dto.sucursalId != null) {
      const [s] = await this.db.select({ id: sucursales.id }).from(sucursales)
        .where(eq(sucursales.id, Number(dto.sucursalId))).limit(1);
      if (!s) throw new BadRequestException('Esa sucursal no existe.');
    }
    return { nombre, listaId };
  }

  async crear(dto: DescuentoDto) {
    const { nombre, listaId } = await this.validar(dto);
    const [d] = await this.db.insert(descuentos).values({
      nombre,
      porcentaje: Math.round((Number(dto.porcentaje) || 0) * 100) / 100,
      vence: vencimientoDe(dto.vence),
      medioPago: (dto.medioPago || null) as any,
      listaId,
      sucursalId: dto.sucursalId ?? null,
      requiereAdmin: !!dto.requiereAdmin,
      activo: dto.activo !== false,
    }).returning();
    return d;
  }

  async editar(id: number, dto: DescuentoDto) {
    const [actual] = await this.db.select().from(descuentos).where(eq(descuentos.id, id)).limit(1);
    if (!actual) throw new NotFoundException('Ese descuento no existe.');
    const { nombre, listaId } = await this.validar({ ...dto, nombre: dto.nombre ?? actual.nombre, listaId: dto.listaId ?? actual.listaId }, id);
    await this.db.update(descuentos).set({
      nombre,
      porcentaje: dto.porcentaje != null ? Math.round(Number(dto.porcentaje) * 100) / 100 : actual.porcentaje,
      // `vence` se distingue de "no lo mandaron": una cadena vacía lo BORRA.
      vence: dto.vence !== undefined ? vencimientoDe(dto.vence) : actual.vence,
      medioPago: dto.medioPago !== undefined ? ((dto.medioPago || null) as any) : actual.medioPago,
      listaId,
      sucursalId: dto.sucursalId !== undefined ? (dto.sucursalId ?? null) : actual.sucursalId,
      requiereAdmin: dto.requiereAdmin != null ? !!dto.requiereAdmin : actual.requiereAdmin,
      activo: dto.activo != null ? !!dto.activo : actual.activo,
    }).where(eq(descuentos.id, id));
    return this.db.select().from(descuentos).where(eq(descuentos.id, id)).limit(1).then((r) => r[0]);
  }

  /**
   * Borrar solo si NUNCA se usó. Con ventas atrás se da de baja, que es el
   * mismo criterio que ya usan los rubros de gasto y los productos: borrar
   * dejaría los reportes sin poder explicar de dónde salió un descuento.
   */
  async borrar(id: number) {
    const [d] = await this.db.select().from(descuentos).where(eq(descuentos.id, id)).limit(1);
    if (!d) throw new NotFoundException('Ese descuento no existe.');
    const [uso] = await this.db.select({ n: sql<number>`count(*)::int` }).from(ventaItems)
      .where(eq(ventaItems.descuentoId, id));
    if (Number(uso?.n) > 0) {
      throw new BadRequestException(
        `"${d.nombre}" ya se aplicó en ${uso.n} renglón(es) de venta: no se borra, se desactiva `
        + 'para que deje de ofrecerse sin perder de dónde salió cada descuento hecho.',
      );
    }
    await this.db.delete(descuentos).where(eq(descuentos.id, id));
    return { ok: true };
  }
}

/**
 * DOS PUERTAS DISTINTAS, y no es un descuido.
 *
 * LEER es de cualquiera que venda: el POS necesita saber qué descuentos existen
 * para ofrecerlos, y quien atiende el mostrador no tiene por qué poder
 * crearlos. ESCRIBIR es de `ventas.configuracion`, la misma llave que ya
 * gobierna el resto de las reglas del negocio.
 *
 * No hace falta un permiso nuevo: el que decide si una cajera puede APLICAR un
 * descuento de los que piden admin es `precio_manual`, que ya existe y ya
 * significa exactamente eso (ver `resolverDescuentos`).
 */
@Controller('descuentos')
export class DescuentosController {
  constructor(private readonly svc: DescuentosService) {}

  @Get() @Permiso('ventas.pos', 'ventas.configuracion') list() { return this.svc.list(); }

  @Post() @Permiso('ventas.configuracion') crear(@Body() dto: DescuentoDto) { return this.svc.crear(dto); }

  @Patch(':id') @Permiso('ventas.configuracion') editar(
    @Param('id', ParseIntPipe) id: number, @Body() dto: DescuentoDto,
  ) { return this.svc.editar(id, dto); }

  @Delete(':id') @Permiso('ventas.configuracion') borrar(@Param('id', ParseIntPipe) id: number) {
    return this.svc.borrar(id);
  }
}

@Module({
  imports: [
    InventarioModule, ConfiguracionModule, ClientesModule, CajaModule,
    ListasModule, OfertasModule, ArcaModule,
  ],
  controllers: [VentasController, DescuentosController],
  providers: [VentasService, DescuentosService],
  exports: [VentasService],
})
export class VentasModule {}
