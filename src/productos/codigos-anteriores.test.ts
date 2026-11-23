/* Los códigos anteriores de un producto (0241). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CODIGOS_ANTERIORES, codigosAnteriores } from './codigos-anteriores';

test('cambiar el código de barras guarda el anterior solo', () => {
  assert.deepEqual(codigosAnteriores({ previos: [], barrasAntes: '7790001', propios: ['7790002', 'A1', ''] }), ['7790001']);
});

test('sin cambio de código no se agrega nada', () => {
  assert.deepEqual(codigosAnteriores({ previos: ['7790000'], barrasAntes: '7790001', propios: ['7790001'] }), ['7790000']);
});

test('volver al código viejo lo saca de la lista y guarda el que tenía', () => {
  assert.deepEqual(codigosAnteriores({ previos: ['7790001'], barrasAntes: '7790002', propios: ['7790001'] }), ['7790002']);
});

test('la lista de la ficha manda: sacar uno lo saca, agregar uno lo agrega', () => {
  assert.deepEqual(codigosAnteriores({ pedidos: ['  7790005 ', ''], previos: ['7790001', '7790003'], barrasAntes: '7790009', propios: ['7790009'] }), ['7790005']);
  assert.deepEqual(codigosAnteriores({ pedidos: [], previos: ['7790001'], propios: ['7790009'] }), []);
});

test('sin repetidos ni códigos propios (interno, DUN)', () => {
  assert.deepEqual(codigosAnteriores({ pedidos: ['1', '1', 'INT-7', 'DUN-1', '2'], propios: ['9', 'INT-7', 'DUN-1'] }), ['1', '2']);
});

test('con más del tope quedan los más nuevos', () => {
  const muchos = Array.from({ length: MAX_CODIGOS_ANTERIORES }, (_, i) => String(1000 + i));
  const r = codigosAnteriores({ previos: muchos, barrasAntes: '9999', propios: ['8888'] });
  assert.equal(r.length, MAX_CODIGOS_ANTERIORES);
  assert.equal(r[r.length - 1], '9999');
  assert.equal(r[0], '1001');
});
