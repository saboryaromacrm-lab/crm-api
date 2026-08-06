/**
 * RECONCILIAR LOS TOTALES PAGADOS
 * ============================================================================
 * `proveedor_pagos.aplicado`, `gastos.pagado` y `comprobantes.pagado` son
 * columnas DESNORMALIZADAS: existen para que las bandejas puedan filtrar y
 * ordenar sin recalcular en cada consulta. La verdad vive en
 * `proveedor_imputaciones`; estas columnas son un caché.
 *
 * El servicio las mantiene al día dentro de cada transacción, así que en
 * operación normal esto no hace falta. Se corre cuando la base se tocó por
 * fuera de la aplicación: una restauración de backup, un DELETE a mano, o una
 * migración que reemplazó el modelo de pagos (fue el caso de la 0033).
 *
 * Es idempotente y solo escribe donde encuentra diferencia: correrlo dos veces
 * seguidas no cambia nada la segunda vez.
 *
 *   npm run db:reconciliar
 */
import 'dotenv/config';
import { Pool } from 'pg';

/** Los tres cachés, cada uno recalculado desde las imputaciones que existen. */
const TOTALES = [
  {
    que: 'proveedor_pagos.aplicado',
    sql: `
      UPDATE proveedor_pagos p SET aplicado = calc.total
      FROM (
        SELECT pp.id, round(coalesce(sum(i.importe), 0)::numeric, 2)::double precision AS total
        FROM proveedor_pagos pp
        LEFT JOIN proveedor_imputaciones i ON i.pago_id = pp.id
        GROUP BY pp.id
      ) calc
      WHERE calc.id = p.id AND abs(p.aplicado - calc.total) > 0.009
      RETURNING p.id`,
  },
  {
    // Un pago anulado deja de contar: por eso el join filtra por estado.
    que: 'gastos.pagado',
    sql: `
      UPDATE gastos g SET pagado = calc.total
      FROM (
        SELECT gg.id, round(coalesce(sum(i.importe), 0)::numeric, 2)::double precision AS total
        FROM gastos gg
        LEFT JOIN proveedor_imputaciones i ON i.gasto_id = gg.id
        LEFT JOIN proveedor_pagos p ON p.id = i.pago_id AND p.estado = 'activo'
        GROUP BY gg.id
      ) calc
      WHERE calc.id = g.id AND abs(g.pagado - calc.total) > 0.009
      RETURNING g.id`,
  },
  {
    que: 'comprobantes.pagado',
    sql: `
      UPDATE comprobantes c SET pagado = calc.total
      FROM (
        SELECT cc.id, round(coalesce(sum(i.importe), 0)::numeric, 2)::double precision AS total
        FROM comprobantes cc
        LEFT JOIN proveedor_imputaciones i ON i.comprobante_id = cc.id
        LEFT JOIN proveedor_pagos p ON p.id = i.pago_id AND p.estado = 'activo'
        GROUP BY cc.id
      ) calc
      WHERE calc.id = c.id AND abs(c.pagado - calc.total) > 0.009
      RETURNING c.id`,
  },
];

/**
 * El estado del gasto se DERIVA del saldo, así que se recalcula después de los
 * totales. Los anulados quedan como están: su estado es una decisión de una
 * persona, no una consecuencia de la suma.
 */
const ESTADOS = `
  UPDATE gastos SET estado = (CASE
    WHEN pagado >= total - 0.009 THEN 'pagado' ELSE 'pendiente' END)::estado_gasto
  WHERE estado <> 'anulado'
    AND estado <> (CASE WHEN pagado >= total - 0.009 THEN 'pagado' ELSE 'pendiente' END)::estado_gasto
  RETURNING id, estado`;

async function main() {
  const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/crm';
  const pool = new Pool({ connectionString: url });
  try {
    for (const t of TOTALES) {
      const r = await pool.query(t.sql);
      // eslint-disable-next-line no-console
      console.log(`${t.que}: ${r.rowCount} fila(s) corregida(s).`);
    }
    const est = await pool.query(ESTADOS);
    // eslint-disable-next-line no-console
    console.log(`gastos.estado: ${est.rowCount} fila(s) corregida(s).`
      + (est.rowCount ? ` → ${est.rows.map((r) => `#${r.id} ${r.estado}`).join(', ')}` : ''));
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Error reconciliando:', e);
  process.exit(1);
});
