/*
 * Contra qué se compara (7/11/2026): los días justo antes, del mismo largo, o
 * el mismo período del mes anterior (Indicadores).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { periodoAnterior, unMesAntes } from './consultas';

const f = (desde: string, hasta: string, comparar: 'mes' | null = null) => ({ desde, hasta, sucursalId: 3, comparar });
const rango = (x: { desde: string; hasta: string }) => `${x.desde}→${x.hasta}`;

test('sin elegir: los días justo antes, del mismo largo', () => {
  assert.equal(rango(periodoAnterior(f('2026-11-02', '2026-11-07'))), '2026-10-27→2026-11-01');
});

test('mismo período del mes anterior: del 2 al 7 de noviembre contra del 2 al 7 de octubre', () => {
  const a = periodoAnterior(f('2026-11-02', '2026-11-07', 'mes'));
  assert.equal(rango(a), '2026-10-02→2026-10-07');
  assert.equal(a.sucursalId, 3);
  /* Enero contra diciembre del año anterior. */
  assert.equal(rango(periodoAnterior(f('2026-01-05', '2026-01-11', 'mes'))), '2025-12-05→2025-12-11');
});

test('un mes entero se compara con el mes entero, aunque tengan distinto largo', () => {
  assert.equal(rango(periodoAnterior(f('2026-11-01', '2026-11-30', 'mes'))), '2026-10-01→2026-10-31');
  assert.equal(rango(periodoAnterior(f('2026-03-01', '2026-03-31', 'mes'))), '2026-02-01→2026-02-28');
  assert.equal(rango(periodoAnterior(f('2028-03-01', '2028-03-31', 'mes'))), '2028-02-01→2028-02-29');
});

test('un día que el mes anterior no tiene cae en su último día', () => {
  assert.equal(unMesAntes('2026-03-31'), '2026-02-28');
  assert.equal(unMesAntes('2026-05-31'), '2026-04-30');
  assert.equal(unMesAntes('2026-10-30', true), '2026-09-30');
  /* El 30 de octubre no es fin de mes: va al 30 de septiembre, no se estira. */
  assert.equal(unMesAntes('2026-12-30', true), '2026-11-30');
});
