/**
 * MÉTRICAS › SUCURSALES (6/11/2026, pedido del dueño)
 * ============================================================================
 * Lo que vende cada local: venta, tickets y ticket promedio, contra el período
 * anterior; por TURNO (mañana y tarde) y por HORA. Lee las tablas resumen
 * (`metricas_venta_dia` y `metricas_venta_hora`), como el resto de Métricas.
 *
 * DOS FUENTES, A PROPÓSITO:
 *   · el resumen de cada local sale de `metricas_venta_dia`, que RESTA las notas
 *     de crédito: es la misma venta neta que la pestaña Ventas y Resultados;
 *   · turno y hora salen de `metricas_venta_hora`, que cuenta solo VENTAS (una
 *     devolución no tiene «hora de venta»). Por eso la suma de los turnos puede
 *     quedar apenas arriba del total del local: la diferencia son las notas.
 *
 * EL TURNO es la regla de todo el sistema (fraccionamiento, Cash Flow): mañana
 * antes de las 14 h, tarde desde las 14 h (`TURNO_TARDE_DESDE`). «Turnos» cuenta
 * los días que ese local vendió algo en esa franja: con eso sale la venta y los
 * tickets PROMEDIO POR TURNO, que es lo que se compara entre mañana y tarde
 * (un local abre más tardes que mañanas y el total solo no lo muestra).
 */
import type { PoolClient } from 'pg';
import { TURNO_TARDE_DESDE } from '../inventario/inventario.service';
import { hoyAr } from '../cafeteria/cuenta';
import { N, donde, pct, periodoAnterior, periodos, r2, variacion, type Filtro } from './consultas';

/** La misma regla que fraccionamiento y Cash Flow: un solo lugar. */
export const TARDE_DESDE = TURNO_TARDE_DESDE;
export const TURNOS = ['manana', 'tarde'] as const;
export type Turno = (typeof TURNOS)[number];
export const turnoDeHora = (h: number): Turno => (h < TARDE_DESDE ? 'manana' : 'tarde');

const prom = (v: number, n: number) => (n > 0 ? r2(v / n) : 0);

type FilaDia = { sucursal_id: unknown; tickets: unknown; venta_neta: unknown; dias: unknown };
type FilaHora = { sucursal_id: unknown; dia: string; hora: unknown; tickets: unknown; venta_neta: unknown };
type FilaFecha = { sucursal_id: unknown; dia: string; tickets: unknown; venta_neta: unknown };

/**
 * LOS DÍAS QUE SE MUESTRAN (6/11/2026, pedido del dueño: «del 1 hasta el último
 * día del mes»). Si el período cae en un solo mes, se completa hasta el último
 * día de ese mes —los que todavía no llegaron van vacíos—; si abarca varios
 * meses, son los días del período.
 */
export function diasDelPeriodo(desde: string, hasta: string): string[] {
  const mismoMes = desde.slice(0, 7) === hasta.slice(0, 7);
  if (!mismoMes) return periodos(desde, hasta, 'dia');
  const [y, m] = hasta.split('-').map(Number);
  const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return periodos(desde, `${hasta.slice(0, 8)}${String(ultimo).padStart(2, '0')}`, 'dia');
}

