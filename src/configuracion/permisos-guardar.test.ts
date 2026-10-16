/*
 * Quién puede guardar la config de ventas (3/10/2026): las llaves de stock se
 * manejan desde Almacén › Configuración, así que con SOLO esas llaves alcanza
 * `almacen.configuracion`; con cualquier otra, vuelve a pedir la de ventas.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permisosParaGuardar } from './configuracion.module';

test('las llaves de stock: ventas o almacén', () => {
  assert.deepEqual(permisosParaGuardar('ventas', { controlStockGranel: false }), ['ventas.configuracion', 'almacen.configuracion']);
  assert.deepEqual(permisosParaGuardar('ventas', { permitirStockNegativo: true, controlStockEnteros: true }), ['ventas.configuracion', 'almacen.configuracion']);
});

test('las llaves de la tienda online: ventas o la tienda (16/10/2026)', () => {
  assert.deepEqual(permisosParaGuardar('ventas', { tiendaMinoristaActiva: false, envioCamionetaActivo: true }), ['ventas.configuracion', 'web.configuracion']);
  assert.deepEqual(permisosParaGuardar('ventas', { tiendaVistaLista: true, montoMinimoMayorista: 1 }), ['ventas.configuracion'], 'la compra mínima es de la caja');
  assert.deepEqual(permisosParaGuardar('ventas', { tiendaVistaLista: true, controlStockGranel: false }), ['ventas.configuracion'], 'mezcla de grupos: solo ventas');
});

test('cualquier otra llave mezclada: solo ventas', () => {
  assert.deepEqual(permisosParaGuardar('ventas', { controlStockGranel: false, cajaObligatoria: false }), ['ventas.configuracion']);
  assert.deepEqual(permisosParaGuardar('ventas', { overrideListaRequiereAdmin: true }), ['ventas.configuracion']);
  assert.deepEqual(permisosParaGuardar('ventas', {}), ['ventas.configuracion'], 'vacío no abre nada');
  assert.deepEqual(permisosParaGuardar('ventas', null), ['ventas.configuracion']);
});

test('las otras áreas no cambian', () => {
  assert.deepEqual(permisosParaGuardar('web', { controlStockGranel: false }), ['web.configuracion']);
  assert.equal(permisosParaGuardar('inventada', {}), undefined);
});
