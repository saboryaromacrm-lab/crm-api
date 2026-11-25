/* La otra mitad de una compra mitad y mitad (21/11/2026). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netoPorProducto, sinSuOtraMitad, tipoDeLaOtraMitad } from './otra-mitad';

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

test('mitades sin cargar: el papel que no tiene la otra mitad del mismo proveedor a ±7 días', () => {
  const p = (id: number, proveedorId: number, tipo: string, letra: string | null, dia: string) => ({ id, proveedorId, tipo, letra, dia });
  const papeles = [
    p(1, 10, 'factura', 'A', '2026-11-10'), p(2, 10, 'liquidacion', 'X', '2026-11-17'), // a 7 días: se emparejan
    p(3, 10, 'factura', 'A', '2026-11-20'), // la liquidación del 17 está a 3 días: tiene
    p(4, 10, 'factura', 'A', '2026-11-01'), // la 2 está a 16 días: sola
    p(5, 11, 'liquidacion', 'X', '2026-11-12'), // otro proveedor: la factura del 10 no le sirve
    p(6, 12, 'factura', 'B', '2026-11-12'), // B no tiene otra mitad
    p(7, 13, 'liquidacion', 'X', '2026-10-20'), p(8, 13, 'factura', 'A', '2026-10-26'), // la 7 es anterior a «desde», pero empareja a la 8
    p(9, 14, 'factura', 'A', '2026-10-24'), // anterior a «desde»: no se lista
  ];
  assert.deepEqual(sinSuOtraMitad(papeles, '2026-10-25').map((x) => x.id), [4, 5]);
  assert.deepEqual(sinSuOtraMitad([p(1, 10, 'factura', 'A', '2026-11-10'), p(2, 10, 'factura', 'A', '2026-11-11')], '2026-11-01').map((x) => x.id), [1, 2]);
});
