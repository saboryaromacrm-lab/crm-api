/**
 * Las reglas PURAS de autorización: quién pasa, quién es jefe y con qué
 * sucursal se graba. El guard en sí necesita Nest y la base; estas funciones
 * no, y son las que deciden si un cajero puede tocar la caja de otro local.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claveDeServicioValida, esJefe, soloSuSucursal, sucursalDeOperacion, tienePermiso } from './auth.guard';

const cajero = { rolClave: 'cajero', permisos: ['ventas.pos', 'ventas.caja'], sucursalId: 2 };
const admin = { rolClave: 'admin', permisos: ['ventas.pos', 'gerencia.usuarios'], sucursalId: 1 };
const superadmin = { rolClave: 'superadmin', permisos: ['*'], sucursalId: 1 };

test('tienePermiso: el comodín pasa siempre; el resto necesita ALGUNA clave', () => {
  assert.equal(tienePermiso(['*'], ['lo.que.sea']), true);
  assert.equal(tienePermiso(cajero.permisos, ['ventas.pos']), true);
  assert.equal(tienePermiso(cajero.permisos, ['ventas.cobranzas', 'ventas.caja']), true, 'con una alcanza');
  assert.equal(tienePermiso(cajero.permisos, ['gerencia.usuarios']), false);
  assert.equal(tienePermiso([], ['ventas.pos']), false);
});

test('esJefe: admin, superadmin o comodín', () => {
  assert.equal(esJefe(cajero), false);
  assert.equal(esJefe(admin), true);
  assert.equal(esJefe(superadmin), true);
  assert.equal(esJefe({ rolClave: 'vendedor', permisos: ['*'] }), true, 'el comodín manda aunque el rol se llame distinto');
  assert.equal(esJefe({}), false);
});

test('sucursalDeOperacion: el cajero está clavado a la suya; el jefe puede cruzar', () => {
  assert.equal(sucursalDeOperacion(cajero, 5), 2, 'el body no manda para el cajero');
  assert.equal(sucursalDeOperacion(cajero), 2);
  assert.equal(sucursalDeOperacion(admin, 5), 5, 'el jefe opera donde pidió');
  assert.equal(sucursalDeOperacion(admin), 1, 'sin pedir, la de su sesión');
  assert.equal(sucursalDeOperacion(admin, null), 1);
  assert.equal(sucursalDeOperacion({ rolClave: 'cajero' }), undefined, 'sin sucursal en la sesión no hay dónde grabar');
});

test('soloSuSucursal: null = sin límite, que es el caso del jefe', () => {
  assert.equal(soloSuSucursal(cajero), 2);
  assert.equal(soloSuSucursal(admin), null);
  assert.equal(soloSuSucursal(superadmin), null);
});

test('claveDeServicioValida: sin la variable de entorno la puerta no existe', () => {
  const variable = 'CLAVE_DE_PRUEBA_' + process.pid;
  delete process.env[variable];
  assert.equal(claveDeServicioValida({ headers: { 'x-clave-servicio': 'abc' } }, variable), false);

  process.env[variable] = 'secreto-largo-y-al-azar';
  try {
    assert.equal(claveDeServicioValida({ headers: { 'x-clave-servicio': 'secreto-largo-y-al-azar' } }, variable), true);
    assert.equal(claveDeServicioValida({ headers: { 'x-clave-servicio': 'secreto-largo-y-al-aza' } }, variable), false, 'largo distinto');
    assert.equal(claveDeServicioValida({ headers: { 'x-clave-servicio': 'secreto-largo-y-al-azaX' } }, variable), false, 'mismo largo, otro contenido');
    assert.equal(claveDeServicioValida({ headers: {} }, variable), false, 'sin cabecera');
    assert.equal(claveDeServicioValida({}, variable), false, 'sin headers');
  } finally {
    delete process.env[variable];
  }
});
