/*
 * Sistema anterior (0213): cada mes de un solo sistema, las mismas cuentas para
 * los dos, y la renta del ERP solo con costo para casi todo lo vendido.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { reporteAnterior } from './anterior';

/** Un cliente de mentira: contesta según la tabla que lee la consulta. */
const cliente = (viejo: any[], erp: any[]) => ({
  query: async (sql: string) => ({
    rows: sql.includes('JOIN sucursales s') ? [] : sql.includes('FROM metricas_sistema_anterior') ? viejo : erp,
  }),
}) as unknown as PoolClient;

// Los tres meses del archivo de Express 1 (julio a septiembre de 2026).
const VIEJO = [
  { mes: '2026-07', dias_venta: 26, comprobantes: 1216, monto: 10098122.19, costo: 5569836.39 },
  { mes: '2026-08', dias_venta: 25, comprobantes: 1387, monto: 12191150.46, costo: 6872449.33 },
  { mes: '2026-09', dias_venta: 25, comprobantes: 1467, monto: 13024879.61, costo: 7267577.94 },
];
const erp = (mes: string, x: Partial<{ dias: number; tickets: number; total: number; venta_neta: number; venta_costeada: number; costo: number }>) =>
  ({ mes, dias: 0, tickets: 0, total: 0, venta_neta: 0, venta_costeada: 0, costo: 0, ...x });

test('las cuentas del archivo dan lo mismo que dice el sistema viejo', async () => {
  const r = await reporteAnterior(cliente(VIEJO, []), 1);
  const jul = r.meses[0];
  assert.equal(jul.rentaPct, 44.84);
  assert.equal(jul.markupPct, 81.3);
  assert.equal(jul.ticketPromedio, 8304.38);
  assert.equal(r.meses[1].vsMesAnterior?.venta, 20.73);
});

test('octubre del ERP contra septiembre del anterior; septiembre del ERP no se suma', async () => {
  const r = await reporteAnterior(cliente(VIEJO, [
    erp('2026-09', { dias: 1, tickets: 3, total: 9000 }),
    erp('2026-10', { dias: 26, tickets: 1500, total: 13500000, venta_neta: 11500000, venta_costeada: 11000000, costo: 6200000 }),
  ]), 1);
  assert.deepEqual(r.meses.map((m) => [m.mes, m.origen]), [['2026-07', 'anterior'], ['2026-08', 'anterior'], ['2026-09', 'anterior'], ['2026-10', 'erp']]);
  assert.deepEqual(r.meses[2].tambienErp, { venta: 9000, tickets: 3 });
  assert.equal(r.meses[2].venta, 13024879.61);
  assert.deepEqual(r.comparacion && [r.comparacion.erp, r.comparacion.anterior], ['2026-10', '2026-09']);
  assert.equal(r.meses[3].rentaPct, 43.64); // (11,0 M − 6,2 M) / 11,0 M, sobre lo que tiene costo
  assert.equal(r.comparacion?.variacion.rentaPts, -0.56); // 43,64 % contra 44,20 %
});

test('con poco costo cargado, la renta del ERP no se compara', async () => {
  const r = await reporteAnterior(cliente(VIEJO, [
    erp('2026-10', { dias: 26, tickets: 1500, total: 13500000, venta_neta: 11500000, venta_costeada: 10000000, costo: 5000000 }),
  ]), 1);
  const oct = r.meses[3];
  assert.equal(oct.cobertura, 86.96);
  assert.equal(oct.rentaPct, null);
  assert.equal(oct.markupPct, null);
  assert.equal(r.comparacion?.variacion.rentaPts, null);
  assert.equal(r.comparacion?.variacion.venta, 3.65);
});

test('un mes salteado no se compara con el anterior que hay', async () => {
  const r = await reporteAnterior(cliente([VIEJO[0], VIEJO[2]], []), 1);
  assert.equal(r.meses[1].mes, '2026-09');
  assert.equal(r.meses[1].vsMesAnterior, null);
});
