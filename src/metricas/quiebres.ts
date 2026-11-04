/**
 * ALMACÉN › QUIEBRES DE STOCK (4/11/2026, pedido del dueño; nació en Métricas
 * y se mudó a Almacén el mismo día — la cuenta vive acá por el pool propio)
 * ============================================================================
 * «¿En alguna parte del ERP puedo ver quiebres de stock?» Lo que había era la
 * foto de hoy (qué está en 0 y desde cuándo). Esto es el PERÍODO: de cada
 * artículo (el suelto o un paquete) en cada local,
 *
 *   · cuántas veces se quedó sin stock y cuántos días estuvo así;
 *   · si hoy sigue sin stock;
 *   · cuánto se dejó de vender: lo que vendía por día cuando tenía, por los
 *     días que no tuvo, al precio promedio al que se vendió (neto, sin IVA).
 *
 * SALE DE LOS MOVIMIENTOS, con la misma cuenta que «Sin stock desde cuándo» y
 * la ficha de movimientos (`inventario/kardex.ts`): el disponible de hoy, hacia
 * atrás, da el de cualquier momento. Nada que registrar de nuevo.
 *
 * REGLAS (las de la cuenta pura `seguirArticulo`, probadas en quiebres.test.ts):
 *   · SIN STOCK es el disponible en 0 o menos, el mismo número de Existencias.
 *   · Un tramo de menos de una hora no cuenta: es el paso de un movimiento a
 *     otro (se fraccionó, se transfirió), no un estante vacío.
 *   · HAY QUE CONTARLO: si estando en 0 se vendió, había mercadería y el que
 *     estaba mal era el número. Esos días van aparte («dudosos») y no suman ni
 *     a los días sin stock ni a lo que se dejó de vender.
 *   · EL RITMO DE VENTA sale del período más los 30 días anteriores, contando
 *     solo el tiempo CON stock (si no, los días vacíos lo bajarían justo en el
 *     artículo que más falta). Días de calendario, igual que los días sin stock.
 *     Con menos de 3 días con stock no se estima: un día suelto no es un ritmo.
 *   · ANTES DEL REGISTRO NO SE SABE: si la ventana arranca en el primer
 *     movimiento del sistema, un artículo en 0 ahí todavía no tenía su carga
 *     inicial (entró después, por ajuste). Ese tramo no es un quiebre: es un
 *     dato que falta, y tampoco mide el ritmo — salvo que se haya vendido en
 *     él: entonces había mercadería y cuenta como tiempo con stock.
 *   · Solo los artículos que el local TRABAJA: tuvieron stock o se vendieron en
 *     esa ventana. Lo que un local nunca tuvo no es un quiebre: eso lo dice
 *     Existencias (Alt+F3, «nunca tuvo» / «Faltan en»).
 *   · Sin Coffit, sin archivados ni discontinuados (se espera que se terminen),
 *     solo sucursales activas.
 *
 * Solo lectura, a pedido, sobre el pool propio de métricas (no frena una caja).
 */
import type { PoolClient } from 'pg';
import { hoyAr, sumarDias } from '../cafeteria/cuenta';
import { SQL_MOVS_DISPONIBLE, claveSaldo, disponibleHoy, disponiblePorProducto } from '../inventario/kardex';
import { formatoActivo } from '../inventario/pricing';
import type { Filtro } from './consultas';
import { tamPaquete } from './ofertas';

const EPS = 1e-9;
const DIA_MS = 86_400_000;
/** Un tramo en 0 más corto que esto es el paso entre dos movimientos, no un quiebre. */
export const MIN_TRAMO_MS = 60 * 60_000;
/** Días antes del período que también miden el ritmo de venta. */
export const DIAS_RITMO_PREVIO = 30;
/** Menos días con stock que esto no alcanzan para estimar lo que se vende por día. */
export const MIN_DIAS_RITMO = 3;
/** Las salidas que son venta (el resto: transferencias, ajustes, bajas). */
const TIPOS_VENTA = new Set(['venta_granel', 'venta_fraccionada']);

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Un movimiento de UN artículo: cuándo, de qué tipo y cuánto sumó (+) o restó (−). */
export interface PasoStock { fecha: number; tipo: string; delta: number }

