/*
 * Sin stock desde cuándo: el movimiento que dejó sin stock cada artículo,
 * hacia atrás desde el stock de hoy, y cuándo el número no es confiable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quiebres, type MovConDeltas } from './sin-stock-desde';

const K = '2|0|disponible';
const mov = (id: number, delta: number, suc = 2, pres = 0, tipo = delta > 0 ? 'compra' : 'venta_fraccionada'): MovConDeltas => ({
  id, fecha: `2026-10-${String(id).padStart(2, '0')}T12:00:00Z`, tipo,
  deltas: [{ sucursalId: suc, presentacionId: pres, estado: 'disponible', delta }],
});
const ajuste = (id: number, delta: number) => mov(id, delta, 2, 0, 'ajuste');
/** [id del movimiento, hay que contarlo] — null si nunca tuvo. */
const de = (movs: MovConDeltas[], hoy = 0, k = K) => {
  const q = quiebres(movs, new Map([[k, hoy]]), [k]).get(k);
  return q ? [q.mov.id, q.contar] : null;
};

test('la venta que vació el estante: fecha firme', () => {
  // entra 5, se venden 2 y 3: el día 3 quedó en 0
  assert.deepEqual(de([mov(1, 5), mov(2, -2), mov(3, -3)]), [3, false]);
});

test('se quedó sin stock dos veces: cuenta la última', () => {
  assert.deepEqual(de([mov(1, 2), mov(2, -2), mov(5, 4), mov(9, -4)]), [9, false]);
});

test('nunca tuvo: ni un movimiento', () => {
  assert.equal(de([]), null);
});

test('stock de entrada sin movimiento (carga inicial) que después se vendió', () => {
  // hoy 0, una sola venta de 4: antes de ella había 4 (carga inicial)
  assert.deepEqual(de([mov(7, -4)]), [7, false]);
});

test('después de quedar en 0 se siguió vendiendo: la fecha del quiebre, pero hay que contarlo', () => {
  // 3 → 0 (día 4) → −1 (día 6) → 0 (llega 1 el día 8)
  assert.deepEqual(de([mov(1, 3), mov(4, -3), mov(6, -1), mov(8, 1)]), [4, true]);
  // el caso real: quedó en 0, vendió 11 más, llegaron 10 y hoy está en −3
  const movs = [mov(1, 5), mov(8, -5), ...Array.from({ length: 11 }, (_, i) => mov(10 + i, -1)), mov(21, 10), mov(22, -1), mov(23, -1)];
  assert.deepEqual(de(movs, -3), [8, true]);
  // la venta que lo vació ya lo dejó en negativo (vendió 2 teniendo 1)
  assert.deepEqual(de([mov(1, 1), mov(2, -2)], -1), [2, true]);
});

test('en el sistema nunca pasó de 0: el último movimiento, y hay que contarlo', () => {
  // el jarabe en Express 3: −1, −1 y llegan 2 → 0
  assert.deepEqual(de([mov(20, -1), mov(22, -1), mov(24, 2)]), [24, true]);
  // sigue en negativo
  assert.deepEqual(de([mov(3, -1), mov(5, -1)], -2), [5, true]);
});

test('un control de stock que lo dejó en 0 es fecha firme, aunque antes se vendiera sin stock', () => {
  // el jarabe natural en Express 1: −1, −1, −1 sin stock y el control del día 24 lo ajusta a 0
  assert.deepEqual(de([mov(1, -1), mov(14, -1), mov(22, -1), ajuste(24, 3)]), [24, false]);
  // un control que encontró menos de lo que decía el sistema: lo vació el ajuste
  assert.deepEqual(de([mov(1, 5), ajuste(9, -5)]), [9, false]);
  // después del control se vendió sin stock: desde el control, pero hay que contarlo
  assert.deepEqual(de([mov(1, -2), ajuste(5, 2), mov(7, -1)], -1), [5, true]);
});

test('cada sucursal y cada paquete por su lado', () => {
  const k3 = '3|0|disponible', kp = '2|9|disponible';
  const movs = [mov(1, 5, 2), mov(2, 5, 3), mov(3, -5, 3), mov(4, 2, 2, 9), mov(6, -2, 2, 9)];
  const r = quiebres(movs, new Map([[K, 5], [k3, 0], [kp, 0]]), [k3, kp]);
  assert.equal(r.get(k3)?.mov.id, 3);
  assert.equal(r.get(kp)?.mov.id, 6);
  assert.equal(r.has(K), false);
});

test('decimales del granel: 0,0001 kg de redondeo no es stock', () => {
  assert.deepEqual(de([mov(1, 1.2), mov(2, -0.7), mov(3, -0.5)]), [3, false]);
});
