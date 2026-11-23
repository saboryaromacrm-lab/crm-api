/* La otra mitad de una compra mitad y mitad (21/11/2026). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netoPorProducto, tipoDeLaOtraMitad } from './otra-mitad';

test('la otra mitad: factura A ↔ liquidación; B, C y los demás tipos no tienen', () => {
  assert.equal(tipoDeLaOtraMitad('liquidacion', 'X'), 'factura');
  assert.equal(tipoDeLaOtraMitad('factura', 'A'), 'liquidacion');
  assert.equal(tipoDeLaOtraMitad('factura', 'B'), null);
  assert.equal(tipoDeLaOtraMitad('factura', 'C'), null);
  assert.equal(tipoDeLaOtraMitad('remito', 'A'), null);
  assert.equal(tipoDeLaOtraMitad('nota_credito', 'A'), null);
});

test('neto por unidad: del papel más cercano, juntando los renglones del mismo producto', () => {
  const r = netoPorProducto([20, 10], [
    { comprobanteId: 10, productoId: 1, cantidad: 12, subtotal: 12_000 },
    { comprobanteId: 20, productoId: 1, cantidad: 6, subtotal: 6_600 },
    { comprobanteId: 20, productoId: 1, cantidad: 6, subtotal: 6_000 },
    { comprobanteId: 10, productoId: 2, cantidad: 22.68, subtotal: 162_397.87 },
  ]);
  assert.deepEqual(r.get(1), { netoUnitario: 1050, comprobanteId: 20 });
  assert.deepEqual(r.get(2), { netoUnitario: 7160.3999, comprobanteId: 10 });
});

test('un renglón sin cantidad o en cero no da precio', () => {
  const r = netoPorProducto([1], [
    { comprobanteId: 1, productoId: 5, cantidad: 0, subtotal: 100 },
    { comprobanteId: 1, productoId: 6, cantidad: 3, subtotal: 0 },
  ]);
  assert.equal(r.size, 0);
});
