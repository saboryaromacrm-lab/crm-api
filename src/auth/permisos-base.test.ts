/**
 * Los permisos de fábrica: que estén SIEMPRE, y que el café siga afuera.
 *
 * Esto no es una prueba de adorno. La regla nació de un pedido concreto del
 * dueño —"Vencimientos y los envíos a la cafetería tienen que andar en toda
 * sucursal, con cualquier usuario"— y la única forma de que no se pierda en el
 * próximo cambio de permisos es dejarla escrita acá.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERMISOS_BASE, conPermisosBase } from './permisos-base';

/** Lo mínimo para que Vencimientos se vea Y se pueda cerrar el circuito. */
const IMPRESCINDIBLES = ['almacen.vencimientos', 'almacen.cafeteria', 'inventario', 'merma', 'defectuoso'];

test('la base trae lo que el dueño pidió: vencimientos completo y envíos al café', () => {
  for (const clave of IMPRESCINDIBLES) {
    assert.ok(PERMISOS_BASE.includes(clave), `falta ${clave} en PERMISOS_BASE`);
  }
});

test('un rol pelado igual entra a Vencimientos y a Cafetería', () => {
  const p = conPermisosBase([], 'cajero');
  for (const clave of IMPRESCINDIBLES) assert.ok(p.includes(clave), `al cajero le falta ${clave}`);
});

test('no se pierde ni se repite nada de lo que el rol ya traía', () => {
  const p = conPermisosBase(['ventas.pos', 'almacen.vencimientos'], 'cajero');
  assert.ok(p.includes('ventas.pos'), 'se perdió un permiso propio del rol');
  assert.equal(p.filter((x) => x === 'almacen.vencimientos').length, 1, 'quedó duplicado');
});

test('el superadmin vuelve intacto: el comodín ya puede todo', () => {
  assert.deepEqual(conPermisosBase(['*'], 'superadmin'), ['*']);
});

test('el rol Cafetería NO puede despacharse mercadería a sí mismo', () => {
  const p = conPermisosBase(['almacen.cafeteria-pedidos'], 'cafeteria');
  assert.deepEqual(p, ['almacen.cafeteria-pedidos'], 'coffit no debe recibir la base');
  assert.ok(!p.includes('almacen.cafeteria'), 'coffit no puede despachar del depósito');
});

test('aguanta un rol sin permisos cargados (null/undefined) sin romperse', () => {
  assert.ok(conPermisosBase(null, 'cajero').includes('almacen.vencimientos'));
  assert.ok(conPermisosBase(undefined).includes('almacen.cafeteria'));
});

test('la base NO reparte llaves de caja, precios ni usuarios', () => {
  const prohibidos = ['ventas.caja', 'precios', 'gerencia.usuarios', 'sistema.respaldos', 'nota_credito', '*'];
  for (const clave of prohibidos) {
    assert.ok(!PERMISOS_BASE.includes(clave), `${clave} NO puede venir de fábrica`);
  }
});
