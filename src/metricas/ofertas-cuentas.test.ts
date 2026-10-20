/*
 * Métricas › Ofertas (0189): las cuentas con números hechos a mano.
 * Oferta de ejemplo: 10 unidades a $1.200 neto cada una ($12.000), costo $1.000 c/u ($10.000),
 * la oferta descontó $3.000 (precio normal $1.500).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { porDia, resultado, vecesMas, vendidoDelStock, veredicto, type Vendido } from './ofertas-cuentas';

const v = (x: Partial<Vendido> = {}): Vendido => ({
  neto: 12000, costeado: 12000, costo: 10000, descuento: 3000, descuentoCosteado: 3000, renglones: 4, sinCosto: 0, ...x,
});

test('ganancia, margen y lo que habría dejado a precio normal', () => {
  const r = resultado(v());
  assert.equal(r.ganancia, 2000);          // 12.000 − 10.000
  assert.equal(r.margen, 16.67);           // 2.000 / 12.000
  assert.equal(r.sobreCosto, 20);          // 2.000 / 10.000
  assert.equal(r.gananciaNormal, 5000);    // a $1.500: 15.000 − 10.000
});

test('la ganancia es solo de lo que tiene costo; el descuento a precio normal también', () => {
  /* Además se vendieron $2.400 sin costo cargado, con $600 de descuento: no entran a la ganancia. */
  const r = resultado(v({ neto: 14400, descuento: 3600, sinCosto: 1 }));
  assert.equal(r.ganancia, 2000);
  assert.equal(r.gananciaNormal, 5000);
});

test('veredicto: rentable, al costo (con tolerancia), pierde, sin costo, sin ventas', () => {
  assert.equal(veredicto(v()), 'rentable');
  assert.equal(veredicto(v({ costeado: 10050 })), 'al_costo');     // $50 sobre $10.000: dentro del 1 %
  assert.equal(veredicto(v({ costeado: 9950 })), 'al_costo');      // −$50: redondeo, no pérdida
  assert.equal(veredicto(v({ costeado: 9000 })), 'pierde');
  assert.equal(veredicto(v({ costeado: 0, costo: 0 })), 'sin_costo');
  assert.equal(veredicto(v({ neto: 0, costeado: 0, costo: 0, renglones: 0 })), 'sin_ventas');
  /* Una venta y su nota de crédito se anulan: hubo movimiento, pero no quedó nada vendido con costo. */
  assert.equal(veredicto(v({ neto: 0, costeado: 0, costo: 0, renglones: 2 })), 'sin_costo');
});

test('por día y veces más rápido', () => {
  assert.deepEqual(porDia({ cant: { u: 30, kg: 1.5 }, neto: 9000, ganancia: 1500 }, 10), { u: 3, kg: 0.15, neto: 900, ganancia: 150 });
  assert.deepEqual(porDia({ cant: { u: 3, kg: 0 }, neto: 0, ganancia: 0 }, 0), { u: 3, kg: 0, neto: 0, ganancia: 0 }); // nunca divide por 0
  assert.equal(vecesMas(2, 5), 2.5);
  assert.equal(vecesMas(0, 5), null);   // antes no se vendía: no hay «veces»
});

test('el % del stock inicial vendido, solo si se cuenta en una unidad', () => {
  assert.equal(vendidoDelStock({ u: 40, kg: 0 }, { u: 28, kg: 0 }), 70);
  assert.equal(vendidoDelStock({ u: 0, kg: 12.5 }, { u: 0, kg: 5 }), 40);
  assert.equal(vendidoDelStock({ u: 10, kg: 3 }, { u: 5, kg: 1 }), null); // unidades y kg mezclados: no se suman
  assert.equal(vendidoDelStock({ u: 0, kg: 0 }, { u: 3, kg: 0 }), null);
});
