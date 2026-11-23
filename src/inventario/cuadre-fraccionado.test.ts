/* El cuadre semanal del fraccionado (23/11/2026). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnaDe, cuadreSemana, netoEnStock, semanaDe, type MovSemana } from './cuadre-fraccionado';

const { desde, hasta } = semanaDe('2026-11-18');
const mov = (fecha: string, tipo: string, netos: Record<number, number>): MovSemana => ({
  fecha, tipo, netos: new Map(Object.entries(netos).map(([k, v]) => [Number(k), v])),
});

test('la semana va de lunes a domingo, en hora argentina', () => {
  const s = semanaDe('2026-11-18');
  assert.equal(s.lunes, '2026-11-16');
  assert.equal(s.domingo, '2026-11-22');
  assert.equal(s.desde.toISOString(), '2026-11-16T03:00:00.000Z');
  assert.equal(s.hasta.toISOString(), '2026-11-23T03:00:00.000Z');
  assert.equal(semanaDe('2026-11-16').lunes, '2026-11-16');
  assert.equal(semanaDe('2026-11-22').lunes, '2026-11-16');
});

test('columnas: armado, recibido/enviado, vendido neto de devoluciones, bajas y ajustes', () => {
  assert.equal(columnaDe('fraccionamiento', 10), 'armado');
  assert.equal(columnaDe('transferencia', -5), 'enviado');
  assert.equal(columnaDe('transferencia', 5), 'recibido');
  assert.equal(columnaDe('venta_fraccionada', -1), 'vendido');
  assert.equal(columnaDe('devolucion', 1), 'vendido');
  assert.equal(columnaDe('merma', -1), 'bajas');
  assert.equal(columnaDe('envio_cafeteria', -2), 'bajas');
  assert.equal(columnaDe('ajuste', 3), 'ajustes');
});

test('pasar de disponible a comprometido o a tránsito no es entrar ni salir; vencerse sí', () => {
  const n = netoEnStock([
    { sucursalId: 1, presentacionId: 7, estado: 'disponible', delta: -4 },
    { sucursalId: 1, presentacionId: 7, estado: 'en_transito', delta: 4 },
    { sucursalId: 1, presentacionId: 8, estado: 'disponible', delta: -2 },
    { sucursalId: 1, presentacionId: 8, estado: 'vencido', delta: 2 },
    { sucursalId: 2, presentacionId: 9, estado: 'disponible', delta: 5 },
  ], 1);
  assert.deepEqual([...n], [[8, -2]]);
});

test('todo registrado: no falta nada y la cuenta cierra', () => {
  const c = cuadreSemana([
    mov('2026-11-16T12:00:00Z', 'fraccionamiento', { 0: -5, 7: 10 }),
    mov('2026-11-17T12:00:00Z', 'venta_fraccionada', { 7: -6 }),
    mov('2026-11-18T12:00:00Z', 'transferencia', { 7: -4 }),
  ], new Map([[0, 15], [7, 2]]), desde, hasta).get(7)!;
  assert.deepEqual(c, { presentacionId: 7, inicio: 2, armado: 10, recibido: 0, vendido: -6, enviado: -4, bajas: 0, ajustes: 0, fin: 2, sinArmar: 0 });
});

test('se vende y se manda sin armar en el sistema: sale sin estar armado', () => {
  const c = cuadreSemana([
    mov('2026-11-17T12:00:00Z', 'venta_fraccionada', { 7: -6 }),
    mov('2026-11-18T12:00:00Z', 'transferencia', { 7: -10 }),
  ], new Map([[7, -12]]), desde, hasta).get(7)!;
  assert.equal(c.inicio, 4);
  assert.equal(c.sinArmar, 12);
});

test('el fraccionado cargado tarde en la misma semana salda lo que había salido', () => {
  const c = cuadreSemana([
    mov('2026-11-17T12:00:00Z', 'venta_fraccionada', { 7: -6 }),
    mov('2026-11-19T12:00:00Z', 'fraccionamiento', { 0: -3, 7: 6 }),
  ], new Map([[7, 0]]), desde, hasta).get(7)!;
  assert.equal(c.sinArmar, 0);
});

test('un control que encuentra los paquetes no los registra como armados', () => {
  const c = cuadreSemana([
    mov('2026-11-17T12:00:00Z', 'venta_fraccionada', { 7: -8 }),
    mov('2026-11-20T12:00:00Z', 'ajuste', { 7: 8 }),
  ], new Map([[7, 0]]), desde, hasta).get(7)!;
  assert.equal(c.inicio, 0);
  assert.equal(c.ajustes, 8);
  assert.equal(c.sinArmar, 8);
});

test('un control que deja en 0 y después se vende: salió sin estar armado', () => {
  const c = cuadreSemana([
    mov('2026-11-17T12:00:00Z', 'ajuste', { 7: -10 }),
    mov('2026-11-18T12:00:00Z', 'venta_fraccionada', { 7: -5 }),
  ], new Map([[7, -5]]), desde, hasta).get(7)!;
  assert.equal(c.inicio, 10);
  assert.equal(c.sinArmar, 5);
});

test('lo de después de la semana se descuenta de hoy para saber cómo terminó', () => {
  const c = cuadreSemana([
    mov('2026-11-17T12:00:00Z', 'venta_fraccionada', { 7: -3 }),
    mov('2026-11-25T12:00:00Z', 'fraccionamiento', { 0: -2, 7: 20 }),
  ], new Map([[7, 20]]), desde, hasta).get(7)!;
  assert.equal(c.fin, 0);
  assert.equal(c.inicio, 3);
  assert.equal(c.sinArmar, 0);
});
