import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atarSolos, familiaMp, medioReal, movimientoDe, seGuarda, sugerir, type CobroErp, type PagoMp } from './conciliacion';

const t = (hhmm: string, dia = '2026-11-17') => new Date(`${dia}T${hhmm}:00-03:00`);
const cobro = (clave: string, hhmm: string, importe: number, familia: CobroErp['familia'], extra: Partial<CobroErp> = {}): CobroErp =>
  ({ clave, fecha: t(hhmm), importe, familia, sucursalId: 1, ...extra });
const pago = (id: string, hhmm: string, bruto: number, familia: PagoMp['familia'], extra: Partial<PagoMp> = {}): PagoMp =>
  ({ id, fecha: t(hhmm), bruto, familia, sucursalId: null, ...extra });

test('qué es cada pago de Mercado Pago y cuáles se guardan', () => {
  assert.equal(familiaMp({ point_of_interaction: { type: 'POINT' } }), 'tarjeta');
  assert.equal(familiaMp({ point_of_interaction: { type: 'INSTORE' } }), 'qr');
  assert.equal(familiaMp({ point_of_interaction: { type: 'PSP_TRANSFER' }, operation_type: 'money_transfer' }), 'transferencia');
  assert.equal(seGuarda({ status: 'approved', operation_type: 'regular_payment', collector_id: 9 }, 9), true);
  assert.equal(seGuarda({ status: 'rejected' }, 9), false);
  assert.equal(seGuarda({ status: 'approved', operation_type: 'partition_transfer' }, 9), false, 'movimiento entre reservas');
  assert.equal(seGuarda({ status: 'approved', payer: { id: 9 } }, 9), false, 'lo pagamos nosotros');
  assert.equal(seGuarda({ status: 'approved', operation_type: 'pos_payment', collector_id: 9, payer: { id: 9 } }, 9), true, 'Point con tarjeta anónima');
  assert.equal(seGuarda({ status: 'approved', collector: { id: 9 } }, 9), true);
  assert.equal(seGuarda({ status: 'approved', collector_id: 5 }, 9), false);
});

test('el renglón guardado: importes, sucursal por la caja y solo el nombre del que transfiere', () => {
  const m = movimientoDe({
    id: 123, status: 'approved', date_approved: '2026-11-17T10:00:00.000-03:00', date_last_updated: '2026-11-17T10:01:00.000-03:00',
    point_of_interaction: { type: 'PSP_TRANSFER', transaction_data: { bank_info: { payer: { long_name: 'Juana Pérez' } } } },
    payer: { email: 'no@se.guarda', identification: { number: '123' } }, transaction_amount: 1500.005,
    fee_details: [{ fee_payer: 'collector', amount: 10 }, { fee_payer: 'payer', amount: 99 }],
    transaction_details: { net_received_amount: 1490 }, pos_id: 77,
  }, (pos) => (pos === '77' ? 3 : null));
  assert.equal(m.id, '123');
  assert.equal(m.bruto, 1500.01);
  assert.equal(m.comision, 10);
  assert.equal(m.sucursalId, 3);
  assert.equal(m.pagador, 'Juana Pérez');
  assert.equal(JSON.stringify(m).includes('no@se.guarda'), false);
});

test('se ata solo: el QR del ERP por número, y por importe y hora lo que es tantos como tantos', () => {
  const pares = atarSolos(
    [
      cobro('v1', '10:00', 2500, 'qr', { mpId: '900' }),
      cobro('v2', '10:10', 1500, 'tarjeta'),
      cobro('v3', '10:30', 1500, 'tarjeta'),
      cobro('v4', '11:00', 800, 'qr'),
    ],
    [
      pago('900', '10:01', 2500, 'qr'),
      pago('a', '10:11', 1500, 'tarjeta'),
      pago('b', '10:31', 1500, 'tarjeta'),
      pago('c', '13:00', 800, 'qr'), // fuera de la ventana
    ],
  );
  assert.deepEqual(pares.map((p) => `${p.clave}=${p.mpId}`).sort(), ['v1=900', 'v2=a', 'v3=b']);
});

