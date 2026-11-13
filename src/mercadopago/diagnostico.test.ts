/*
 * MERCADO PAGO — diagnóstico de la cuenta: el resumen de los pagos y del reporte de liberaciones.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumirPagos, resumirReporte } from './diagnostico';

const AHORA = new Date('2026-11-13T15:00:00Z');
const pago = (o: any) => ({
  status: 'approved', payment_type_id: 'account_money', payment_method_id: 'account_money', operation_type: 'regular_payment',
  transaction_amount: 100, fee_details: [], transaction_details: { net_received_amount: 100 }, ...o,
});

test('agrupa por tipo, operación, origen y estado, sin datos del pagador', () => {
  const r = resumirPagos([
    pago({ id: 1, point_of_interaction: { type: 'OPENPLATFORM' }, pos_id: 77, external_reference: 'SYA-V10-C3',
      fee_details: [{ fee_payer: 'collector', amount: 6 }, { fee_payer: 'payer', amount: 9 }], transaction_details: { net_received_amount: 94 },
      payer: { email: 'cliente@ejemplo.com', first_name: 'Ana' } }),
    pago({ id: 2, point_of_interaction: { type: 'OPENPLATFORM' }, pos_id: 77, transaction_amount: 50, transaction_details: { net_received_amount: 50 } }),
    pago({ id: 3, payment_type_id: 'bank_transfer', operation_type: 'money_transfer', transaction_amount: 1000, transaction_details: { net_received_amount: 1000 } }),
    pago({ id: 4, status: 'rejected', transaction_amount: 999 }),
  ], [{ mpPosId: '77', nombre: 'Caja 1', sucursal: 'Fontana' }], AHORA);
  assert.equal(r.total, 4);
  assert.equal(r.aprobados, 3, 'el rechazado no cuenta como cobrado');
  const qr = r.grupos.find((g) => g.origen === 'OPENPLATFORM');
  assert.ok(qr);
  assert.equal(qr.n, 2);
  assert.equal(qr.bruto, 150);
  assert.equal(qr.comision, 6, 'solo la comisión que paga el que cobra');
  assert.equal(qr.ejemplos[0].caja, 'Caja 1');
  assert.equal(qr.ejemplos[0].deErp, true, 'la referencia SYA-V…-C… es un cobro del ERP');
  assert.equal(JSON.stringify(r).includes('cliente@ejemplo.com'), false, 'el mail del pagador no viaja');
  assert.equal(JSON.stringify(r).includes('Ana'), false, 'el nombre del pagador no viaja');
  assert.deepEqual(r.porCaja.map((c) => [c.caja, c.n, c.bruto]), [
    ['Sin caja (no vino por un QR del ERP ni por un pos)', 1, 1000],
    ['Caja 1', 2, 150],
  ]);
});

test('lo que falta liberar, por día; lo ya liberado o rechazado no', () => {
  const r = resumirPagos([
    pago({ id: 1, money_release_date: '2026-11-20T10:00:00.000-03:00', money_release_status: 'pending', transaction_amount: 200, transaction_details: { net_received_amount: 190 } }),
    pago({ id: 2, money_release_date: '2026-11-20T18:00:00.000-03:00', transaction_amount: 100, transaction_details: { net_received_amount: 95 } }),
    pago({ id: 3, money_release_date: '2026-11-10T10:00:00.000-03:00', money_release_status: 'released' }),
    pago({ id: 4, money_release_date: '2026-11-25T10:00:00.000-03:00', money_release_status: 'released' }),
    pago({ id: 5, status: 'rejected', money_release_date: '2026-11-21T10:00:00.000-03:00' }),
    pago({ id: 6, payment_type_id: 'credit_card', money_release_date: '2026-12-13T10:00:00.000-03:00' }),
    pago({ id: 7, money_release_date: '2026-11-21T22:30:00.000-03:00', transaction_amount: 10, transaction_details: { net_received_amount: 10 } }),
  ], [], AHORA);
  assert.deepEqual(r.aLiberar, [
    { dia: '2026-11-20', n: 2, neto: 285 },
    { dia: '2026-11-21', n: 1, neto: 10 }, // 22:30 de Argentina es el 22 en UTC: cuenta el día de acá
    { dia: '2026-12-13', n: 1, neto: 100 },
  ]);
});

test('reporte de liberaciones: columnas, renglones y totales por tipo (coma o punto y coma)', () => {
  const csv = '﻿DATE;SOURCE_ID;DESCRIPTION;NET_CREDIT_AMOUNT;NET_DEBIT_AMOUNT\n'
    + '2026-11-01;1;payment;1.234,50;0\n2026-11-01;2;payment;100;0\n2026-11-02;3;withdrawal;0;5000\n'
    + '2026-11-02;4;"payout; transfer";0;"10,5"\n';
  const r = resumirReporte(csv);
  assert.deepEqual(r.columnas, ['DATE', 'SOURCE_ID', 'DESCRIPTION', 'NET_CREDIT_AMOUNT', 'NET_DEBIT_AMOUNT']);
  assert.equal(r.renglones, 4);
  assert.deepEqual(r.porTipo.find((t) => t.tipo === 'payment'), { tipo: 'payment', n: 2, credito: 1334.5, debito: 0 });
  assert.equal(r.porTipo.find((t) => t.tipo === 'withdrawal')?.debito, 5000);
  assert.equal(r.porTipo.find((t) => t.tipo === 'payout; transfer')?.debito, 10.5, 'comillas con el separador adentro');
  const ambas = resumirReporte('RECORD_TYPE;DESCRIPTION;NET_DEBIT_AMOUNT\nrelease;withdrawal;10\nrelease;payout;5\n');
  assert.deepEqual(ambas.porTipo.map((t) => t.tipo).sort(), ['payout', 'withdrawal'], 'DESCRIPTION manda sobre RECORD_TYPE aunque venga después');
  const coma = resumirReporte('DATE,DESCRIPTION,NET_CREDIT_AMOUNT\n2026-11-01,payment,50.25\n');
  assert.equal(coma.porTipo[0].credito, 50.25);
  assert.deepEqual(resumirReporte(''), { columnas: [], renglones: 0, porTipo: [], primeros: [] });
});
