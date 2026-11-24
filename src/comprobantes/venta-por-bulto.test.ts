import test from 'node:test';
import assert from 'node:assert/strict';
import { ventasACambiar } from './venta-por-bulto';

/* La avena: bolsa de 30 kg → 20 kg. Lista 1 (mayorista) vende la bolsa cerrada; la minorista, por kilo. */
const bultos = new Map([[155, { antes: 30, despues: 20 }]]);
const filas = [
  { productoId: 155, listaId: 1, unidades: 30 },
  { productoId: 155, listaId: 3, unidades: 1 },
];

test('la lista que vende la bolsa cerrada pasa al bulto nuevo; la del kilo no', () => {
  const { cambios, errores } = ventasACambiar([{ productoId: 155, listas: [1, 3] }], bultos, filas);
  assert.deepEqual(cambios, [{ productoId: 155, listaId: 1, antes: 30, despues: 20 }]);
  assert.deepEqual(errores, []);
});

test('solo las listas elegidas', () => {
  assert.deepEqual(ventasACambiar([{ productoId: 155, listas: [3] }], bultos, filas).cambios, []);
});

test('sin un cambio de bulto que lo respalde, es un error (no se toca la venta)', () => {
  const r = ventasACambiar([{ productoId: 155, listas: [1] }], new Map([[155, { antes: 30, despues: 30 }]]), filas);
  assert.deepEqual(r, { cambios: [], errores: [155] });
  assert.deepEqual(ventasACambiar([{ productoId: 9, listas: [1] }], bultos, filas).errores, [9]);
});

test('una fila que ya no vende el bulto viejo (la cambió alguien) no se pisa', () => {
  assert.deepEqual(ventasACambiar([{ productoId: 155, listas: [1] }], bultos, [{ productoId: 155, listaId: 1, unidades: 25 }]).cambios, []);
});
