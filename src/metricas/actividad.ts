/**
 * DÍAS ABIERTOS Y TURNOS (9/11/2026, pedido del dueño)
 * ============================================================================
 * «Hay meses con muchos feriados: al medir el mes parece que se vendió menos,
 * pero es porque no se abrió.» Cada período de Rentabilidad, Resultados,
 * Métricas, Indicadores y la Vista profesional dice cuántos días se abrió y
 * cuántos turnos hubo, y la venta se mide también POR DÍA ABIERTO.
 *
 * LA REGLA (una sola, para todas las pantallas):
 *   · Un local ABRIÓ un día si ese día hizo al menos una venta de mostrador:
 *     confirmada o pendiente de CAE, con turno de caja (los pedidos de la tienda
 *     no tienen: entran aunque el local esté cerrado) y que no sea una nota de
 *     crédito. El día es el de Argentina.
 *   · Los TURNOS son los turnos de caja que se abrieron ese día. Van aparte y no
 *     miden días: hay locales que cierran la caja cada tantos días (0214).
 *   · El negocio abrió un día si abrió al menos un local; «días-local» suma los
 *     de cada local (3 locales × 25 días = 75), lo justo si uno cerró y otro no.
 *   · Los días sin abrir se deducen (no hace falta cargar feriados) y se listan
 *     para ver de un vistazo que son los feriados y no un error.
 *
 * Los días que todavía no llegaron no cuentan: el mes en curso va hasta hoy.
 */
import type { PoolClient } from 'pg';
import { ZONA_AR, hoyAr, sumarDias } from '../cafeteria/cuenta';

type Consultable = Pick<PoolClient, 'query'>;

/** Un local en un día: si abrió (vendió en el mostrador) y cuántos turnos de caja se abrieron. */
export interface DiaLocal { dia: string; suc: number; abrio: boolean; turnos: number }

export interface Actividad {
  /** Días del período (hasta hoy). */
  dias: number;
  /** Días en que abrió al menos un local. */
  abiertos: number;
  /** La suma de los días de cada local. */
  diasLocal: number;
  turnos: number;
  /** Los días del período en que no abrió ningún local ('AAAA-MM-DD'). */
  sinAbrir: string[];
  porSucursal: Record<number, { dias: number; turnos: number }>;
}

const RANGO = (col: string) =>
  `${col} >= ($1::date)::timestamp at time zone '${ZONA_AR}' and ${col} < ($2::date + 1)::timestamp at time zone '${ZONA_AR}'`;

/** Día por día y local por local, de `desde` a `hasta` (inclusive). Solo los días con venta o con turno. */
export async function diasPorLocal(c: Consultable, desde: string, hasta: string, sucursalId: number | null = null): Promise<DiaLocal[]> {
  const params: unknown[] = sucursalId ? [desde, hasta, sucursalId] : [desde, hasta];
  const deLocal = (col: string) => (sucursalId ? ` and ${col} = $3` : '');
  const r = await c.query(`
    with v as (
      select distinct (v.fecha at time zone '${ZONA_AR}')::date as dia, v.sucursal_id as suc
      from ventas v
      where v.estado in ('confirmada', 'pendiente_cae') and v.caja_sesion_id is not null
        and v.tipo::text not like 'nota_credito%' and ${RANGO('v.fecha')}${deLocal('v.sucursal_id')}
    ), t as (
      select (cs.apertura at time zone '${ZONA_AR}')::date as dia, cs.sucursal_id as suc, count(*)::int as turnos
      from caja_sesiones cs
      where ${RANGO('cs.apertura')}${deLocal('cs.sucursal_id')}
      group by 1, 2
    )
    select to_char(coalesce(v.dia, t.dia), 'YYYY-MM-DD') as dia, coalesce(v.suc, t.suc) as suc,
      v.dia is not null as abrio, coalesce(t.turnos, 0) as turnos
    from v full join t on t.dia = v.dia and t.suc = v.suc`, params);
  return r.rows.map((x: any) => ({ dia: x.dia, suc: Number(x.suc), abrio: x.abrio === true, turnos: Number(x.turnos) || 0 }));
}

/** Lo de un período, a partir de los días por local (sirve para cortar un rango largo en meses o semanas). */
export function resumirActividad(filas: DiaLocal[], desde: string, hasta: string, hoy: string): Actividad {
  const fin = hasta < hoy ? hasta : hoy;
  const abiertos = new Set<string>();
  const porSucursal: Actividad['porSucursal'] = {};
  let turnos = 0;
  let diasLocal = 0;
  for (const f of filas) {
    if (f.dia < desde || f.dia > fin) continue;
    const s = (porSucursal[f.suc] ??= { dias: 0, turnos: 0 });
    s.turnos += f.turnos;
    turnos += f.turnos;
    if (f.abrio) { s.dias += 1; diasLocal += 1; abiertos.add(f.dia); }
  }
  const sinAbrir: string[] = [];
  let dias = 0;
  for (let d = desde; d <= fin; d = sumarDias(d, 1)) {
    dias += 1;
    if (!abiertos.has(d)) sinAbrir.push(d);
  }
  return { dias, abiertos: abiertos.size, diasLocal, turnos, sinAbrir, porSucursal };
}

/** Los días abiertos y turnos de un período (con o sin local). */
export async function leerActividad(c: Consultable, f: { desde: string; hasta: string; sucursalId: number | null }, hoy = hoyAr()) {
  return resumirActividad(await diasPorLocal(c, f.desde, f.hasta, f.sucursalId), f.desde, f.hasta, hoy);
}

/** La venta por día abierto (null si no abrió ningún día). */
export const porDiaAbierto = (monto: number, a: Pick<Actividad, 'abiertos'>) =>
  (a.abiertos > 0 ? Math.round((monto / a.abiertos) * 100) / 100 : null);
