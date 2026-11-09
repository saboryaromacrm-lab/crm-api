/*
 * Días abiertos y turnos (9/11/2026): la cuenta de un período a partir de los días por local.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { porDiaAbierto, resumirActividad, type DiaLocal } from './actividad';

const d = (dia: string, suc: number, abrio = true, turnos = 1): DiaLocal => ({ dia, suc, abrio, turnos });

test('días del negocio, días-local, turnos y los días sin abrir', () => {
  const filas = [
    d('2026-05-01', 1, false, 0), // feriado: nadie vendió
    d('2026-05-02', 1), d('2026-05-02', 2, true, 2),
    d('2026-05-03', 2),
    d('2026-05-04', 1, false, 1), // abrió la caja pero no vendió: turno sí, día no
  ];
  const a = resumirActividad(filas, '2026-05-01', '2026-05-05', '2026-11-09');
  assert.equal(a.dias, 5);
  assert.equal(a.abiertos, 2);
  assert.equal(a.diasLocal, 3);
  assert.equal(a.turnos, 5);
  assert.deepEqual(a.sinAbrir, ['2026-05-01', '2026-05-04', '2026-05-05']);
  assert.deepEqual(a.porSucursal, { 1: { dias: 1, turnos: 2 }, 2: { dias: 2, turnos: 3 } });
});

test('el período en curso cuenta hasta hoy, y los días de afuera no entran', () => {
  const filas = [d('2026-10-31', 1), d('2026-11-02', 1), d('2026-11-08', 1)];
  const a = resumirActividad(filas, '2026-11-01', '2026-11-30', '2026-11-03');
  assert.equal(a.dias, 3);
  assert.equal(a.abiertos, 1);
  assert.deepEqual(a.sinAbrir, ['2026-11-01', '2026-11-03']);
});

test('un período que todavía no empezó no tiene días', () => {
  const a = resumirActividad([], '2026-12-01', '2026-12-31', '2026-11-09');
  assert.equal(a.dias, 0);
  assert.equal(a.abiertos, 0);
  assert.deepEqual(a.sinAbrir, []);
});

test('por día abierto: sin días abiertos no hay promedio', () => {
  assert.equal(porDiaAbierto(1000, { abiertos: 3 }), 333.33);
  assert.equal(porDiaAbierto(1000, { abiertos: 0 }), null);
});
