/*
 * ANOTACIONES — el «hasta cuándo» del aviso (0227).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diaAr, validarHasta } from './anotaciones.module';

test('el día de Argentina, no el de UTC', () => {
  assert.equal(diaAr(new Date('2026-11-17T02:30:00Z')), '2026-11-16', '23:30 del 16 acá es el 17 en UTC');
});

test('hasta: vacío = sin fecha; un día real y no antes del arranque', () => {
  const desde = new Date('2026-11-17T02:30:00Z'); // 16/11 23:30 de Argentina
  assert.equal(validarHasta('', desde), null);
  assert.equal(validarHasta(null, desde), null);
  assert.equal(validarHasta('2026-11-16', desde), '2026-11-16', 'el mismo día de Argentina vale');
  assert.equal(validarHasta('2026-12-31', desde), '2026-12-31');
  assert.throws(() => validarHasta('2026-11-15', desde), /antes del día/);
  assert.throws(() => validarHasta('2026-02-30', desde), /no es una fecha/);
  assert.throws(() => validarHasta('16/11/2026', desde), /no es una fecha/);
});
