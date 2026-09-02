import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armarEan13, digitoVerificador, esEan13, PREFIJOS_INTERNOS, secuenciaDe } from './ean13';

test('digitoVerificador: la fórmula GS1 (impares ×1, pares ×3)', () => {
  // 7790895000010 es el EAN-13 real de un producto argentino (Coca-Cola 1,5 L).
  assert.equal(digitoVerificador('779089500001'), 0);
  // 4006381333931 — el ejemplo clásico de la Wikipedia.
  assert.equal(digitoVerificador('400638133393'), 1);
  // Cuando la suma da múltiplo de 10, el verificador es 0 (no 10).
  assert.equal(digitoVerificador('000000000000'), 0);
});

test('esEan13: 13 dígitos y el verificador cerrando', () => {
  assert.equal(esEan13('7790895000010'), true);
  assert.equal(esEan13('4006381333931'), true);
  assert.equal(esEan13('7790895000011'), false, 'un dígito cambiado no es válido');
  assert.equal(esEan13('779089500001'), false, '12 dígitos no alcanzan');
  assert.equal(esEan13('77908950000100'), false, '14 dígitos son otro formato');
  assert.equal(esEan13(' 7790895000010 '), true, 'tolera espacios alrededor');
  assert.equal(esEan13('779089500001a'), false);
  assert.equal(esEan13(''), false);
});

test('armarEan13 / secuenciaDe: la serie interna va y vuelve', () => {
  const codigo = armarEan13('29', 42);
  assert.equal(codigo.length, 13);
  assert.ok(codigo.startsWith('29'));
  assert.equal(esEan13(codigo), true, 'lo que se arma es un EAN-13 válido');
  assert.equal(secuenciaDe(codigo, '29'), 42);
  assert.equal(secuenciaDe(codigo, '28'), null, 'otro prefijo no es de esa serie');
  assert.equal(secuenciaDe('7790895000010', '29'), null, 'un código comercial no es de la serie');
});

test('PREFIJOS_INTERNOS: circulación restringida GS1, del 29 hacia abajo', () => {
  assert.equal(PREFIJOS_INTERNOS[0], '29');
  assert.ok(PREFIJOS_INTERNOS.every((p) => /^2\d$/.test(p)));
});
