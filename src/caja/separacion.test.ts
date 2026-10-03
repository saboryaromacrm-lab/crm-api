/*
 * 0130 — qué billetes quedan en la caja y cuáles van al sobre.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proponerSeparacion } from './caja.module';

const suma = (b: Record<string, number>) => Object.entries(b).reduce((a, [d, n]) => a + Number(d) * n, 0);

test('queda EXACTO el fondo, con los billetes más chicos, y el resto va al sobre', () => {
  const contados = { 20000: 5, 10000: 3, 2000: 4, 1000: 6, 500: 4, 100: 10 }; // $147.000
  const r = proponerSeparacion(contados, 20000);
  assert.equal(suma(r.queda), 20000);
  assert.equal(suma(r.envio), 147000 - 20000);
  // Los chicos suman $17.000: hace falta UN $10.000 y ningún $20.000.
  assert.equal(r.queda[20000] ?? 0, 0, 'ningún $20.000 queda en la caja');
  assert.equal(r.queda[10000] ?? 0, 1, 'un solo $10.000');
  assert.equal(r.queda[100], 10, 'todos los de $100 (cambio) quedan');
  for (const [d, n] of Object.entries(contados)) assert.equal((r.queda[d] ?? 0) + (r.envio[d] ?? 0), n, `billetes de ${d}: queda + sobre = contados`);
});

test('si con los chicos no alcanza, usa el grande que haga falta', () => {
  const r = proponerSeparacion({ 20000: 2, 10000: 1, 1000: 3 }, 20000); // $53.000
  assert.equal(suma(r.queda), 20000);
  assert.deepEqual(r.queda, { 20000: 1 }, 'con $10.000 + 3 × $1.000 no se llega: queda un $20.000');
  assert.equal(suma(r.envio), 33000);
});

test('sin forma exacta: lo más cerca por arriba (nunca menos que el fondo)', () => {
  const r = proponerSeparacion({ 20000: 1, 10000: 1 }, 25000); // $30.000, fondo 25.000
  assert.equal(suma(r.queda), 30000, 'no se puede dejar 25.000: queda todo');
  assert.equal(suma(r.envio), 0);
  const r2 = proponerSeparacion({ 20000: 3, 2000: 2 }, 21000); // $64.000, fondo 21.000 → lo más cerca: 22.000
  assert.equal(suma(r2.queda), 22000);
  assert.equal(suma(r2.envio), 42000);
});

test('contó menos que el fondo: queda todo, sobre vacío', () => {
  const r = proponerSeparacion({ 1000: 5 }, 20000);
  assert.deepEqual(r, { queda: { 1000: 5 }, envio: {} });
  assert.deepEqual(proponerSeparacion({}, 20000), { queda: {}, envio: {} });
});

test('fondo cero: todo al sobre', () => {
  const r = proponerSeparacion({ 20000: 2, 500: 3 }, 0);
  assert.deepEqual(r.queda, {});
  assert.equal(suma(r.envio), 41500);
});

test('cajón grande: sigue siendo exacto y rápido', () => {
  const contados = { 20000: 80, 10000: 60, 2000: 150, 1000: 200, 500: 120, 200: 90, 100: 70, 50: 40, 20: 30 };
  const t0 = Date.now();
  const r = proponerSeparacion(contados, 50000);
  assert.ok(Date.now() - t0 < 500, 'menos de medio segundo');
  assert.equal(suma(r.queda), 50000);
  assert.equal(suma(r.queda) + suma(r.envio), suma(contados));
});
