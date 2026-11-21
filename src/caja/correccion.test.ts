/*
 * 21/11/2026 — lo que queda en la caja de más al cerrar, y la corrección de un
 * cierre que dijo mal cuánto quedó (el caso real del 20/11 en Distribuidora).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correccionDeQueda, excedenteDelFondo } from './caja.module';

test('dejar exactamente el fondo no es «de más»', () => {
  const contados = { 20000: 50, 10000: 10, 1000: 20 }; // $1.120.000
  const r = excedenteDelFondo(contados, 120000, 120000);
  assert.equal(r.minimo, 120000);
  assert.equal(r.deMas, 0);
});

test('el caso del 20/11: quedan $240.000 con fondo de $120.000 → $120.000 de más', () => {
  const contados = { 20000: 60, 10000: 1 }; // $1.210.000
  const r = excedenteDelFondo(contados, 240000, 120000);
  assert.equal(r.minimo, 120000);
  assert.equal(r.deMas, 120000);
});

test('si los billetes no dan el fondo exacto, lo mínimo posible no cuenta como de más', () => {
  // Solo billetes de $20.000: para $50.000 de fondo lo mínimo es $60.000.
  const contados = { 20000: 10 };
  const r = excedenteDelFondo(contados, 60000, 50000);
  assert.equal(r.minimo, 60000);
  assert.equal(r.deMas, 0);
  assert.equal(excedenteDelFondo(contados, 80000, 50000).deMas, 20000, 'un billete más que lo mínimo sí es de más');
});

test('contó menos que el fondo: queda todo y no hay nada de más', () => {
  const contados = { 10000: 5 };
  assert.deepEqual(excedenteDelFondo(contados, 50000, 120000), { minimo: 50000, deMas: 0 });
});

test('corregir el cierre: el envío queda, cambian lo contado y la diferencia', () => {
  const t = { envio: 970000, esperado: 1097963.5, contado: 1210000, queda: 240000, diferencia: 112036.5 };
  const c = correccionDeQueda(t, 120000, null);
  assert.deepEqual(c.antes, { queda: 240000, contado: 1210000, diferencia: 112036.5 });
  assert.deepEqual(c.despues, { queda: 120000, contado: 1090000, diferencia: -7963.5 });
  assert.equal(c.apertura, null);
});

test('corregir el cierre vuelve a medir la apertura del turno siguiente', () => {
  const t = { envio: 970000, esperado: 1097963.5, contado: 1210000, queda: 240000, diferencia: 112036.5 };
  // A la mañana se contaron $120.000 contra los $240.000 que decía el cierre: el faltante de $120.000 no era real.
  assert.deepEqual(correccionDeQueda(t, 120000, { contado: 120000 }).apertura, { esperado: 120000, diferencia: 0 });
  // Si a la mañana había $110.000, sigue faltando $10.000 (ese sí es real).
  assert.deepEqual(correccionDeQueda(t, 120000, { contado: 110000 }).apertura, { esperado: 120000, diferencia: -10000 });
});

test('los centavos no dejan restos', () => {
  const t = { envio: 100000.1, esperado: 150000.2, contado: 150000.1, queda: 50000, diferencia: -0.1 };
  assert.deepEqual(correccionDeQueda(t, 50000.1, null).despues, { queda: 50000.1, contado: 150000.2, diferencia: 0 });
});