/**
 * Las tres marcas de tiempo (ms): desde dónde se sigue, dónde empieza el período
 * y dónde termina. `conHistoria`: hay movimientos antes de `base`, así que el
 * saldo ahí es real (si no, `base` es el arranque del sistema: ver arriba).
 */
export interface Tiempos { base: number; inicio: number; fin: number; conHistoria: boolean }

export interface Seguimiento {
  /** Tramos sin stock de verdad, dentro del período (ms). */
  sinStockMs: number;
  /** En 0 pero vendiendo: el número no era real (ms, dentro del período). */
  dudosoMs: number;
  /** Quiebres que EMPEZARON en el período. */
  veces: number;
  /** Ya estaba sin stock cuando empezó el período. */
  venia: boolean;
  /** Desde cuándo está sin stock al final (ms), si terminó sin stock. */
  sinStockDesde: number | null;
  /** Lo vendido y el tiempo con stock en la ventana del ritmo (base → fin). */
  vendido: number;
  conStockMs: number;
  /** Tuvo stock o se vendió en la ventana: el local trabaja el artículo. */
  trabaja: boolean;
}

/**
 * La cuenta de UN artículo en UN local. `pasos` en orden cronológico y solo
 * los de la ventana (`base` → `fin`); `saldo` es el disponible en `base`.
 */
export function seguirArticulo(pasos: PasoStock[], saldo: number, t: Tiempos): Seguimiento {
  const out: Seguimiento = { sinStockMs: 0, dudosoMs: 0, veces: 0, venia: false, sinStockDesde: null, vendido: 0, conStockMs: t.fin - t.base, trabaja: saldo > EPS };
  /* El tramo abierto: desde cuándo, si empezó por un movimiento (y no porque ya
     venía en 0), si se vendió en él y si es el arranque del sistema sin carga (`sinDato`). */
  let tramo: { desde: number; empezo: boolean; vendio: boolean; sinDato: boolean } | null =
    saldo > EPS ? null : { desde: t.base, empezo: false, vendio: false, sinDato: !t.conHistoria };

  const cerrar = (hasta: number, abierto: boolean) => {
    if (!tramo) return;
    const { desde, empezo, vendio, sinDato } = tramo;
    tramo = null;
    if (sinDato) { if (!vendio) out.conStockMs -= hasta - desde; return; }
    if (!abierto && hasta - desde < MIN_TRAMO_MS) return;
    const enPeriodo = Math.max(0, Math.min(hasta, t.fin) - Math.max(desde, t.inicio));
    if (vendio) { out.dudosoMs += enPeriodo; return; }
    out.sinStockMs += enPeriodo;
    out.conStockMs -= hasta - desde;
    if (empezo && desde >= t.inicio) out.veces += 1;
    if (desde <= t.inicio && hasta > t.inicio) out.venia = true;
    if (abierto) out.sinStockDesde = desde;
  };

  for (const p of pasos) {
    const antes = saldo;
    saldo = r3(saldo + p.delta);
    const esVenta = TIPOS_VENTA.has(p.tipo) && p.delta < 0;
    if (esVenta) { out.vendido += -p.delta; out.trabaja = true; }
    if (saldo > EPS) out.trabaja = true;
    if (tramo && esVenta && antes <= EPS) tramo.vendio = true;
    if (antes > EPS && saldo <= EPS) tramo = { desde: p.fecha, empezo: true, vendio: false, sinDato: false };
    else if (antes <= EPS && saldo > EPS) cerrar(p.fecha, false);
  }
  cerrar(t.fin, true);
  out.vendido = r3(out.vendido);
  return out;
}

