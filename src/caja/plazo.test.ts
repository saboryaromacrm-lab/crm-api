/**
 * EL PLAZO PARA CERRAR LA CAJA (0212 y 0214). Es la regla que decide si una caja
 * con días de cierre deja vender: un corrimiento de un día deja una caja abierta
 * sin frenar, o frena a un local en plazo. Por eso queda escrita como pruebas.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cerrarHastaDe, diaEnPalabras, plazoDelTurno, textoDiasCierre } from './plazo';

/* Semana del lunes 26/10/2026. Lunes = 1 … domingo = 7. */
const LUNES_Y_MIERCOLES = [1, 3];

test('lunes y miércoles: cada apertura vence en el próximo día de cierre, contando el de hoy', () => {
  assert.equal(cerrarHastaDe(LUNES_Y_MIERCOLES, '2026-10-26'), '2026-10-26'); // abre el lunes: se cierra esa noche
  assert.equal(cerrarHastaDe(LUNES_Y_MIERCOLES, '2026-10-27'), '2026-10-28'); // martes → miércoles
  assert.equal(cerrarHastaDe(LUNES_Y_MIERCOLES, '2026-10-29'), '2026-11-02'); // jueves → lunes (cruza el mes)
  assert.equal(cerrarHastaDe(LUNES_Y_MIERCOLES, '2026-11-01'), '2026-11-02'); // domingo → lunes
});

test('un solo día de cierre: como mucho, una semana', () => {
  assert.equal(cerrarHastaDe([1], '2026-10-27'), '2026-11-02');
  assert.equal(cerrarHastaDe([7], '2026-11-01'), '2026-11-01');
});

test('todos los días (o nada cargado): sin último día propio', () => {
  assert.equal(cerrarHastaDe([1, 2, 3, 4, 5, 6, 7], '2026-10-27'), null);
  assert.equal(cerrarHastaDe([7, 6, 5, 4, 3, 2, 1, 1], '2026-10-27'), null);
  assert.equal(cerrarHastaDe(null, '2026-10-27'), null);
});

test('caja del martes con cierre el miércoles: en plazo, vence hoy, vencida y frena', () => {
  const t = { apertura: '2026-10-27T09:00:00-03:00', cerrarHasta: '2026-10-28' };
  assert.equal(plazoDelTurno(t, '2026-10-27').estado, 'en_plazo');
  assert.equal(plazoDelTurno(t, '2026-10-28').estado, 'vence_hoy');
  assert.equal(plazoDelTurno(t, '2026-10-28').bloquea, false);
  const jueves = plazoDelTurno(t, '2026-10-29');
  assert.deepEqual({ estado: jueves.estado, bloquea: jueves.bloquea, programada: jueves.programada }, { estado: 'vencida', bloquea: true, programada: true });
});

test('caja abierta el mismo día de cierre: si no se cierra esa noche, al otro día frena', () => {
  const t = { apertura: '2026-10-26T09:00:00-03:00', cerrarHasta: '2026-10-26' };
  assert.equal(plazoDelTurno(t, '2026-10-26').estado, 'vence_hoy');
  assert.equal(plazoDelTurno(t, '2026-10-27').bloquea, true);
});

test('todos los días: vence el mismo día y, vencida, no frena la venta', () => {
  const t = { apertura: '2026-10-26T09:00:00-03:00', cerrarHasta: null };
  assert.equal(plazoDelTurno(t, '2026-10-26').estado, 'vence_hoy');
  assert.equal(plazoDelTurno(t, '2026-10-27').estado, 'vencida');
  assert.equal(plazoDelTurno(t, '2026-10-27').bloquea, false);
  assert.equal(plazoDelTurno(t, '2026-10-27').programada, false);
});

test('el día de la apertura es el argentino, no el UTC', () => {
  /* 22:30 del lunes en Argentina ya es martes en UTC. */
  assert.equal(plazoDelTurno({ apertura: '2026-10-27T01:30:00Z' }, '2026-10-26').cerrarHasta, '2026-10-26');
});

test('en palabras', () => {
  assert.equal(diaEnPalabras('2026-10-28'), 'miércoles 28/10');
  assert.equal(textoDiasCierre([3, 1]), 'Los lunes y miércoles');
  assert.equal(textoDiasCierre([1, 3, 6, 7]), 'Los lunes, miércoles, sábados y domingos');
  assert.equal(textoDiasCierre([5]), 'Los viernes');
  assert.equal(textoDiasCierre([1, 2, 3, 4, 5, 6, 7]), 'Todos los días');
});
