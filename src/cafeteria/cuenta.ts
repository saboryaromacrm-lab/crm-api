/**
 * LA CUENTA CORRIENTE ENTRE SABOR Y AROMA Y COFFIT (0120, 29/9/2026)
 * ============================================================================
 * Nació de la conciliación entre los dos dueños: el saldo era del período
 * elegido, no arrastraba, no había dónde anotar un pago y cada pantalla lo
 * sumaba a su manera. Acá vive UNA sola regla de qué mueve plata entre los dos
 * negocios, y la usan la cuenta corriente, el resumen de Coffit y Gerencia.
 *
 * SIGNO: positivo = Coffit le debe más a Sabor y Aroma; negativo = al revés.
 *
 * LOS RENGLONES SALEN DE LOS DOCUMENTOS, no se copian a una tabla: así no hay
 * dos versiones del mismo hecho que se puedan desfasar.
 *
 *   · compra        — la parte de Coffit de cada factura de compra, a PRECIO
 *                     FINAL (`final_cafeteria`). La NC resta.
 *   · envio         — lo que S&A le manda desde su stock, al costo final
 *                     congelado del envío, MENOS lo que Coffit ya había pagado
 *                     en la factura (`cantidad_exclusiva`).
 *   · dif_envio     — al recibir, lo que no llegó lo pierde el que mandó:
 *                     (contado − enviado) × costo, en la FECHA DE RECEPCIÓN.
 *   · entrada       — lo que Coffit elabora y manda a una sucursal (resta).
 *   · dif_entrada   — igual que dif_envio, del otro lado (lo que no llegó lo
 *                     pierde Coffit).
 *   · gasto         — los gastos cargados con Negocio: Coffit, por su total.
 *   · manuales      — `coffit_movimientos`: saldo inicial, pagos,
 *                     compensaciones, ajustes y el stock que pasa a Coffit al
 *                     marcar un artículo exclusivo.
 *
 * COFFIT PAGA PRECIO FINAL (0176, 16/10/2026, decisión del dueño): lo que se
 * compra para Coffit, lo que se le manda y sus gastos se le cobran CON IVA y
 * percepciones —el total del papel—, aunque el crédito fiscal siga siendo de
 * la empresa. Un remito o una liquidación (sin IVA) ya es su precio final, y
 * una factura B o C trae el IVA adentro. Rige desde el principio: los meses que
 * estaban cerrados se siguen viendo como se firmaron (hasta `coffit_sin_iva_hasta`)
 * y su diferencia entró como un ajuste en el mes abierto.
 *
 * GERENCIA mira otra cosa —qué parte de las compras fue de Coffit— y por eso
 * suma al NETO (`modo: 'gerencia'`): las compras de la empresa son netas.
 *
 * Por qué la diferencia al recibir va en SU fecha y no en la del envío: así un
 * mes cerrado no cambia nunca. Un envío del 30 recibido el 2 cuenta entero el
 * 30 y la diferencia entra el 2, en el mes abierto.
 */
