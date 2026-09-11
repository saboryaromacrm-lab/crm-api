/**
 * La prueba que importa acá no es "agrupa bien": es que agrupar dé EXACTAMENTE
 * lo mismo que el `filter` que reemplaza, incluido el orden. De ese orden
 * dependen los precios (ver `formatoActivo`), así que una diferencia silenciosa
 * saldría por caja.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agruparPor, grupo } from './agrupar';

/** Filas parecidas a las reales: varias por producto, en orden mezclado. */
const filas = [
  { id: 1, productoId: 10, presentacionId: null, nota: 'a' },
  { id: 2, productoId: 20, presentacionId: null, nota: 'b' },
  { id: 3, productoId: 10, presentacionId: 5, nota: 'c' },
  { id: 4, productoId: 10, presentacionId: null, nota: 'd' },
  { id: 5, productoId: 30, presentacionId: null, nota: 'e' },
  { id: 6, productoId: 20, presentacionId: 7, nota: 'f' },
  { id: 7, productoId: 10, presentacionId: 5, nota: 'g' },
];

test('agrupar da el MISMO resultado que filter, producto por producto', () => {
  const porProducto = agruparPor(filas, (f) => f.productoId);
  for (const pid of [10, 20, 30, 99]) {
    const conFilter = filas.filter((f) => f.productoId === pid);
    assert.deepEqual(grupo(porProducto, pid), conFilter, `producto ${pid}`);
  }
});

test('EL ORDEN SE CONSERVA (de esto dependen los precios)', () => {
  const porProducto = agruparPor(filas, (f) => f.productoId);
  // Del producto 10 vienen, en este orden: id 1, 3, 4, 7.
  assert.deepEqual(grupo(porProducto, 10).map((f) => f.id), [1, 3, 4, 7]);
  assert.deepEqual(grupo(porProducto, 20).map((f) => f.id), [2, 6]);
});

test('clave compuesta producto+presentacion, igual que el filter de dos campos', () => {
  const k = (f: any) => `${f.productoId}:${f.presentacionId ?? ''}`;
  const mapa = agruparPor(filas, k);
  for (const [pid, presId] of [[10, null], [10, 5], [20, 7], [30, null], [99, null]] as const) {
    const conFilter = filas.filter(
      (f) => f.productoId === pid && (f.presentacionId ?? null) === presId,
    );
    assert.deepEqual(grupo(mapa, `${pid}:${presId ?? ''}`), conFilter, `${pid}/${presId}`);
  }
});

test('una lista vacía no rompe nada, y una clave que no existe da lista vacía', () => {
  assert.equal(agruparPor([], (x: any) => x.id).size, 0);
  assert.deepEqual(grupo(agruparPor(filas, (f) => f.productoId), 12345), []);
});

test('el grupo devuelto es el mismo array (no una copia por llamada)', () => {
  // Importa porque el código lo recorre varias veces: si cada lectura copiara,
  // se perdería parte de lo ganado.
  const mapa = agruparPor(filas, (f) => f.productoId);
  assert.equal(grupo(mapa, 10), grupo(mapa, 10));
});
