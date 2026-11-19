import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mpDeLosRenglones, type FilaAtado } from './mp-del-pago';

const fila = (x: Partial<FilaAtado>): FilaAtado => ({
  ventaPagoId: 1, atado: 'auto', motivo: '', medioAnterior: null, id: null, estado: 'approved', familia: 'qr',
  tipo: 'account_money', metodo: 'account_money', cuotas: 1, bruto: 100, devuelto: 0, caja: 'Caja 1', ...x,
});

test('atado: un renglón con dos pagos de Mercado Pago (dos tarjetas en el Point)', () => {
  const m = mpDeLosRenglones(
    [{ id: 1, medio: 'tarjeta_debito', referencia: '', importe: 300 }],
    [fila({ id: 'a', familia: 'tarjeta', tipo: 'debit_card', metodo: 'debvisa', bruto: 100, caja: null }),
      fila({ id: 'b', familia: 'tarjeta', tipo: 'debit_card', metodo: 'debmaster', bruto: 200, caja: null })],
    [],
  );
  const r = m.get(1)!;
  assert.equal(r.atado, 'auto');
  assert.deepEqual(r.pagos.map((p) => p.id), ['a', 'b']);
});

test('«No entró» queda sin pagos y con el motivo', () => {
  const m = mpDeLosRenglones([{ id: 1, medio: 'qr', referencia: '', importe: 100 }],
    [fila({ atado: 'sin_mp', motivo: 'Se cobró en efectivo', id: null })], []);
  assert.equal(m.get(1)!.atado, 'sin_mp');
  assert.equal(m.get(1)!.motivo, 'Se cobró en efectivo');
  assert.equal(m.get(1)!.pagos.length, 0);
});

test('QR del ERP sin atar: sale del cobro, con su caja', () => {
  const m = mpDeLosRenglones(
    [{ id: 7, medio: 'qr', referencia: 'MP 189143095373', importe: 23646 },
      { id: 8, medio: 'qr', referencia: '', importe: 500 },
      { id: 9, medio: 'qr', referencia: 'MP orden ORD1', importe: 50 }],
    [],
    [{ paymentId: '189143095373', orderId: 'X', info: { tipo: 'credit_card', metodo: 'visa', cuotas: 3 }, caja: 'Caja 2', monto: 23646 },
      { paymentId: '', orderId: 'ORD1', info: null, caja: 'Caja 1', monto: 50 }],
  );
  const r = m.get(7)!;
  assert.equal(r.atado, null);
  assert.equal(r.pagos[0].familia, 'qr');
  assert.equal(r.pagos[0].caja, 'Caja 2');
  assert.equal(r.pagos[0].cuotas, 3);
  assert.equal(m.has(8), false);
  assert.equal(m.get(9)!.pagos[0].caja, 'Caja 1');
});

test('el atado manda sobre el cobro del QR del ERP', () => {
  const m = mpDeLosRenglones([{ id: 7, medio: 'qr', referencia: 'MP 5', importe: 10 }],
    [fila({ ventaPagoId: 7, atado: 'manual', id: '5', caja: 'Caja 3' })],
    [{ paymentId: '5', orderId: null, info: null, caja: 'Caja 9', monto: 10 }]);
  assert.equal(m.get(7)!.atado, 'manual');
  assert.equal(m.get(7)!.pagos[0].caja, 'Caja 3');
});