import { BadRequestException } from '@nestjs/common';
import { and, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { costoNetoEntry } from '../inventario/pricing';
import {
  coffitCierres, coffitMovimientos, comprobanteItems, comprobantes, envioCafeteriaItems, enviosCafeteria, presentaciones,
} from '../db/schema';

export type TipoLinea =
  | 'compra' | 'envio' | 'dif_envio' | 'entrada' | 'dif_entrada' | 'gasto'
  | 'saldo_inicial' | 'pago' | 'compensacion' | 'ajuste' | 'marca_exclusivo';

export interface LineaCuenta {
  tipo: TipoLinea;
  fecha: string;
  ref: number;
  documento: string;
  detalle: string;
  importe: number;
}

/** Los cinco grupos en que se lee la cuenta. */
export type Totales = { compras: number; envios: number; entradas: number; gastos: number; manuales: number };

export const TOTALES_VACIOS = (): Totales => ({ compras: 0, envios: 0, entradas: 0, gastos: 0, manuales: 0 });

const GRUPO: Record<TipoLinea, keyof Totales> = {
  compra: 'compras', envio: 'envios', dif_envio: 'envios', entrada: 'entradas', dif_entrada: 'entradas',
  gasto: 'gastos', saldo_inicial: 'manuales', pago: 'manuales', compensacion: 'manuales', ajuste: 'manuales',
  marca_exclusivo: 'manuales',
};

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
export const ZONA_AR = 'America/Argentina/Buenos_Aires';
/** 'AAAA-MM-DD' de hoy en Argentina. */
export const hoyAr = () => new Date().toLocaleDateString('sv-SE', { timeZone: ZONA_AR });
/** Inicio y fin del día local (el proceso corre con TZ de Argentina, ver Dockerfile). */
export const inicioDia = (d: string) => new Date(`${d}T00:00:00`);
export const finDia = (d: string) => new Date(`${d}T23:59:59.999`);
/** El día anterior / siguiente de un 'AAAA-MM-DD'. */
export const sumarDias = (d: string, n: number) => {
  const x = new Date(`${d}T12:00:00`);
  x.setDate(x.getDate() + n);
  return x.toLocaleDateString('sv-SE');
};

/**
 * HASTA CUÁNDO LA CUENTA SE CALCULÓ SIN IVA (0176): el fin del último mes que
 * estaba cerrado el día del cambio. Lo de esa fecha o antes se sigue contando
 * como se firmó; null (no había cierres) = todo a precio final.
 */
const SIN_IVA_HASTA = sql`(select (valor #>> '{}')::timestamptz from configuracion where clave = 'coffit_sin_iva_hasta')`;

export async function sinIvaHasta(db: any): Promise<Date | null> {
  const r = await db.execute(sql`select ${SIN_IVA_HASTA} as corte`);
  const v = filasDe(r)[0]?.corte;
  return v ? new Date(v) : null;
}

/** Lo que un papel le suma a la cuenta, según su fecha en ella: lo firmado sin IVA o el precio final. */
export const segunCorte = (corte: Date | null, fechaCuenta: Date, sinIva: number, final: number) =>
  (corte && new Date(fechaCuenta).getTime() <= corte.getTime() ? sinIva : final);

export async function importeEnCuenta(db: any, fechaCuenta: Date, sinIva: number, final: number) {
  return segunCorte(await sinIvaHasta(db), fechaCuenta, sinIva, final);
}

/**
 * LO QUE COFFIT PAGA DE UNA FACTURA (0176): el total del papel de su parte. Su
 * neto, el IVA de la factura en proporción al IVA de sus renglones (así, si la
 * factura es entera de Coffit, da el IVA exacto del papel) y las percepciones
 * en proporción a su neto. En B, C y X el IVA de los renglones es cero: el
 * precio ya es el final.
 */
export function finalCafeteria(
  pie: { items: Array<{ subtotal: number; iva: number }>; subtotalNeto: number; ivaTotal: number; percepcionesTotal: number },
  esDelCafe: (it: any) => boolean,
): number {
  let neto = 0;
  let ivaCafe = 0;
  let ivaTodo = 0;
  for (const it of pie.items) {
    const v = Number(it.subtotal) * (Number(it.iva) || 0);
    ivaTodo += v;
    if (esDelCafe(it)) { neto += Number(it.subtotal); ivaCafe += v; }
  }
  if (neto <= 0) return 0;
  const iva = ivaTodo > 0 ? Number(pie.ivaTotal) * ivaCafe / ivaTodo : 0;
  const perc = Number(pie.subtotalNeto) > 0 ? Number(pie.percepcionesTotal) * neto / Number(pie.subtotalNeto) : 0;
  return r2(neto + iva + perc);
}

/**
 * Los renglones de la cuenta en [desde, hasta] (fechas inclusive, null = sin
 * límite), en UNA consulta.
 *   · 'cuenta'   — lo que Coffit debe: a precio final (salvo lo firmado sin IVA),
 *                  por la fecha en que cada papel entró a la cuenta.
 *   · 'gerencia' — qué parte de las compras fue de Coffit: al NETO y por la
 *                  fecha del papel.
 */
type ModoCuenta = 'cuenta' | 'gerencia';
function unionCuenta(desde: Date | null, hasta: Date | null, modo: ModoCuenta = 'cuenta') {
  const rango = (col: any) => sql`${desde ? sql` and ${col} >= ${desde}` : sql``}${hasta ? sql` and ${col} <= ${hasta}` : sql``}`;
  const gerencia = modo === 'gerencia';
  /* La compra y el gasto cuentan en su fecha, salvo que hayan llegado después
   * del cierre de su mes (`cuenta_fecha`). Gerencia mira la fecha del papel. */
  const fc = gerencia ? sql`c.fecha` : sql`coalesce(c.cuenta_fecha, c.fecha)`;
  const fg = gerencia ? sql`g.fecha` : sql`coalesce(g.cuenta_fecha, g.fecha)`;
  /* Neto o precio final, según el modo y la fecha (ver `SIN_IVA_HASTA`). */
  const segun = (fecha: any, neto: any, final: any) => (gerencia ? neto : sql`(case when ${fecha} <= ${SIN_IVA_HASTA} then ${neto} else ${final} end)`);
  const compra = segun(fc, sql`c.neto_cafeteria`, sql`c.final_cafeteria`);
  const costoEnvio = segun(sql`e.fecha`, sql`i.costo_neto`, sql`i.costo_unitario`);
  const costoDif = segun(sql`e.recibido_en`, sql`i.costo_neto`, sql`i.costo_unitario`);
  const gasto = segun(fg, sql`g.total - g.iva - g.perc_dgi - g.perc_dgr`, sql`g.total`);
  return sql`
    select 'compra'::text as tipo, ${fc} as fecha, c.id as ref,
      (case c.tipo when 'nota_credito' then 'NC ' when 'nota_debito' then 'ND ' when 'liquidacion' then 'Liquidación ' else 'Factura ' end)
        || c.letra::text || ' ' || c.punto_venta || '-' || lpad(coalesce(c.numero, c.id)::text, 8, '0') as documento,
      pr.nombre as detalle,
      ${compra} * (case when c.tipo = 'nota_credito' then -1 else 1 end) as importe
    from comprobantes c join proveedores pr on pr.id = c.proveedor_id
    where c.estado = 'confirmado' and c.neto_cafeteria > 0
      and c.tipo in ('factura', 'liquidacion', 'nota_debito', 'nota_credito')${rango(fc)}
    union all
    select case e.sentido when 'salida' then 'envio' else 'entrada' end, e.fecha, e.id, e.codigo, s.nombre,
      case e.sentido
        when 'salida' then sum((i.cantidad - i.cantidad_exclusiva) * ${costoEnvio})
        else -sum(i.cantidad * i.costo_unitario) end
    from envios_cafeteria e
      join envio_cafeteria_items i on i.envio_id = e.id
      join sucursales s on s.id = e.sucursal_id
    where e.estado = 'enviado'${rango(sql`e.fecha`)}
    group by e.id, s.nombre
    union all
    select case e.sentido when 'salida' then 'dif_envio' else 'dif_entrada' end, e.recibido_en, e.id, e.codigo,
      'Diferencia al recibir',
      (case e.sentido when 'salida' then 1 else -1 end)
        * sum((coalesce(i.cantidad_recibida, i.cantidad) - i.cantidad) * ${costoDif})
    from envios_cafeteria e join envio_cafeteria_items i on i.envio_id = e.id
    where e.estado = 'enviado' and e.recepcion <> 'pendiente' and e.recibido_en is not null${rango(sql`e.recibido_en`)}
    group by e.id
    having abs(sum((coalesce(i.cantidad_recibida, i.cantidad) - i.cantidad) * ${costoDif})) > 0.004
    union all
    select 'gasto', ${fg}, g.id,
      (case g.tipo_doc when 'nota_credito' then 'NC ' when 'ticket' then 'Ticket ' when 'recibo' then 'Recibo ' when 'otro' then '' else 'Factura ' end)
        || trim(g.letra::text || ' ' || g.numero),
      coalesce(nullif(pr.nombre, ''), nullif(g.proveedor_texto, ''), 'Sin proveedor') || ' · ' || gc.nombre,
      ${gasto}
    from gastos g
      join gasto_categorias gc on gc.id = g.categoria_id
      left join proveedores pr on pr.id = g.proveedor_id
    where g.negocio = 'cafeteria' and g.estado <> 'anulado'${rango(fg)}
    union all
    select m.tipo, m.fecha, m.id, trim(m.medio || ' ' || m.referencia), m.descripcion,
      case m.a_favor when 'sya' then m.importe else -m.importe end
    from coffit_movimientos m
    where not m.anulado${rango(sql`m.fecha`)}`;
}

const filasDe = (r: any) => (r?.rows ?? r) as any[];

export async function lineasCuenta(db: any, desde: Date | null, hasta: Date | null): Promise<LineaCuenta[]> {
  const r = await db.execute(sql`select * from (${unionCuenta(desde, hasta)}) x order by x.fecha, x.tipo, x.ref`);
  return filasDe(r).map((f) => ({
    tipo: f.tipo, fecha: new Date(f.fecha).toISOString(), ref: Number(f.ref),
    documento: f.documento ?? '', detalle: f.detalle ?? '', importe: r2(Number(f.importe)),
  }));
}

export async function totalesCuenta(db: any, desde: Date | null, hasta: Date | null, modo: ModoCuenta = 'cuenta'): Promise<Totales> {
  const r = await db.execute(sql`select x.tipo, sum(x.importe) as total from (${unionCuenta(desde, hasta, modo)}) x group by x.tipo`);
  const t = TOTALES_VACIOS();
  for (const f of filasDe(r)) {
    const g = GRUPO[f.tipo as TipoLinea];
    if (g) t[g] += Number(f.total) || 0;
  }
  for (const k of Object.keys(t) as (keyof Totales)[]) t[k] = r2(t[k]);
  return t;
}

export const sumaTotales = (t: Totales) => r2(t.compras + t.envios + t.entradas + t.gastos + t.manuales);

export function totalesDeLineas(lineas: LineaCuenta[]): Totales {
  const t = TOTALES_VACIOS();
  for (const l of lineas) t[GRUPO[l.tipo]] += l.importe;
  for (const k of Object.keys(t) as (keyof Totales)[]) t[k] = r2(t[k]);
  return t;
}

/** El último cierre vigente (no anulado), o null. */
export async function ultimoCierre(db: any) {
  const [c] = await db.select().from(coffitCierres)
    .where(eq(coffitCierres.anulado, false)).orderBy(desc(coffitCierres.hasta)).limit(1);
  return c ?? null;
}

/**
 * EL SALDO AL FINAL DEL DÍA `dia` ('AAAA-MM-DD'). Parte del último cierre
 * anterior a ese día (su saldo congelado) y suma lo que vino después; sin
 * cierres, suma todo desde el principio.
 */
export async function saldoAl(db: any, dia: string): Promise<number> {
  const [c] = await db.select().from(coffitCierres)
    .where(and(eq(coffitCierres.anulado, false), sql`${coffitCierres.hasta} <= ${dia}`))
    .orderBy(desc(coffitCierres.hasta)).limit(1);
  const base = c ? Number(c.saldoFinal) : 0;
  const desde = c ? inicioDia(sumarDias(c.hasta, 1)) : null;
  if (c && c.hasta >= dia) return r2(base);
  return r2(base + sumaTotales(await totalesCuenta(db, desde, finDia(dia))));
}

/**
 * LA FECHA EN QUE UN PAPEL ENTRA A LA CUENTA (0120). Una factura o un gasto
 * con fecha de un mes ya cerrado no se puede rechazar —es el papel fiscal, y
 * su fecha es la que es—: entra a la cuenta HOY. Devuelve null cuando cuenta
 * en su propia fecha.
 */
export async function fechaDeCuenta(db: any, fecha: Date | null | undefined): Promise<Date | null> {
  const c = await ultimoCierre(db);
  if (!c || !fecha) return null;
  return fecha.getTime() <= finDia(c.hasta).getTime() ? new Date() : null;
}

/**
 * ANULAR UN PAPEL DE UN MES CERRADO (0120): el cierre ya lo contó, así que
 * anularlo no puede cambiar ese saldo. Se deja un AJUSTE de signo contrario en
 * el mes abierto, en la misma transacción. `efecto` es lo que el papel movía
 * la cuenta (+ = Coffit debía más).
 */
export async function ajustePorAnulacion(tx: any, o: {
  fechaCuenta: Date; efecto: number; documento: string; usuarioId?: number | null;
}) {
  if (Math.abs(o.efecto) < 0.005) return;
  const c = await ultimoCierre(tx);
  if (!c || o.fechaCuenta.getTime() > finDia(c.hasta).getTime()) return;
  await tx.insert(coffitMovimientos).values({
    fecha: new Date(), tipo: 'ajuste', aFavor: o.efecto > 0 ? 'coffit' : 'sya', importe: r2(Math.abs(o.efecto)),
    descripcion: `Anulación de ${o.documento}, que ya estaba en un mes cerrado`,
    usuarioId: o.usuarioId ?? null,
  });
}

/**
 * EL CANDADO DEL MES CERRADO. Nada que mueva la cuenta se carga ni se toca con
 * fecha de un período ya cerrado: el saldo que se firmó no puede cambiar por
 * atrás. Lo que haya que corregir va como ajuste en el mes en curso.
 */
export async function exigirCuentaAbierta(db: any, fecha: Date | string | null | undefined, que: string) {
  const c = await ultimoCierre(db);
  if (!c) return;
  const f = fecha == null ? new Date() : (fecha instanceof Date ? fecha : new Date(String(fecha).length <= 10 ? `${fecha}T00:00:00` : String(fecha)));
  if (Number.isNaN(f.getTime())) return;
  if (f.getTime() <= finDia(c.hasta).getTime()) {
    const [a, m, d] = c.hasta.split('-');
    throw new BadRequestException(
      `No se puede ${que}: la cuenta con Coffit está cerrada hasta el ${d}/${m}/${a}. `
      + 'Cargalo con fecha de hoy (o como ajuste en la cuenta corriente), o reabrí el último cierre.',
    );
  }
}

const r6 = (n: number) => Math.round((Number(n) || 0) * 1e6) / 1e6;

/**
 * LO QUE COFFIT YA PAGÓ Y TODAVÍA NO SE LE MANDÓ (0119 · 0120), por artículo y
 * en su unidad base (kg el granel, unidades el resto).
 *
 * Un artículo COMPARTIDO tildado «para Coffit» en una factura le cargó el
 * costo al café al comprarlo, pero la mercadería se queda en el depósito
 * mezclada con la de la distribuidora. El cupo es:
 *   + lo comprado así QUE ENTRÓ AL DEPÓSITO (remito, factura o liquidación con
 *     recepción: si el proveedor le entregó directo a Coffit, no hay nada que
 *     mandarle); una NC que devuelve mercadería lo baja;
 *   + el stock que se le cobró al marcar el artículo «uso exclusivo»
 *     (`marca_exclusivo`): si después se desmarca, sigue siendo suyo;
 *   − lo que los envíos ya tomaron de ahí (`cantidad_exclusiva`). Los envíos
 *     anulados devuelven lo que tomaron solos, porque dejan de contar.
 * Sin piso en cero: si se anuló una compra que un envío ya había tomado, el
 * faltante se descuenta de la próxima compra para Coffit y no se pierde.
 */
export async function cupoCafe(tx: any, ids: number[], exceptoEnvioId?: number) {
  const cupo = new Map<number, number>();
  if (!ids.length) return cupo;
  const condsEnvio: any[] = [
    inArray(envioCafeteriaItems.productoId, ids), gt(envioCafeteriaItems.cantidadExclusiva, 0),
    eq(enviosCafeteria.sentido, 'salida'), ne(enviosCafeteria.estado, 'anulado'),
  ];
  if (exceptoEnvioId) condsEnvio.push(ne(enviosCafeteria.id, exceptoEnvioId));
  const [compras, marcas, tomado] = await Promise.all([
    tx.select({
      productoId: comprobanteItems.productoId,
      base: sql<number>`coalesce(sum(${comprobanteItems.cantidad} * coalesce(${presentaciones.tamKg}, 1) * (case
        when ${comprobantes.tipo} in ('remito', 'factura', 'liquidacion') and ${comprobantes.recepcion} then 1
        when ${comprobantes.tipo} = 'nota_credito' and ${comprobantes.recepcion} then -1 else 0 end)), 0)`,
    }).from(comprobanteItems)
      .innerJoin(comprobantes, eq(comprobantes.id, comprobanteItems.comprobanteId))
      .leftJoin(presentaciones, eq(presentaciones.id, comprobanteItems.presentacionId))
      .where(and(
        inArray(comprobanteItems.productoId, ids), eq(comprobanteItems.paraCafeteria, true),
        eq(comprobantes.estado, 'confirmado'),
      ))
      .groupBy(comprobanteItems.productoId),
    tx.select({
      productoId: coffitMovimientos.productoId,
      base: sql<number>`coalesce(sum(${coffitMovimientos.cantidad}), 0)`,
    }).from(coffitMovimientos)
      .where(and(
        inArray(coffitMovimientos.productoId, ids), eq(coffitMovimientos.tipo, 'marca_exclusivo'),
        eq(coffitMovimientos.anulado, false),
      ))
      .groupBy(coffitMovimientos.productoId),
    tx.select({
      productoId: envioCafeteriaItems.productoId,
      base: sql<number>`coalesce(sum(${envioCafeteriaItems.cantidadExclusiva} * (case
        when ${envioCafeteriaItems.modo} = 'unidad' then 1 else coalesce(nullif(${envioCafeteriaItems.tamKg}, 0), 1) end)), 0)`,
    }).from(envioCafeteriaItems)
      .innerJoin(enviosCafeteria, eq(enviosCafeteria.id, envioCafeteriaItems.envioId))
      .where(and(...condsEnvio))
      .groupBy(envioCafeteriaItems.productoId),
  ]);
  const sumar = (id: number | null, v: number) => { if (id != null) cupo.set(id, (cupo.get(id) ?? 0) + v); };
  for (const c of compras) sumar(c.productoId, Number(c.base) || 0);
  for (const m of marcas) sumar(m.productoId, Number(m.base) || 0);
  for (const e of tomado) sumar(e.productoId, -(Number(e.base) || 0));
  for (const [k, v] of cupo) cupo.set(k, r6(v));
  return cupo;
}

/** El costo de un artículo para Coffit: el neto (Gerencia) y el precio final (lo que paga, 0176). */
export type CostoCafe = { neto: number; final: number };

/**
 * EL PRECIO FINAL SIN FACTURA A MANO (0176): del costo neto del formato de
 * compra, la parte facturada con su IVA y la parte sin factura tal cual (no
 * se pagó IVA). Lo que elabora Coffit no lleva IVA: es el costo que declaró.
 */
export function finalDelFormato(neto: number, iva: number, porcSinFactura: number, deCoffit = false): number {
  if (deCoffit) return neto;
  const q = Math.min(Math.max(Number(porcSinFactura) || 0, 0), 100) / 100;
  return neto * ((1 - q) * (1 + (Number(iva) || 0) / 100) + q);
}

/**
 * LO QUE VALE UN ARTÍCULO PARA COFFIT (0176), por unidad base: el de su última
 * factura (`costoUltimaFactura`) y, sin factura, el de su formato de compra.
 */
export function costoCafe(
  prod: { id: number; iva?: number | null; origenCafeteria?: boolean | null }, formato: any, ultima: Map<number, CostoCafe>,
): CostoCafe {
  const u = ultima.get(prod.id);
  if (u) return u;
  const neto = costoNetoEntry(formato, Number(prod.iva) || 0);
  return { neto, final: finalDelFormato(neto, Number(prod.iva) || 0, formato?.porcSinFactura, !!prod.origenCafeteria) };
}

/**
 * $ por unidad base (kg o u.) de la ÚLTIMA factura (o liquidación) de cada
 * producto (decisión del dueño, 29/9/2026): el neto del renglón con su
 * descuento y la bonificación general ya repartida, y su PRECIO FINAL —el
 * renglón con su parte del IVA y de las percepciones de la factura, la misma
 * cuenta que `finalCafeteria`—, que es lo que se le cobra a Coffit (0176).
 * Una sola consulta con DISTINCT ON.
 */
export async function costoUltimaFactura(tx: any, ids: number[]): Promise<Map<number, CostoCafe>> {
  const out = new Map<number, CostoCafe>();
  if (!ids.length) return out;
  const r = await tx.execute(sql`
    select distinct on (ci.producto_id) ci.producto_id as "productoId",
      ci.subtotal / nullif(ci.cantidad * coalesce(p.tam_kg, 1), 0) as neto,
      (ci.subtotal
        + coalesce(c.iva_total * ci.subtotal * ci.iva / nullif(d.base_iva, 0), 0)
        + coalesce(c.percepciones_total * ci.subtotal / nullif(c.subtotal_neto, 0), 0))
        / nullif(ci.cantidad * coalesce(p.tam_kg, 1), 0) as final
    from comprobante_items ci
      join comprobantes c on c.id = ci.comprobante_id
      left join presentaciones p on p.id = ci.presentacion_id
      cross join lateral (select sum(x.subtotal * x.iva) as base_iva from comprobante_items x where x.comprobante_id = c.id) d
    where ci.producto_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
      and c.estado = 'confirmado' and c.tipo in ('factura', 'liquidacion')
      and ci.cantidad > 0 and ci.subtotal > 0
    order by ci.producto_id, c.fecha desc, c.id desc, ci.id desc`);
  const r4 = (n: number) => Math.round(n * 10000) / 10000;
  for (const f of filasDe(r)) {
    const neto = Number(f.neto);
    if (neto > 0) out.set(Number(f.productoId), { neto: r4(neto), final: r4(Number(f.final) || neto) });
  }
  return out;
}
