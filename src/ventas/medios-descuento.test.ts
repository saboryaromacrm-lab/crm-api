/*
 * Un descuento con varios medios de pago (0208): cómo se leen, se guardan y se
 * controlan al cobrar.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediosDeDescuento, mediosLegibles, normalizarMedios, pagoFueraDeLista } from './medios-descuento';

test('lee la lista nueva; si está vacía, la columna vieja', () => {
  assert.deepEqual(mediosDeDescuento({ mediosPago: 'transferencia,efectivo' }), ['efectivo', 'transferencia']);
  assert.deepEqual(mediosDeDescuento({ mediosPago: '', medioPago: 'efectivo' }), ['efectivo']);
  assert.deepEqual(mediosDeDescuento({ mediosPago: '', medioPago: null }), []);
});

test('guarda sin repetidos, sin desconocidos y en el orden de la caja', () => {
  assert.deepEqual(normalizarMedios(['qr', 'efectivo', 'qr', 'inventado', ' transferencia ']), ['efectivo', 'transferencia', 'qr']);
  assert.deepEqual(normalizarMedios([]), []);
});

test('el texto para la cajera', () => {
  assert.equal(mediosLegibles(['efectivo']), 'efectivo');
  assert.equal(mediosLegibles(['efectivo', 'transferencia']), 'efectivo o transferencia');
  assert.equal(mediosLegibles(['efectivo', 'transferencia', 'qr']), 'efectivo, transferencia o QR / billetera');
});

test('repartir entre medios de la lista cumple; uno de afuera no', () => {
  const permitidos = ['efectivo', 'transferencia'];
  assert.equal(pagoFueraDeLista(permitidos, [{ medio: 'efectivo', importe: 500 }, { medio: 'transferencia', importe: 500 }]), null);
  assert.deepEqual(pagoFueraDeLista(permitidos, [{ medio: 'efectivo', importe: 900 }, { medio: 'tarjeta_debito', importe: 100 }]), { medio: 'tarjeta_debito', importe: 100 });
  // un renglón en $0 no cuenta como pago
  assert.equal(pagoFueraDeLista(permitidos, [{ medio: 'efectivo', importe: 1000 }, { medio: 'qr', importe: 0 }]), null);
  assert.equal(pagoFueraDeLista(permitidos, undefined), null);
});
