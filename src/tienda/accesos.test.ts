import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sinPrecios } from './tienda.module';
import { dniDe } from './accesos';

test('sin ingreso: el catálogo sale sin nada de plata y con lo demás intacto', () => {
  const oferta = { id: 1, nombre: 'X', tipo: 'porcentaje', badge: '10% OFF', precioOferta: 90 };
  const cat = {
    listaId: 3, listaNombre: 'Mayorista', montoMinimo: 80000, montoMinimoCamioneta: 120000, reglasMarca: [{ marcaId: 1, unidadesMinimas: 6 }],
    items: [
      { id: 1, nombre: 'Alfajor', precio: 100, oferta, unidadesMinimas: 6, enStock: true, disponible: 4 },
      {
        id: 2, nombre: 'Albahaca', precio: 50, oferta: null, enStock: true,
        variantes: [{ clave: 'p10', etiqueta: 'Bolsa de 10 kg', precio: 500, precioKg: 50, precioPaquete: 500, ahorroPct: 5, oferta, ahorroMinorista: { pct: 20 }, disponible: 3, unidadesMinimas: 1 }],
      },
    ],
  };
  const x = sinPrecios(cat);
  const plata = ['precio', 'oferta', 'precioKg', 'precioPaquete', 'ahorroPct', 'ahorroMinorista'];
  for (const it of x.items) {
    assert.ok(plata.every((k) => !(k in it)), `producto ${it.id} sin plata`);
    for (const v of it.variantes ?? []) assert.ok(plata.every((k) => !(k in v)), `opción ${v.clave} sin plata`);
  }
  assert.deepEqual([x.conPrecios, x.cliente, x.listaId, x.listaNombre, x.montoMinimoCamioneta], [false, null, null, '', 0]);
  assert.equal(x.montoMinimo, 80000, 'la compra mínima se anuncia a todos (cartel de bienvenida)');
  assert.deepEqual([x.hayMinimoEnvio, sinPrecios({ ...cat, montoMinimoCamioneta: 0 }).hayMinimoEnvio], [true, false], 'del envío sin costo, solo SI hay piso');
  assert.deepEqual([x.items[0].unidadesMinimas, x.items[0].disponible, x.items[1].variantes[0].etiqueta, x.items[1].variantes[0].disponible], [6, 4, 'Bolsa de 10 kg', 3], 'stock y mínimos en unidades quedan');
  assert.equal(x.reglasMarca.length, 1);
  assert.equal(cat.items[0].precio, 100, 'no toca el catálogo original');
});

test('el DNI de la tienda: 7 u 8 números, puntos y espacios tolerados', () => {
  assert.equal(dniDe('35.678.242'), '35678242');
  assert.equal(dniDe(' 1234567 '), '1234567');
  assert.equal(dniDe('123456'), '');
  assert.equal(dniDe('123456789'), '');
  assert.equal(dniDe('35-678-242'), '');
  assert.equal(dniDe(undefined), '');
});
