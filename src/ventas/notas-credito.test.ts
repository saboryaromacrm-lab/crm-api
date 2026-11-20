import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arcaDeLaNota, motivoDeLaNota, plataDeLaNota } from './notas-credito';

test('la plata de la nota: efectivo del cajón, cuenta corriente, por el mismo medio o cambio', () => {
  assert.equal(plataDeLaNota({ cajaSesionId: 82, condicionPago: 'contado' }), 'efectivo');
  assert.equal(plataDeLaNota({ cajaSesionId: null, condicionPago: 'cuenta_corriente' }), 'ctacte');
  assert.equal(plataDeLaNota({ cajaSesionId: null, condicionPago: 'contado' }), 'medio');
  assert.equal(plataDeLaNota({ cajaSesionId: null, condicionPago: 'contado', cambio: true }), 'cambio');
});

test('la nota ante ARCA', () => {
  assert.equal(arcaDeLaNota({ tipo: 'nota_credito_b', cae: '7654', facturarPendiente: false }), 'cae');
  assert.equal(arcaDeLaNota({ tipo: 'nota_credito_b', cae: '', facturarPendiente: true }), 'pendiente');
  assert.equal(arcaDeLaNota({ tipo: 'nota_credito_ticket', cae: '', facturarPendiente: false }), 'interna');
});

test('el motivo sin la marca de la venta original', () => {
  assert.equal(motivoDeLaNota('Producto vencido\n[Nota de crédito de Factura B 00032-00000604]'), 'Producto vencido');
  assert.equal(motivoDeLaNota('Se equivocó de talle\n[Devolución de Ticket 0001-00000012]'), 'Se equivocó de talle');
  assert.equal(motivoDeLaNota(''), '');
});