/** Un artículo en un local que se quedó sin stock en el período (o estuvo en 0 vendiendo). */
export interface ItemQuiebre {
  productoId: number; presentacionId: number | null; sucursalId: number;
  nombre: string; presentacion: string | null; unidad: string; marca: string; categoria: string;
  proveedorId: number | null; proveedor: string;
  veces: number; venia: boolean; diasSinStock: number; diasDudosos: number;
  /** Desde cuándo está sin stock al final del período; null si terminó con stock. */
  sinStockDesde: string | null;
  /** Lo que vendía por día con stock, y lo que se estima que se dejó de vender (null: sin ritmo o sin precio). */
  ventaPorDia: number | null; unidadesPerdidas: number | null; ventaPerdida: number | null;
}

/** Medianoche argentina de un día (la Argentina no cambia la hora). */
const msDeDia = (dia: string) => Date.parse(`${dia}T00:00:00-03:00`);

export async function reporteQuiebres(c: PoolClient, f: Filtro) {
  const q = async (texto: string, params: unknown[] = []) => (await c.query(texto, params)).rows;

  /* Antes del primer movimiento no hay registro: el período arranca ahí como mucho. */
  const [{ primero }] = await q('SELECT min(fecha) AS primero FROM movimientos');
  const registro = primero ? new Date(primero).getTime() : Date.now();
  const inicio = Math.max(msDeDia(f.desde), registro);
  const fin = Math.min(msDeDia(sumarDias(f.hasta, 1)), Date.now());
  const base = Math.max(inicio - DIAS_RITMO_PREVIO * DIA_MS, registro);
  const cabecera = { desde: f.desde, hasta: f.hasta, registroDesde: primero ? new Date(primero).toISOString() : null };
  if (fin <= inicio) return { ...cabecera, totales: null, sucursales: [], items: [] };

  /* Con una sucursal elegida, solo lo de ella: cada movimiento es de una sola sucursal (ver `deltasDe`). */
  const enSuc = (col: string, n: number) => (f.sucursalId ? `AND ${col} = $${n}` : '');
  const conSuc = (p: unknown[]) => (f.sucursalId ? [...p, f.sucursalId] : p);
  const baseIso = new Date(base).toISOString();
  const [prods, pres, sucs, provs, stockRows, movRows, itemRows, precios] = await Promise.all([
    q(`SELECT p.id, p.nombre, p.tipo::text AS tipo, m.nombre AS marca, cat.nombre AS categoria
       FROM productos p LEFT JOIN marcas m ON m.id = p.marca_id LEFT JOIN categorias cat ON cat.id = p.categoria_id
       WHERE p.estado = 'activo' AND p.solo_cafeteria = false`),
    q('SELECT id, producto_id, tam_kg FROM presentaciones'),
    q(`SELECT id, nombre FROM sucursales WHERE activa ${enSuc('id', 1)} ORDER BY id`, conSuc([])),
    q(`SELECT pp.id, pp.producto_id, pp.usar_para_precio AS "usarParaPrecio", pp.proveedor_id, pv.nombre AS proveedor
       FROM producto_proveedores pp LEFT JOIN proveedores pv ON pv.id = pp.proveedor_id`),
    q(`SELECT producto_id, sucursal_id, presentacion_id, cantidad FROM stock WHERE estado = 'disponible' ${enSuc('sucursal_id', 1)}`, conSuc([])),
    q(`SELECT id, fecha, producto_id, tipo::text AS tipo, sucursal_id, presentacion_id, signo, cantidad,
         estado_desde::text AS estado_desde, estado_hacia::text AS estado_hacia
       FROM movimientos WHERE ${SQL_MOVS_DISPONIBLE} AND fecha >= $1 ${enSuc('sucursal_id', 2)} ORDER BY fecha, id`, conSuc([baseIso])),
    q(`SELECT fi.movimiento_id, fi.presentacion_id, fi.paquetes, fi.tam_kg
       FROM fraccionamiento_items fi JOIN movimientos m ON m.id = fi.movimiento_id
       WHERE m.tipo = 'fraccionamiento' AND m.fecha >= $1 ${enSuc('m.sucursal_id', 2)}`, conSuc([baseIso])),
    /* El precio promedio al que se vendió cada artículo en la ventana (neto): por local y, de respaldo, en todos. */
    q(`SELECT sucursal_id, producto_id, presentacion_id, sum(venta_neta)::float8 AS neta, sum(unidades)::float8 AS unidades
       FROM metricas_venta_prod_dia WHERE dia >= $1::date AND unidades > 0
       GROUP BY 1, 2, 3`, [new Date(base - 3 * 3_600_000).toISOString().slice(0, 10)]),
  ]);

  const tam = new Map(pres.map((p) => [Number(p.id), Number(p.tam_kg)]));
  const presDe = new Map<number, number[]>();
  for (const p of pres) presDe.set(Number(p.producto_id), [...(presDe.get(Number(p.producto_id)) ?? []), Number(p.id)]);
  const provsDe = new Map<number, any[]>();
  for (const p of provs) provsDe.set(Number(p.producto_id), [...(provsDe.get(Number(p.producto_id)) ?? []), p]);
  const precioLocal = new Map<string, { neta: number; unidades: number }>();
  const precioTodos = new Map<string, { neta: number; unidades: number }>();
  for (const x of precios) {
    const k = `${x.producto_id}|${x.presentacion_id}`;
    precioLocal.set(`${k}|${x.sucursal_id}`, { neta: Number(x.neta), unidades: Number(x.unidades) });
    const t = precioTodos.get(k) ?? { neta: 0, unidades: 0 };
    precioTodos.set(k, { neta: t.neta + Number(x.neta), unidades: t.unidades + Number(x.unidades) });
  }
  const precioDe = (pid: number, presId: number, sucId: number) => {
    const p = precioLocal.get(`${pid}|${presId}|${sucId}`) ?? precioTodos.get(`${pid}|${presId}`);
    return p && p.unidades > 0 ? p.neta / p.unidades : null;
  };

  const hoyDe = disponibleHoy(stockRows);
  const movsDe = disponiblePorProducto(movRows, itemRows, (p) => tam.get(p) ?? null);
  const t: Tiempos = { base, inicio, fin, conHistoria: base > registro };
  const diasPeriodo = (fin - inicio) / DIA_MS;
  /* El período llega a hoy: lo que terminó sin stock, sigue sin stock. */
  const llegaAHoy = f.hasta >= hoyAr();

  const items: ItemQuiebre[] = [];
  const porSuc = new Map<number, { trabajados: number; conQuiebre: number; sinStockMs: number; ventaPerdida: number; alFinalSinStock: number }>();
  for (const s of sucs) porSuc.set(Number(s.id), { trabajados: 0, conQuiebre: 0, sinStockMs: 0, ventaPerdida: 0, alFinalSinStock: 0 });

  for (const p of prods) {
    const pid = Number(p.id);
    const hoy = hoyDe.get(pid) ?? new Map<string, number>();
    /* Una sola pasada por los movimientos del producto: los pasos de cada artículo y cuánto se movió desde `base`. */
    const pasosDe = new Map<string, PasoStock[]>();
    const movidoDe = new Map<string, number>();
    for (const m of movsDe.get(pid) ?? []) {
      const fecha = new Date(m.fecha).getTime();
      for (const d of m.deltas) {
        const k = claveSaldo(d);
        movidoDe.set(k, (movidoDe.get(k) ?? 0) + d.delta);
        if (fecha >= fin) continue;
        const l = pasosDe.get(k) ?? [];
        l.push({ fecha, tipo: m.tipo, delta: d.delta });
        pasosDe.set(k, l);
      }
    }
    const formato: any = formatoActivo(provsDe.get(pid) ?? []);
    for (const s of sucs) {
      const sucId = Number(s.id);
      for (const presId of [0, ...(presDe.get(pid) ?? [])]) {
        const clave = claveSaldo({ sucursalId: sucId, presentacionId: presId, estado: 'disponible' });
        const ahora = hoy.get(clave) ?? 0;
        if (!movidoDe.has(clave) && ahora <= EPS) continue; // ni tuvo ni se movió: el local no lo trabaja
        /* El saldo en `base`: el de hoy menos todo lo que se movió desde entonces. */
        const seg = seguirArticulo(pasosDe.get(clave) ?? [], r3(ahora - (movidoDe.get(clave) ?? 0)), t);
        if (!seg.trabaja) continue;
        const acum = porSuc.get(sucId)!;
        acum.trabajados += 1;
        if (!seg.sinStockMs && !seg.dudosoMs) continue;

        const porDia = seg.conStockMs >= MIN_DIAS_RITMO * DIA_MS ? seg.vendido / (seg.conStockMs / DIA_MS) : null;
        const precio = precioDe(pid, presId, sucId);
        const unidadesPerdidas = porDia == null ? null : r3(porDia * (seg.sinStockMs / DIA_MS));
        const ventaPerdida = unidadesPerdidas == null || precio == null ? null : r2(unidadesPerdidas * precio);
        if (seg.sinStockMs) {
          acum.conQuiebre += 1;
          acum.sinStockMs += seg.sinStockMs;
          acum.ventaPerdida += ventaPerdida ?? 0;
        }
        if (seg.sinStockDesde != null) acum.alFinalSinStock += 1;
        items.push({
          productoId: pid, presentacionId: presId || null, sucursalId: sucId,
          nombre: String(p.nombre), presentacion: presId ? tamPaquete(tam.get(presId) ?? 0) : null,
          unidad: presId ? 'paq.' : p.tipo === 'granel' ? 'kg' : 'u.',
          marca: p.marca ?? '', categoria: p.categoria ?? '',
          proveedorId: formato?.proveedor_id ?? null, proveedor: formato?.proveedor ?? '',
          veces: seg.veces, venia: seg.venia,
          diasSinStock: r1(seg.sinStockMs / DIA_MS), diasDudosos: r1(seg.dudosoMs / DIA_MS),
          sinStockDesde: seg.sinStockDesde != null ? new Date(seg.sinStockDesde).toISOString() : null,
          ventaPorDia: porDia == null ? null : r3(porDia), unidadesPerdidas, ventaPerdida,
        });
      }
    }
  }

  const sucursales = sucs.map((s) => {
    const a = porSuc.get(Number(s.id))!;
    return {
      sucursalId: Number(s.id), nombre: String(s.nombre), trabajados: a.trabajados, conQuiebre: a.conQuiebre, alFinalSinStock: a.alFinalSinStock,
      diasSinStock: r1(a.sinStockMs / DIA_MS), ventaPerdida: r2(a.ventaPerdida),
      /* De todo el tiempo que el local podía tener cada artículo en la góndola, cuánto lo tuvo. */
      disponibilidad: a.trabajados ? r1(100 * (1 - a.sinStockMs / DIA_MS / (a.trabajados * diasPeriodo))) : null,
    };
  });
  const tot = sucursales.reduce((x, s) => ({
    trabajados: x.trabajados + s.trabajados, conQuiebre: x.conQuiebre + s.conQuiebre, alFinalSinStock: x.alFinalSinStock + s.alFinalSinStock,
    diasSinStock: x.diasSinStock + s.diasSinStock, ventaPerdida: x.ventaPerdida + s.ventaPerdida,
  }), { trabajados: 0, conQuiebre: 0, alFinalSinStock: 0, diasSinStock: 0, ventaPerdida: 0 });

  return {
    ...cabecera,
    desdeEfectivo: new Date(inicio).toISOString(),
    diasPeriodo: r1(diasPeriodo),
    llegaAHoy,
    totales: {
      ...tot, diasSinStock: r1(tot.diasSinStock), ventaPerdida: r2(tot.ventaPerdida),
      disponibilidad: tot.trabajados ? r1(100 * (1 - tot.diasSinStock / (tot.trabajados * diasPeriodo))) : null,
      dudosos: items.filter((x) => x.diasDudosos > 0).length,
    },
    sucursales,
    items: items.sort((a, b) => (b.ventaPerdida ?? 0) - (a.ventaPerdida ?? 0) || b.diasSinStock - a.diasSinStock),
  };
}
