import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totalConOferta } from './oferta-linea';

test('3×2: de cada 3 se pagan 2; lo que sobra va entero', () => {
  const o = { tipo: 'nxm', lleva: 3, paga: 2 };
  assert.equal(totalConOferta(o, 100, 2), 200);
  assert.equal(totalConOferta(o, 100, 3), 200);
  assert.equal(totalConOferta(o, 100, 4), 300);
  assert.equal(totalConOferta(o, 100, 9), 600);
});

test('2ª unidad al 50%: cada par, la segunda con descuento', () => {
  const o = { tipo: 'segunda_unidad', porcentaje: 50 };
  assert.equal(totalConOferta(o, 100, 1), 100);
  assert.equal(totalConOferta(o, 100, 2), 150);
  assert.equal(totalConOferta(o, 100, 5), 400);
});

test('pack: cada grupo al precio del pack, y nunca más caro que suelto', () => {
  assert.equal(totalConOferta({ tipo: 'pack', lleva: 3, precioPack: 250 }, 100, 7), 600);
  assert.equal(totalConOferta({ tipo: 'pack', lleva: 3, precioPack: 400 }, 100, 3), 300);
});

test('promo mal cargada o sin promo: precio lleno', () => {
  assert.equal(totalConOferta({ tipo: 'nxm', lleva: 2, paga: 2 }, 100, 4), 400);
  assert.equal(totalConOferta({ tipo: 'porcentaje' }, 33.335, 3), 100.01);
});
