import test from 'node:test';
import assert from 'node:assert/strict';
import { coincideNumero, papelMasCercano, sugerirProveedor } from './fletes';

test('el número escrito coincide con o sin punto de venta, con ceros o sin ellos', () => {
  const c = { puntoVenta: '0003', numero: 1234 };
  assert.equal(coincideNumero('0003-00001234', c), true);
  assert.equal(coincideNumero('3-1234', c), true);
  assert.equal(coincideNumero('FC A 0003-1234', c), true);
  assert.equal(coincideNumero('1234', c), true);
  assert.equal(coincideNumero('0004-1234', c), false);
  assert.equal(coincideNumero('123', c), false);
  assert.equal(coincideNumero('', c), false);
  assert.equal(coincideNumero('1234', { puntoVenta: '0001', numero: null }), false);
});

const padron = [
  'DONINAS  S. A. S.', 'REAL FOOD', 'REAL NATURA FOOD', 'CHACABUCO', 'PASTAS FUNCIONALES CHACABUCO S.A', 'JUAN TUTUCAS',
  'DOÑA ROSA FIDEOS SIN TACC', 'BIO-SALUD S.R.L', 'Sabor andino', 'NUESTROS SABORES', 'TRUST FOODS S.R.L SMAMS',
  'ANA HERNANDEZ PRODUCTOS ALIMEN SANTA MARIA', 'SANTA RITA FORMOSA', 'ALIMENTOS VILLARES', 'LA VILLA SRL',
].map((nombre, i) => ({ id: i + 1, nombre }));
const sugerido = (concepto: string) => sugerirProveedor(concepto, padron)?.nombre ?? null;

test('sugiere el proveedor por lo escrito en el renglón', () => {
  assert.equal(sugerido('DONINAS - 5 BULTOS'), 'DONINAS  S. A. S.');
  assert.equal(sugerido('SMAMS - 1PALLETS'), 'TRUST FOODS S.R.L SMAMS');
  assert.equal(sugerido('BIO SALUD - 6 BULTOS'), 'BIO-SALUD S.R.L');
  assert.equal(sugerido('DOÑA ROSA - 20 BULTOS'), 'DOÑA ROSA FIDEOS SIN TACC');
  assert.equal(sugerido('TUTUCA SIN AZUCAR'), 'JUAN TUTUCAS');
});

test('a igualdad de palabras gana el nombre sin palabras de más', () => {
  assert.equal(sugerido('REAL FOOD'), 'REAL FOOD');
  assert.equal(sugerido('CHACABUCO - 1 PALLETS'), 'CHACABUCO');
  assert.equal(sugerido('SABOR ANDINO - 1 PALLETS'), 'Sabor andino');
  assert.equal(sugerido('SANTA MARIA - 1 PALLETS'), 'ANA HERNANDEZ PRODUCTOS ALIMEN SANTA MARIA');
  assert.equal(sugerido('VILLARES - 1 PALLETS'), 'ALIMENTOS VILLARES');
});

test('sin parecido, o con empate, no sugiere', () => {
  assert.equal(sugerido('QUERCUS - 19 BULTOS'), null);
  assert.equal(sugerido('38 BULTOS'), null);
  assert.equal(sugerirProveedor('FOOD', [{ id: 1, nombre: 'GOOD FOOD' }, { id: 2, nombre: 'BEST FOOD' }]), null);
});

test('el papel de una carga vieja: el del proveedor más cerca de la fecha del flete', () => {
  const papeles = [
    { id: 1, fecha: '2026-10-20T03:00:00Z' },
    { id: 2, fecha: '2026-09-01T03:00:00Z' },
    { id: 3, fecha: '2026-10-30T03:00:00Z' },
  ];
  assert.equal(papelMasCercano('2026-10-23T03:00:00Z', papeles)?.id, 1);
  assert.equal(papelMasCercano('2026-10-29T03:00:00Z', papeles)?.id, 3);
  assert.equal(papelMasCercano('2026-12-01T03:00:00Z', papeles), null);
  assert.equal(papelMasCercano('2026-10-25T03:00:00Z', [{ id: 1, fecha: '2026-10-23T03:00:00Z' }, { id: 2, fecha: '2026-10-27T03:00:00Z' }]), null);
  /* Mitad y mitad: factura A y liquidación del mismo día son la misma entrega. */
  assert.equal(papelMasCercano('2026-10-23T03:00:00Z', [
    { id: 7, tipo: 'liquidacion', fecha: '2026-10-21T03:00:00Z' }, { id: 8, tipo: 'factura', fecha: '2026-10-21T03:00:00Z' },
  ])?.id, 8);
});
