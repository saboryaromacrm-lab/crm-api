/*
 * Quiebres de stock: la cuenta de UN artículo en UN local a lo largo del
 * período (cuántas veces, cuántos días, si venía o sigue sin stock, el ritmo de
 * venta con stock y los tramos dudosos).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_TRAMO_MS, seguirArticulo, type PasoStock } from './quiebres';

const DIA = 86_400_000;
/** Día 0 = base; el período va del día 30 al 40 (los 30 de antes son la ventana del ritmo). */
const t = { base: 0, inicio: 30 * DIA, fin: 40 * DIA, conHistoria: true };
const venta = (dia: number, cant: number): PasoStock => ({ fecha: dia * DIA, tipo: 'venta_fraccionada', delta: -cant });
const entra = (dia: number, cant: number): PasoStock => ({ fecha: dia * DIA, tipo: 'transferencia', delta: cant });

test('se queda sin stock y vuelve a tener: una vez, los días del medio', () => {
  const s = seguirArticulo([venta(32, 10), entra(34.5, 10)], 10, t);
  assert.equal(s.veces, 1);
  assert.equal(s.sinStockMs, 2.5 * DIA);
  assert.equal(s.venia, false);
  assert.equal(s.sinStockDesde, null);
  assert.equal(s.dudosoMs, 0);
});

test('dos quiebres en el período cuentan dos veces', () => {
  const s = seguirArticulo([venta(31, 5), entra(32, 5), venta(35, 5), entra(36, 5)], 5, t);
  assert.equal(s.veces, 2);
  assert.equal(s.sinStockMs, 2 * DIA);
});

test('un tramo de menos de una hora no es un quiebre (el paso entre dos movimientos)', () => {
  const s = seguirArticulo([venta(32, 5), { fecha: 32 * DIA + MIN_TRAMO_MS - 1, tipo: 'fraccionamiento', delta: 5 }], 5, t);
  assert.equal(s.veces, 0);
  assert.equal(s.sinStockMs, 0);
});

test('venía sin stock de antes del período: no es un quiebre nuevo, los días cuentan desde que empieza el período', () => {
  const s = seguirArticulo([venta(20, 4), entra(33, 4)], 4, t);
  assert.equal(s.veces, 0);
  assert.equal(s.venia, true);
  assert.equal(s.sinStockMs, 3 * DIA);
  /* El ritmo descuenta todo el tramo vacío, también la parte anterior al período. */
  assert.equal(s.conStockMs, 40 * DIA - 13 * DIA);
});

test('sigue sin stock al final: cuenta hasta el final y dice desde cuándo', () => {
  const s = seguirArticulo([venta(38, 3)], 3, t);
  assert.equal(s.sinStockMs, 2 * DIA);
  assert.equal(s.sinStockDesde, 38 * DIA);
  assert.equal(s.veces, 1);
});

test('en 0 pero vendiendo: el número no era real — días dudosos, no quiebre', () => {
  const s = seguirArticulo([venta(32, 2), venta(33, 1), entra(35, 5)], 2, t);
  assert.equal(s.veces, 0);
  assert.equal(s.sinStockMs, 0);
  assert.equal(s.dudosoMs, 3 * DIA);
  /* Había mercadería: ese tiempo cuenta como con stock para el ritmo. */
  assert.equal(s.conStockMs, 40 * DIA);
});

test('el ritmo: lo vendido en la ventana sobre el tiempo con stock', () => {
  const s = seguirArticulo([venta(10, 6), venta(25, 4), entra(30, 10), venta(39, 10)], 10, t);
  assert.equal(s.vendido, 20);
  /* Vacío del 25 al 30 (5 días) y del 39 al 40 (1 día). */
  assert.equal(s.conStockMs, 34 * DIA);
  assert.equal(s.sinStockMs, 1 * DIA);
});

test('nunca tuvo ni vendió en la ventana: el local no lo trabaja', () => {
  const s = seguirArticulo([], 0, t);
  assert.equal(s.trabaja, false);
});

test('una devolución que lo saca de 0 cierra el tramo', () => {
  const s = seguirArticulo([venta(31, 1), { fecha: 31.5 * DIA, tipo: 'devolucion', delta: 1 }], 1, t);
  assert.equal(s.sinStockMs, 0.5 * DIA);
  assert.equal(s.veces, 1);
});

test('en el arranque del sistema, el 0 antes de la carga inicial no es un quiebre ni mide el ritmo', () => {
  const arranque = { ...t, base: t.inicio, conHistoria: false };
  const s = seguirArticulo([{ fecha: 31 * DIA, tipo: 'ajuste', delta: 10 }, venta(35, 2)], 0, arranque);
  assert.equal(s.sinStockMs, 0);
  assert.equal(s.venia, false);
  assert.equal(s.conStockMs, 9 * DIA);
  /* Con historia, el mismo 0 sí es un quiebre que venía de antes. */
  const c = seguirArticulo([{ fecha: 31 * DIA, tipo: 'ajuste', delta: 10 }, venta(35, 2)], 0, { ...arranque, conHistoria: true });
  assert.equal(c.sinStockMs, 1 * DIA);
  assert.equal(c.venia, true);
});

test('en el arranque, si se vendió estando en 0 había mercadería: ese tiempo mide el ritmo como con stock', () => {
  const arranque = { ...t, base: t.inicio, conHistoria: false };
  const s = seguirArticulo([venta(31, 3), venta(33, 3), { fecha: 35 * DIA, tipo: 'ajuste', delta: 20 }, venta(38, 4)], 0, arranque);
  assert.equal(s.sinStockMs, 0);
  assert.equal(s.dudosoMs, 0);
  assert.equal(s.vendido, 10);
  assert.equal(s.conStockMs, 10 * DIA);
});
