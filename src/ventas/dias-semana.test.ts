import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textoDias, valeElDia } from './ventas.module';

/* 2026-10-21 es miércoles; se arma al mediodía local para no depender de la zona. */
const miercoles = new Date(2026, 9, 21, 12);
const jueves = new Date(2026, 9, 22, 12);
const domingo = new Date(2026, 9, 25, 12);

test('los días de un descuento u oferta: lunes → domingo, vacío = todos', () => {
  assert.equal(valeElDia('0010000', miercoles), true);
  assert.equal(valeElDia('0010000', jueves), false);
  assert.equal(valeElDia('0000001', domingo), true, 'el domingo es el último');
  assert.equal(valeElDia('', jueves), true);
  assert.equal(valeElDia(null, jueves), true);
});

test('el texto de los días para el aviso', () => {
  assert.equal(textoDias('0010000'), 'los miércoles');
  assert.equal(textoDias('1010000'), 'los lunes y miércoles');
  assert.equal(textoDias('1010001'), 'los lunes, miércoles y domingos');
});
