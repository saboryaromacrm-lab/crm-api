/**
 * MÉTRICAS · EL MOTOR DE SINCRONIZACIÓN (0122, 29/9/2026)
 * ============================================================================
 * Arma las tablas resumen (`metricas_*`) a partir de las ventas y las compras.
 *
 * LA REGLA DE ORO: la venta no espera a las métricas. Este motor SOLO LEE las
 * ventas y escribe en sus propias tablas; nada de esto corre dentro de la
 * transacción de una venta ni la toca.
 *
 * POR QUÉ «BORRAR Y REARMAR UN RANGO DE DÍAS» Y NO «SUMAR LO NUEVO»: una venta
 * cambia después de hacerse (se anula, pasa de `pendiente_cae` a confirmada,
 * una devolución la corrige). Un motor que solo suma lo nuevo se desfasa en
 * silencio. Rearmar los últimos días desde las ventas es idempotente: correrlo
 * dos veces da lo mismo, y correrlo de más no cuesta casi nada (100 ventas por
 * día son milisegundos).
 *
 *   · reciente — hoy y ayer. Lo que corre cada pocos minutos y el botón.
 *   · noche    — los últimos 40 días. Cubre lo que se anuló o corrigió después.
 *   · todo     — desde la primera venta, mes por mes (cada mes su transacción).
 *
 * Mismos criterios que Gerencia › Rentabilidad, para que los números coincidan:
 * cuentan `confirmada` y `pendiente_cae`; las notas de crédito y devoluciones
 * (`tipo like 'nota_credito%'`) RESTAN; el día es el de Argentina.
 */
import type { PoolClient } from 'pg';

/** Lo que alcanza para consultar: un cliente del pool (la sincronización usa UNA sola conexión). */
type Consultable = Pick<PoolClient, 'query'>;
import { sumarDias } from '../cafeteria/cuenta';

export const ZONA = 'America/Argentina/Buenos_Aires';
export const MODOS = ['reciente', 'noche', 'todo'] as const;
export type ModoSync = (typeof MODOS)[number];

/** El rango [desde, hasta] de días (inclusive) como instantes: 00:00 AR del primero a 00:00 AR del siguiente al último. */
const RANGO = (col: string) => `${col} >= ($1::date)::timestamp AT TIME ZONE '${ZONA}'
  AND ${col} < (($2::date + 1))::timestamp AT TIME ZONE '${ZONA}'`;
const DIA = (col: string) => `(${col} AT TIME ZONE '${ZONA}')::date`;
/** Signo y marca de nota de una venta. */
const NOTA = `(v.tipo::text LIKE 'nota_credito%')`;
const SIGNO = `(CASE WHEN ${NOTA} THEN -1 ELSE 1 END)`;
const VALIDA = `v.estado IN ('confirmada', 'pendiente_cae')`;

const TABLAS_DIA = [
  'metricas_venta_prod_dia', 'metricas_venta_dia', 'metricas_venta_hora',
  'metricas_venta_cliente_dia', 'metricas_venta_pago_dia', 'metricas_compra_prov_dia',
] as const;

/** Las sentencias que rearman un rango, en orden. Cada una es un INSERT ... SELECT: nada se trae a Node. */
const REARMAR: string[] = [
  // Lo vendido por producto (rentabilidad, listas, rotación).
  `INSERT INTO metricas_venta_prod_dia
     (dia, sucursal_id, producto_id, presentacion_id, lista_id, unidades, cantidad_base, venta_neta,
      venta_costeada, costo, iva_absorbido, renglones, con_costo)
   SELECT ${DIA('v.fecha')}, coalesce(v.sucursal_id, 0), vi.producto_id, coalesce(vi.presentacion_id, 0),
     coalesce(vi.lista_id, 0),
     sum(vi.cantidad * ${SIGNO}),
     sum(vi.cantidad * coalesce(p.tam_kg, 1) * ${SIGNO}),
     sum(vi.subtotal * ${SIGNO}),
     coalesce(sum(vi.subtotal * ${SIGNO}) FILTER (WHERE vi.costo_unitario IS NOT NULL), 0),
     coalesce(sum(vi.cantidad * vi.costo_unitario * ${SIGNO}), 0),
     coalesce(sum(vi.cantidad * vi.iva_absorbido_unitario * ${SIGNO}), 0),
     count(*) FILTER (WHERE NOT ${NOTA}),
     count(vi.costo_unitario) FILTER (WHERE NOT ${NOTA})
   FROM ventas v
     JOIN venta_items vi ON vi.venta_id = v.id
     LEFT JOIN presentaciones p ON p.id = vi.presentacion_id
   WHERE ${VALIDA} AND ${RANGO('v.fecha')}
   GROUP BY 1, 2, 3, 4, 5`,

  // Por día, sucursal y quien cobró.
  `INSERT INTO metricas_venta_dia (dia, sucursal_id, usuario_id, tickets, notas, venta_neta, descuento, iva, total)
   SELECT ${DIA('v.fecha')}, coalesce(v.sucursal_id, 0), coalesce(v.usuario_id, 0),
     count(*) FILTER (WHERE NOT ${NOTA}), count(*) FILTER (WHERE ${NOTA}),
     sum(v.subtotal_neto * ${SIGNO}), sum(v.descuento_total * ${SIGNO}), sum(v.iva_total * ${SIGNO}), sum(v.total * ${SIGNO})
   FROM ventas v
   WHERE ${VALIDA} AND ${RANGO('v.fecha')}
   GROUP BY 1, 2, 3`,

  // A qué hora (solo ventas).
  `INSERT INTO metricas_venta_hora (dia, hora, sucursal_id, tickets, venta_neta)
   SELECT ${DIA('v.fecha')}, extract(hour FROM v.fecha AT TIME ZONE '${ZONA}')::smallint, coalesce(v.sucursal_id, 0),
     count(*), sum(v.subtotal_neto)
   FROM ventas v
   WHERE ${VALIDA} AND NOT ${NOTA} AND ${RANGO('v.fecha')}
   GROUP BY 1, 2, 3`,

  // Quién compra.
  `INSERT INTO metricas_venta_cliente_dia (dia, cliente_id, sucursal_id, tickets, venta_neta)
   SELECT ${DIA('v.fecha')}, v.cliente_id, coalesce(v.sucursal_id, 0),
     count(*) FILTER (WHERE NOT ${NOTA}), sum(v.subtotal_neto * ${SIGNO})
   FROM ventas v
   WHERE ${VALIDA} AND ${RANGO('v.fecha')}
   GROUP BY 1, 2, 3`,

  // Cómo se cobra.
  `INSERT INTO metricas_venta_pago_dia (dia, sucursal_id, medio, importe, cantidad)
   SELECT ${DIA('v.fecha')}, coalesce(v.sucursal_id, 0), vp.medio::text,
     sum(vp.importe * ${SIGNO}), count(*) FILTER (WHERE NOT ${NOTA})
   FROM ventas v
     JOIN venta_pagos vp ON vp.venta_id = v.id
   WHERE ${VALIDA} AND ${RANGO('v.fecha')}
   GROUP BY 1, 2, 3`,

  // Lo que se le compra a cada proveedor (la NC resta, la ND suma; el remito no es compra hasta facturarse).
  `INSERT INTO metricas_compra_prov_dia (dia, proveedor_id, neto, iva, total, comprobantes)
   SELECT ${DIA('c.fecha')}, c.proveedor_id,
     sum(c.subtotal_neto * s.signo), sum(c.iva_total * s.signo), sum(c.total * s.signo),
     count(*) FILTER (WHERE c.tipo IN ('factura', 'liquidacion'))
   FROM comprobantes c
     CROSS JOIN LATERAL (SELECT (CASE WHEN c.tipo = 'nota_credito' THEN -1 ELSE 1 END) AS signo) s
   WHERE c.estado = 'confirmado' AND c.tipo IN ('factura', 'liquidacion', 'nota_debito', 'nota_credito')
     AND ${RANGO('c.fecha')}
   GROUP BY 1, 2`,
];