test('no se ata: dos cobros contra un pago (no se sabe cuál falta), otra sucursal u otro medio', () => {
  assert.deepEqual(atarSolos([cobro('v1', '10:00', 1500, 'qr'), cobro('v2', '10:05', 1500, 'qr')], [pago('a', '10:02', 1500, 'qr')]), []);
  assert.deepEqual(atarSolos([cobro('v1', '10:00', 1500, 'qr')], [pago('a', '10:01', 1500, 'qr', { sucursalId: 2 })]), []);
  assert.deepEqual(atarSolos([cobro('v1', '10:00', 1500, 'tarjeta')], [pago('a', '10:01', 1500, 'qr')]), []);
});

test('una transferencia de un pedido puede llegar días antes de la venta', () => {
  const pares = atarSolos([cobro('v1', '18:00', 50000, 'transferencia')], [pago('a', '09:00', 50000, 'transferencia', { fecha: t('09:00', '2026-11-15') })]);
  assert.deepEqual(pares, [{ clave: 'v1', mpId: 'a' }]);
});

test('sugerencias: varios posibles, otro medio, monto distinto; cada pago una sola vez', () => {
  const s = sugerir(
    [
      cobro('v1', '10:00', 1500, 'qr'),
      cobro('v2', '10:05', 1500, 'qr'),
      cobro('v3', '11:00', 3000, 'tarjeta'),
      cobro('v4', '12:00', 2500, 'tarjeta'),
    ],
    [
      pago('a', '10:01', 1500, 'qr'),
      pago('b', '11:10', 3000, 'qr'),
      pago('c', '12:01', 25000, 'tarjeta'),
    ],
  );
  assert.deepEqual(s.map((x) => `${x.clave}=${x.mpId}:${x.motivo}`).sort(), ['v1=a:varios', 'v3=b:otro_medio', 'v4=c:monto_distinto']);
});

test('el medio de verdad, en los medios del ERP (o nada si no es claro)', () => {
  assert.equal(medioReal({ familia: 'tarjeta', tipo: 'credit_card' }), 'tarjeta_credito');
  assert.equal(medioReal({ familia: 'tarjeta', tipo: 'debit_card' }), 'tarjeta_debito');
  assert.equal(medioReal({ familia: 'tarjeta', tipo: 'prepaid_card' }), 'tarjeta_debito');
  assert.equal(medioReal({ familia: 'qr', tipo: 'credit_card' }), 'qr', 'un QR pagado con tarjeta sigue siendo QR');
  assert.equal(medioReal({ familia: 'transferencia', tipo: 'account_money' }), 'transferencia');
  assert.equal(medioReal({ familia: 'transferencia', tipo: 'bank_transfer' }), 'transferencia');
  assert.equal(medioReal({ familia: 'transferencia', tipo: 'credit_card' }), 'tarjeta_credito', 'link de pago con tarjeta');
  assert.equal(medioReal({ familia: 'tarjeta', tipo: 'account_money' }), null, 'el Point cobrando con dinero en cuenta: no se corrige');
  assert.equal(medioReal({ familia: 'transferencia', tipo: 'digital_currency' }), null);
});

test('un cobro con número de pago no se ata a otro que se le parezca', () => {
  const pares = atarSolos([cobro('v1', '10:00', 5000, 'qr', { mpId: '111' })], [pago('222', '10:05', 5000, 'qr')]);
  assert.deepEqual(pares, []);
});

test('transferencias: solo se atan solas si hay una de cada lado', () => {
  const t = (clave: string, dia: string, importe: number) => cobro(clave, '12:00', importe, 'transferencia', { fecha: new Date(`2026-11-${dia}T12:00:00-03:00`) });
  const p = (id: string, dia: string, importe: number) => pago(id, '12:00', importe, 'transferencia', { fecha: new Date(`2026-11-${dia}T11:00:00-03:00`) });
  assert.deepEqual(atarSolos([t('v1', '17', 20000), t('v2', '18', 20000)], [p('a', '17', 20000), p('b', '18', 20000)]), []);
  assert.deepEqual(atarSolos([t('v1', '17', 20000)], [p('a', '17', 20000)]), [{ clave: 'v1', mpId: 'a' }]);
});
