/**
 * SIN STOCK DESDE CUÁNDO (29/10/2026, pedido del dueño)
 * ============================================================================
 * «Quiero ver desde cuándo están sin stock en los express: controlo que tengan
 * completos sus estantes y que siempre hagan el pedido.» Para cada artículo
 * (el suelto o un paquete) que en una sucursal tiene hoy 0 o menos DISPONIBLE
 * —el mismo número que muestra la consulta de existencias—:
 *
 *   · DESDE CUÁNDO: el último movimiento que lo dejó sin stock, es decir, el
 *     que lo pasó de más de 0 a 0 o menos. Sale de la misma cuenta que la
 *     ficha de movimientos (`kardex.ts`): el stock de hoy, hacia atrás,
 *     movimiento por movimiento. Un AJUSTE (control de stock o corrección a
 *     mano) que lo dejó en 0 también marca la fecha: alguien lo contó.
 *   · HAY QUE CONTARLO (`contar`): el número no es confiable porque se vendió
 *     (o se dio de baja) sin stock en el sistema —si se vendió, había—. Pasa
 *     de dos formas, las dos vistas en los datos reales (29/10):
 *       – en el sistema nunca pasó de 0 en ese local: el jarabe Vita Biosa en
 *         Express 3 vendió 2 sin stock cargado y el pedido que llegó lo dejó
 *         en 0. La fecha es la del último movimiento: desde ahí está como está.
 *       – después de quedar en 0 se siguió vendiendo: un paquete en Express 3
 *         quedó en 0 el 8/10, vendió 11 más, llegaron 10 y hoy está en −3. El
 *         estante no estaba vacío; el que estaba mal era el número.
 *   · NUNCA TUVO: ni un movimiento en ese local desde que hay registro.
 *   · SI LO PIDIERON: el último pedido entre sucursales hacia ese local que lo
 *     lleva, hecho después de esa fecha (o cualquiera, si nunca tuvo). Uno
 *     cancelado no cuenta; el que se está armando sí, como «sin enviar».
 *
 * Solo lectura, a pedido: corre al abrir la consulta, no en una venta.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../db/drizzle';
import { SQL_MOVS_DISPONIBLE, claveSaldo, disponibleHoy, disponiblePorProducto, type MovConDeltas } from './kardex';

export type { MovConDeltas };

const EPS = 1e-9;
const r3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;
const filas = (r: any) => (r.rows ?? r) as any[];

/** Desde cuándo está sin stock: el movimiento, y si el número no es confiable (`contar`). */
export interface Quiebre { mov: MovConDeltas; contar: boolean }

/**
 * Para cada artículo que hoy está en 0 o menos: el movimiento que lo dejó sin
 * stock o, si en el sistema nunca pasó de 0, el último que tuvo ahí.
 * `null` = ni un movimiento: nunca tuvo. `movs` en orden de id ascendente;
 * `hoy`, el stock actual por clave (sucursal|paquete|estado).
 */
export function quiebres(movs: MovConDeltas[], hoy: Map<string, number>, sinStock: string[]) {
  const buscadas = new Set(sinStock);
  const saldo = new Map<string, number>();
  for (const k of buscadas) saldo.set(k, r3(hoy.get(k) ?? 0));
  const out = new Map<string, Quiebre | null>();
  for (const k of buscadas) out.set(k, null);
  /* Lo que se vendió o se dio de baja dejándolo en negativo, después del quiebre: había y el sistema no lo sabía. */
  const enNegativo = new Set<string>();
  const pendientes = new Set(buscadas);
  for (let i = movs.length - 1; i >= 0 && pendientes.size; i--) {
    const m = movs[i];
    for (const d of m.deltas) {
      const k = claveSaldo(d);
      if (!pendientes.has(k)) continue;
      const despues = saldo.get(k)!;
      const antes = r3(despues - d.delta);
      saldo.set(k, antes);
      /* El último que tocó el artículo queda de respaldo, por si nunca pasó de 0. */
      if (!out.get(k)) out.set(k, { mov: m, contar: true });
      /* Hacia atrás, el primero que encontramos donde ANTES había y DESPUÉS no,
       * o un AJUSTE que lo dejó en 0 (alguien lo contó). */
      if ((antes > EPS || m.tipo === 'ajuste') && despues <= EPS) {
        out.set(k, { mov: m, contar: enNegativo.has(k) || despues < -EPS });
        pendientes.delete(k);
      } else if (d.delta < 0 && despues < -EPS) {
        enNegativo.add(k);
      }
    }
  }
  return out;
}

/** Lo que viaja por artículo y sucursal (solo los que tienen algo que decir). */
export interface SinStockDesde {
  productoId: number;
  presentacionId: number | null;
  sucursalId: number;
  /** Cuándo se quedó sin stock; null = nunca tuvo (desde que hay registro). */
  desde: string | null;
  /** Qué movimiento lo vació (venta, transferencia, ajuste…). */
  tipo: string | null;
  /** El número no es confiable: se vendió sin stock en el sistema (ver arriba). Hay que contarlo. */
  contar: boolean;
  pedido: { id: number; codigo: string; fecha: string; estado: string; pedido: number; preparado: number; recibido: number | null } | null;
}