/**
 * Rearma un rango en UNA transacción: nadie ve el rango a medio armar. Corre
 * sobre la conexión que le pasan (la misma que tiene el candado), así la
 * sincronización nunca ocupa más de una. Devuelve cuántas filas escribió.
 */
export async function rearmarRango(c: PoolClient, desde: string, hasta: string, topeMs: number): Promise<number> {
  try {
    await c.query('BEGIN');
    // El tope es de ESTA transacción: si una consulta se pasa, se corta sola y no trabaja de más.
    await c.query(`SET LOCAL statement_timeout = ${Math.round(topeMs)}`);
    for (const t of TABLAS_DIA) await c.query(`DELETE FROM ${t} WHERE dia BETWEEN $1::date AND $2::date`, [desde, hasta]);
    let filas = 0;
    for (const q of REARMAR) filas += (await c.query(q, [desde, hasta])).rowCount ?? 0;
    await c.query('COMMIT');
    return filas;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

/** El primer día con ventas o compras (hora argentina), o null si no hay nada. */
export async function primerDia(c: Consultable): Promise<string | null> {
  const r = await c.query(`
    SELECT least(
      (SELECT min(${DIA('fecha')}) FROM ventas WHERE ${VALIDA.replace(/v\./g, '')}),
      (SELECT min(${DIA('fecha')}) FROM comprobantes WHERE estado = 'confirmado')
    )::text AS d`);
  return r.rows[0]?.d ?? null;
}

/** Cuántos días hay que rearmar según el modo: [desde, hasta] inclusive, en 'AAAA-MM-DD'. */
export async function rangoDe(c: Consultable, modo: ModoSync, hoy: string): Promise<{ desde: string; hasta: string } | null> {
  if (modo === 'reciente') return { desde: sumarDias(hoy, -1), hasta: hoy };
  if (modo === 'noche') return { desde: sumarDias(hoy, -40), hasta: hoy };
  const p = await primerDia(c);
  return p ? { desde: p, hasta: hoy } : null;
}

/** Parte un rango en meses calendario, para que «todo» no sea una sola transacción gigante. */
export function porMeses(desde: string, hasta: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let ini = desde;
  while (ini <= hasta) {
    const [a, m] = ini.split('-').map(Number);
    const finMes = new Date(a, m, 0).getDate();
    const fin = `${a}-${String(m).padStart(2, '0')}-${String(finMes).padStart(2, '0')}`;
    out.push([ini, fin < hasta ? fin : hasta]);
    ini = sumarDias(fin, 1);
  }
  return out;
}

export const CUENTAS = `SELECT
  (SELECT count(*)::int FROM metricas_venta_prod_dia) AS prod_dia,
  (SELECT count(*)::int FROM metricas_venta_dia) AS venta_dia,
  (SELECT count(*)::int FROM metricas_venta_hora) AS venta_hora,
  (SELECT count(*)::int FROM metricas_venta_cliente_dia) AS cliente_dia,
  (SELECT count(*)::int FROM metricas_venta_pago_dia) AS pago_dia,
  (SELECT count(*)::int FROM metricas_compra_prov_dia) AS compra_prov_dia`;