/** La cuenta, sin base: recibe las filas y arma el reporte (así se prueba sola). */
export function armarLocales(
  dia: FilaDia[], anterior: FilaDia[], hora: FilaHora[], nombres: Map<number, string>,
  fechas: { lista: string[]; filas: FilaFecha[]; hoy: string } = { lista: [], filas: [], hoy: '9999-12-31' },
) {
  const ant = new Map(anterior.map((x) => [N(x.sucursal_id), x]));
  const totalVenta = dia.reduce((a, x) => a + N(x.venta_neta), 0);

  /* Por local × turno y por local × hora: tickets, venta y en cuántos días hubo venta ahí. */
  type Acum = { tickets: number; venta: number; dias: Set<string> };
  const nuevo = (): Acum => ({ tickets: 0, venta: 0, dias: new Set() });
  const porTurno = new Map<string, Acum>();
  const porHora = new Map<string, Acum>();
  const sumar = (m: Map<string, Acum>, k: string, x: FilaHora) => {
    const a = m.get(k) ?? nuevo();
    a.tickets += N(x.tickets); a.venta += N(x.venta_neta);
    if (N(x.tickets) > 0) a.dias.add(x.dia);
    m.set(k, a);
  };
  for (const x of hora) {
    const s = N(x.sucursal_id); const h = N(x.hora);
    for (const suc of [s, 'todas']) {
      sumar(porTurno, `${suc}|${turnoDeHora(h)}`, x);
      sumar(porHora, `${suc}|${h}`, x);
    }
  }
  const celda = (a?: Acum) => {
    const tickets = a?.tickets ?? 0; const venta = r2(a?.venta ?? 0); const dias = a?.dias.size ?? 0;
    return { tickets, ventaNeta: venta, ticketPromedio: prom(venta, tickets), dias, ventaPorDia: prom(venta, dias), ticketsPorDia: prom(tickets, dias) };
  };
  const turnosDe = (suc: number | 'todas') => Object.fromEntries(TURNOS.map((t) => [t, celda(porTurno.get(`${suc}|${t}`))]));
  const horasConVenta = [...new Set(hora.filter((x) => N(x.tickets) > 0).map((x) => N(x.hora)))].sort((a, b) => a - b);
  const horasDe = (suc: number | 'todas') => horasConVenta.map((h) => ({ hora: h, turno: turnoDeHora(h), ...celda(porHora.get(`${suc}|${h}`)) }));

  /* Día por día (con las notas restadas, como el total del local). */
  const porFecha = new Map<string, { tickets: number; venta: number }>();
  for (const x of fechas.filas) {
    for (const suc of [N(x.sucursal_id), 'todas']) {
      const k = `${suc}|${x.dia}`;
      const a = porFecha.get(k) ?? { tickets: 0, venta: 0 };
      a.tickets += N(x.tickets); a.venta += N(x.venta_neta);
      porFecha.set(k, a);
    }
  }
  const diasDe = (suc: number | 'todas') => fechas.lista.map((f) => {
    const a = porFecha.get(`${suc}|${f}`);
    const tickets = a?.tickets ?? 0; const venta = r2(a?.venta ?? 0);
    return { dia: f, tickets, ventaNeta: venta, ticketPromedio: prom(venta, tickets), futuro: f > fechas.hoy };
  });

  const sucursales = dia
    .map((x) => {
      const id = N(x.sucursal_id);
      const tickets = N(x.tickets); const venta = r2(N(x.venta_neta)); const dias = N(x.dias);
      const a = ant.get(id);
      const tA = N(a?.tickets); const vA = r2(N(a?.venta_neta));
      return {
        sucursalId: id,
        nombre: nombres.get(id) ?? (id === 0 ? 'Sin sucursal' : `Sucursal #${id}`),
        tickets, ventaNeta: venta, ticketPromedio: prom(venta, tickets),
        participacion: pct(venta, totalVenta), diasConVenta: dias, ventaPorDia: prom(venta, dias),
        anterior: { tickets: tA, ventaNeta: vA, ticketPromedio: prom(vA, tA) },
        variacionVenta: variacion(venta, vA), variacionTickets: variacion(tickets, tA),
        variacionPromedio: variacion(prom(venta, tickets), prom(vA, tA)),
        turnos: turnosDe(id),
        horas: horasDe(id),
        dias: diasDe(id),
      };
    })
    .filter((x) => x.tickets > 0 || x.ventaNeta !== 0)
    .sort((a, b) => b.ventaNeta - a.ventaNeta);

  const tTickets = sucursales.reduce((a, x) => a + x.tickets, 0);
  const tVenta = r2(sucursales.reduce((a, x) => a + x.ventaNeta, 0));
  const tAntT = anterior.reduce((a, x) => a + N(x.tickets), 0);
  const tAntV = r2(anterior.reduce((a, x) => a + N(x.venta_neta), 0));
  return {
    sucursales,
    total: {
      tickets: tTickets, ventaNeta: tVenta, ticketPromedio: prom(tVenta, tTickets),
      anterior: { tickets: tAntT, ventaNeta: tAntV, ticketPromedio: prom(tAntV, tAntT) },
      variacionVenta: variacion(tVenta, tAntV), variacionTickets: variacion(tTickets, tAntT),
      variacionPromedio: variacion(prom(tVenta, tTickets), prom(tAntV, tAntT)),
      turnos: turnosDe('todas'),
      horas: horasDe('todas'),
      dias: diasDe('todas'),
    },
    tardeDesde: TARDE_DESDE,
  };
}

export async function reporteLocales(c: PoolClient, f: Filtro) {
  const ant = periodoAnterior(f);
  const w = donde(f, 'd'); const wa = donde(ant, 'd'); const wh = donde(f, 'h');
  const porDia = (where: { sql: string; params: unknown[] }) => c.query(
    `SELECT d.sucursal_id, sum(d.tickets)::float8 AS tickets, sum(d.venta_neta) AS venta_neta,
       count(DISTINCT d.dia) FILTER (WHERE d.tickets > 0)::float8 AS dias
     FROM metricas_venta_dia d WHERE ${where.sql} GROUP BY 1`, where.params);
  const [dia, anterior, hora, sucs, fechas] = await Promise.all([
    porDia(w),
    porDia(wa),
    c.query(
      `SELECT h.sucursal_id, to_char(h.dia, 'YYYY-MM-DD') AS dia, h.hora::int AS hora, h.tickets::float8 AS tickets, h.venta_neta
       FROM metricas_venta_hora h WHERE ${wh.sql}`, wh.params),
    c.query('SELECT id, nombre FROM sucursales'),
    c.query(
      `SELECT d.sucursal_id, to_char(d.dia, 'YYYY-MM-DD') AS dia, sum(d.tickets)::float8 AS tickets, sum(d.venta_neta) AS venta_neta
       FROM metricas_venta_dia d WHERE ${w.sql} GROUP BY 1, 2`, w.params),
  ]);
  const nombres = new Map<number, string>(sucs.rows.map((x: any) => [N(x.id), String(x.nombre)]));
  return {
    desde: f.desde, hasta: f.hasta,
    anteriorDesde: ant.desde, anteriorHasta: ant.hasta,
    ...armarLocales(dia.rows, anterior.rows, hora.rows, nombres, { lista: diasDelPeriodo(f.desde, f.hasta), filas: fechas.rows, hoy: hoyAr() }),
  };
}
