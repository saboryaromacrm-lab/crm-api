/*
 * La ficha de movimientos (kardex): cada clase de movimiento con lo que mueve,
 * los saldos hacia atrás y lo que no cierra. Casos tomados de cómo escribe cada
 * camino de inventario.service.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deltasDe, incoherencias, saldosHaciaAtras, type Mov } from './kardex';

const mov = (x: Partial<Mov>): Mov => ({ id: 1, tipo: 'compra', sucursalId: 1, presentacionId: null, signo: 1, cantidad: 10, estadoDesde: null, estadoHacia: 'disponible', ...x });
const d = (m: Mov, items?: any[], tam?: any) => deltasDe(m, items, tam).deltas.map((x) => [x.presentacionId, x.estado, x.delta]);

test('compra, venta, devolución, ajustes', () => {
  assert.deepEqual(d(mov({})), [[0, 'disponible', 10]]);
  assert.deepEqual(d(mov({ tipo: 'venta_fraccionada', presentacionId: 5, signo: -1, cantidad: 3, estadoDesde: 'disponible', estadoHacia: null })), [[5, 'disponible', -3]]);
  assert.deepEqual(d(mov({ tipo: 'devolucion', cantidad: 2 })), [[0, 'disponible', 2]]);
  assert.deepEqual(d(mov({ tipo: 'ajuste', signo: -1, cantidad: 4, estadoDesde: 'disponible', estadoHacia: null })), [[0, 'disponible', -4]]);
});

test('merma pasa a vencido; incidencia; cambio de estado; mismo estado con signo', () => {
  assert.deepEqual(d(mov({ tipo: 'vencido', signo: -1, cantidad: 2, estadoDesde: 'disponible', estadoHacia: 'vencido' })), [[0, 'disponible', -2], [0, 'vencido', 2]]);
  assert.deepEqual(d(mov({ tipo: 'merma', signo: -1, cantidad: 2, estadoDesde: 'comprometido', estadoHacia: null })), [[0, 'comprometido', -2]]);
  assert.deepEqual(d(mov({ tipo: 'transferencia', signo: 0, cantidad: 6, estadoDesde: 'disponible', estadoHacia: 'comprometido' })), [[0, 'disponible', -6], [0, 'comprometido', 6]]);
  assert.deepEqual(d(mov({ tipo: 'ajuste', signo: -1, cantidad: 1, estadoDesde: 'disponible', estadoHacia: 'disponible' })), [[0, 'disponible', -1]]);
  assert.deepEqual(d(mov({ tipo: 'ajuste', signo: 1, cantidad: 1, estadoDesde: 'disponible', estadoHacia: 'disponible' })), [[0, 'disponible', 1]]);
});

test('transferencia recibida: sale del origen (en tránsito) y entra al destino (filas aparte)', () => {
  assert.deepEqual(d(mov({ tipo: 'transferencia', sucursalId: 1, signo: -1, cantidad: 5, estadoDesde: 'en_transito', estadoHacia: null })), [[0, 'en_transito', -5]]);
  const destino = deltasDe(mov({ tipo: 'transferencia', sucursalId: 3, signo: 1, cantidad: 5 })).deltas[0];
  assert.equal(destino.sucursalId, 3);
  assert.equal(destino.delta, 5);
});

test('fraccionado: los kg salen del suelto y los paquetes entran, con el registro', () => {
  const m = mov({ tipo: 'fraccionamiento', signo: 0, cantidad: 3, estadoHacia: null });
  assert.deepEqual(d(m, [{ presentacionId: 8, paquetes: 4, tamKg: 0.5 }, { presentacionId: 9, paquetes: 4, tamKg: 0.25 }]), [[0, 'disponible', -3], [8, 'disponible', 4], [9, 'disponible', 4]]);
  /* Corrección para abajo: paquetes negativos, los kg vuelven al suelto. */
  assert.deepEqual(d(m, [{ presentacionId: 8, paquetes: -2, tamKg: 0.5 }]), [[0, 'disponible', 1], [8, 'disponible', -2]]);
  /* Sin registro (anterior a la 0102): deducido de los kg y marcado. */
  const r = deltasDe(mov({ tipo: 'fraccionamiento', presentacionId: 8, signo: 0, cantidad: 2, estadoHacia: null }), [], () => 0.5);
  assert.equal(r.estimado, true);
  assert.deepEqual(r.deltas.map((x) => x.delta), [-2, 4]);
});

test('fraccionado de un pedido al cargar lo armado (0206): pasa en lo reservado', () => {
  const m = mov({ tipo: 'fraccionamiento', presentacionId: 8, signo: 0, cantidad: 1, estadoDesde: 'comprometido', estadoHacia: 'comprometido' });
  assert.deepEqual(d(m, [{ presentacionId: 8, paquetes: 2, tamKg: 0.5 }]), [[0, 'comprometido', -1], [8, 'comprometido', 2]]);
});

test('saldos hacia atrás y la carga inicial', () => {
  /* Hoy 7. Movimientos: compra 10 (id 1), venta 5 (id 2), compra 2 (id 3). Antes de todo: 0. */
  const k = '1|0|disponible';
  const movs = [
    { id: 1, deltas: [{ sucursalId: 1, presentacionId: 0, estado: 'disponible', delta: 10 }] },
    { id: 2, deltas: [{ sucursalId: 1, presentacionId: 0, estado: 'disponible', delta: -5 }] },
    { id: 3, deltas: [{ sucursalId: 1, presentacionId: 0, estado: 'disponible', delta: 2 }] },
  ];
  const r = saldosHaciaAtras(movs, new Map([[k, 7]]));
  assert.equal(r.despues.get(3)!.get(k), 7);
  assert.equal(r.despues.get(2)!.get(k), 5);
  assert.equal(r.despues.get(1)!.get(k), 10);
  assert.equal(r.inicial.get(k), 0);
  assert.deepEqual(incoherencias(r.inicial), []);
});

test('lo que no cierra: stock que bajó sin movimiento, o un estado tocado sin registro', () => {
  const k = '1|0|disponible';
  /* Hoy 3 pero los movimientos dicen +10 −5 = 5: faltan 2 que salieron sin movimiento. */
  const r = saldosHaciaAtras([
    { id: 1, deltas: [{ sucursalId: 1, presentacionId: 0, estado: 'disponible', delta: 10 }] },
    { id: 2, deltas: [{ sucursalId: 1, presentacionId: 0, estado: 'disponible', delta: -5 }] },
  ], new Map([[k, 3]]));
  assert.equal(r.inicial.get(k), -2);
  assert.equal(incoherencias(r.inicial).length, 1);
  assert.equal(incoherencias(new Map([['1|0|comprometido', 4]])).length, 1);
  /* Carga inicial común: stock que ya estaba antes del primer movimiento. No es incoherencia. */
  assert.deepEqual(incoherencias(new Map([[k, 40]])), []);
});
