/**
 * EL PLAZO PARA CERRAR LA CAJA (0212). Es la regla que decide si una caja de
 * varios días deja vender: un corrimiento de un día deja una caja abierta sin
 * frenar, o frena a un local en plazo. Por eso queda escrita como pruebas.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diaEnPalabras, plazoDelTurno } from './plazo';

/* Lunes 26/10/2026, 9 h en Argentina. */
const LUNES = '2026-10-26T09:00:00-03:00';

test('cada 3 días: abre el lunes, cierra a más tardar el miércoles', () => {
  const t = { apertura: LUNES, plazoDias: 3 };
  assert.equal(plazoDelTurno(t, '2026-10-26').cerrarHasta, '2026-10-28');
  assert.equal(plazoDelTurno(t, '2026-10-27').estado, 'en_plazo');
  assert.equal(plazoDelTurno(t, '2026-10-28').estado, 'vence_hoy');
  assert.equal(plazoDelTurno(t, '2026-10-28').bloquea, false);
  const jueves = plazoDelTurno(t, '2026-10-29');
  assert.deepEqual({ estado: jueves.estado, bloquea: jueves.bloquea }, { estado: 'vencida', bloquea: true });
});

test('todos los días: vence el mismo día y, vencida, no frena la venta', () => {
  const t = { apertura: LUNES, plazoDias: 1 };
  assert.equal(plazoDelTurno(t, '2026-10-26').estado, 'vence_hoy');
  assert.equal(plazoDelTurno(t, '2026-10-27').estado, 'vencida');
  assert.equal(plazoDelTurno(t, '2026-10-27').bloquea, false);
});

test('el día de la apertura es el argentino, no el UTC', () => {
  /* 22:30 del lunes en Argentina ya es martes en UTC. */
  const t = { apertura: '2026-10-27T01:30:00Z', plazoDias: 2 };
  assert.equal(plazoDelTurno(t, '2026-10-26').cerrarHasta, '2026-10-27');
});

test('un plazo fuera de rango cae entre 1 y 7', () => {
  assert.equal(plazoDelTurno({ apertura: LUNES, plazoDias: null }).plazoDias, 1);
  assert.equal(plazoDelTurno({ apertura: LUNES, plazoDias: 30 }).plazoDias, 7);
});

test('cruza fin de mes', () => {
  assert.equal(plazoDelTurno({ apertura: '2026-10-30T10:00:00-03:00', plazoDias: 4 }, '2026-10-30').cerrarHasta, '2026-11-02');
});

test('el día en palabras', () => {
  assert.equal(diaEnPalabras('2026-10-28'), 'miércoles 28/10');
});