export async function sinStockDesde(db: Database) {
  const [prods, pres, sucs, stockRows, movRows, itemRows] = await Promise.all([
    db.execute(sql`SELECT id FROM productos WHERE estado <> 'archivado' AND solo_cafeteria = false`),
    db.execute(sql`SELECT id, producto_id, tam_kg FROM presentaciones`),
    db.execute(sql`SELECT id FROM sucursales WHERE activa = true`),
    db.execute(sql`SELECT producto_id, sucursal_id, presentacion_id, cantidad FROM stock WHERE estado = 'disponible'`),
    db.execute(sql`SELECT id, fecha, producto_id, tipo::text AS tipo, sucursal_id, presentacion_id, signo, cantidad,
        estado_desde::text AS estado_desde, estado_hacia::text AS estado_hacia
      FROM movimientos WHERE ${sql.raw(SQL_MOVS_DISPONIBLE)}
      ORDER BY id`),
    db.execute(sql`SELECT movimiento_id, presentacion_id, paquetes, tam_kg FROM fraccionamiento_items`),
  ]);
  const tam = new Map(filas(pres).map((p) => [Number(p.id), Number(p.tam_kg)]));
  const presDe = new Map<number, number[]>();
  for (const p of filas(pres)) presDe.set(Number(p.producto_id), [...(presDe.get(Number(p.producto_id)) ?? []), Number(p.id)]);
  const sucIds = filas(sucs).map((s) => Number(s.id));
  const enCatalogo = new Set(filas(prods).map((p) => Number(p.id)));

  /* El stock disponible de hoy y los movimientos de cada producto con lo que movieron (ver kardex.ts). */
  const hoyDe = disponibleHoy(filas(stockRows));
  const movsDe = disponiblePorProducto(filas(movRows), filas(itemRows), (p) => tam.get(p) ?? null);

  /* Por producto: qué está sin stock (el suelto y cada paquete, en cada sucursal activa) y desde cuándo. */
  const out = new Map<string, SinStockDesde>();
  const clave = (pid: number, pres: number | null, suc: number) => `${pid}|${pres ?? 0}|${suc}`;
  for (const p of filas(prods)) {
    const pid = Number(p.id);
    const hoy = hoyDe.get(pid) ?? new Map<string, number>();
    const sinStock: string[] = [];
    for (const suc of sucIds) {
      for (const presId of [0, ...(presDe.get(pid) ?? [])]) {
        const k = claveSaldo({ sucursalId: suc, presentacionId: presId, estado: 'disponible' });
        if ((hoy.get(k) ?? 0) <= EPS) sinStock.push(k);
      }
    }
    if (!sinStock.length) continue;
    for (const [k, q] of quiebres(movsDe.get(pid) ?? [], hoy, sinStock)) {
      if (!q) continue;
      const [suc, presId] = k.split('|').map(Number);
      out.set(clave(pid, presId || null, suc), {
        productoId: pid, presentacionId: presId || null, sucursalId: suc,
        desde: new Date(q.mov.fecha).toISOString(), tipo: q.mov.tipo, contar: q.contar, pedido: null,
      });
    }
  }

  /*
   * EL PEDIDO de cada artículo hacia cada local (sin los cancelados): el último
   * ENVIADO después de que se quedó sin stock (si nunca tuvo, cualquiera); si
   * no hay ninguno, el que se está armando (borrador), que todavía no salió.
   * Van del más nuevo al más viejo: el primero que sirve gana.
   */
  const pedidos = filas(await db.execute(sql`
    SELECT t.id, t.codigo, t.fecha, t.estado::text AS estado, t.destino_id, ti.producto_id, ti.presentacion_id,
      ti.cantidad, ti.cantidad_preparada, ti.cantidad_recibida
    FROM transferencia_items ti
    JOIN transferencias t ON t.id = ti.transferencia_id
    WHERE t.estado <> 'cancelada' AND (ti.cantidad > 0 OR ti.cantidad_preparada > 0)
    ORDER BY t.fecha DESC, t.id DESC`));
  const hoyDeClave = (pid: number, presId: number, suc: number) =>
    hoyDe.get(pid)?.get(claveSaldo({ sucursalId: suc, presentacionId: presId, estado: 'disponible' })) ?? 0;
  const enviado = new Map<string, any>();
  const borrador = new Map<string, any>();
  for (const t of pedidos) {
    const pid = Number(t.producto_id), presId = Number(t.presentacion_id ?? 0), suc = Number(t.destino_id);
    if (!enCatalogo.has(pid) || !sucIds.includes(suc) || hoyDeClave(pid, presId, suc) > EPS) continue;
    const k = clave(pid, presId || null, suc);
    if (t.estado === 'borrador') { if (!borrador.has(k)) borrador.set(k, t); continue; }
    if (enviado.has(k)) continue;
    const desde = out.get(k)?.desde;
    if (desde && new Date(t.fecha) < new Date(desde)) continue;
    enviado.set(k, t);
  }
  for (const k of new Set([...enviado.keys(), ...borrador.keys()])) {
    const t = enviado.get(k) ?? borrador.get(k);
    const [pid, presId, suc] = k.split('|').map(Number);
    const pedido = {
      id: Number(t.id), codigo: t.codigo || '', fecha: new Date(t.fecha).toISOString(), estado: t.estado,
      pedido: r3(t.cantidad), preparado: r3(t.cantidad_preparada), recibido: t.cantidad_recibida == null ? null : r3(t.cantidad_recibida),
    };
    const ya = out.get(k);
    out.set(k, ya ? { ...ya, pedido } : { productoId: pid, presentacionId: presId || null, sucursalId: suc, desde: null, tipo: null, contar: false, pedido });
  }

  /* Desde cuándo hay registro: antes de eso, «nunca tuvo» quiere decir «no desde que se usa el sistema». */
  const [primero] = filas(await db.execute(sql`SELECT min(fecha) AS f FROM movimientos`));
  return { registroDesde: primero?.f ? new Date(primero.f).toISOString() : null, items: [...out.values()] };
}
