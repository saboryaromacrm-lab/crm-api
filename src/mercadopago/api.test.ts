/*
 * MERCADO PAGO (0126) — lo puro: la firma de los avisos y el formato de importe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { firmaValida, importeMp, pagoDeOrden, pagoSirve, resumenPago } from './api';

const SECRETO = 'clave-de-prueba';
const firmar = (manifiesto: string, ts = '1742505638683') => `ts=${ts},v1=${createHmac('sha256', SECRETO).update(manifiesto).digest('hex')}`;

test('firma de los avisos: válida, alterada, sin clave', () => {
  const antes = process.env.MP_WEBHOOK_SECRET;
  process.env.MP_WEBHOOK_SECRET = SECRETO;
  try {
    const id = 'ORD01JQ4S4KY8HWQ6NA5PXB65B3D3';
    const req = '2066ca19-c6f1-498a-be75-1923005edd06';
    const buena = firmar(`id:${id.toLowerCase()};request-id:${req};ts:1742505638683;`);
    assert.equal(firmaValida(buena, req, id), true, 'id en minúsculas (como pide Mercado Pago)');
    assert.equal(firmaValida(firmar(`id:${id};request-id:${req};ts:1742505638683;`), req, id), true, 'id tal cual también');
    assert.equal(firmaValida(buena, req, 'ORD-OTRA'), false, 'otro id: no');
    assert.equal(firmaValida(buena, 'otro-request', id), false, 'otro request-id: no');
    assert.equal(firmaValida('ts=1,v1=abc', req, id), false, 'firma inventada: no');
    assert.equal(firmaValida(undefined, req, id), false, 'sin firma: no');
    delete process.env.MP_WEBHOOK_SECRET;
    assert.equal(firmaValida(buena, req, id), false, 'sin clave en el servidor no se da por buena');
  } finally {
    if (antes === undefined) delete process.env.MP_WEBHOOK_SECRET; else process.env.MP_WEBHOOK_SECRET = antes;
  }
});

test('importe como lo pide la API de Orders', () => {
  assert.equal(importeMp(1621), '1621.00');
  assert.equal(importeMp(2917.8), '2917.80');
  assert.equal(importeMp(0.1 + 0.2), '0.30');
  assert.equal(importeMp(1234.565), '1234.57');
});

test('¿la orden está paga? (3/10/2026: el primer cobro real quedó esperando)', () => {
  const pagos = (status: string, extra: any = {}) => ({ transactions: { payments: [{ id: 'PAY1', amount: '20920.00', status, ...extra }] } });
  assert.deepEqual(pagoDeOrden({ status: 'processed', status_detail: 'accredited', ...pagos('processed') }, 20920), { pagado: true, paymentId: 'PAY1' });
  assert.equal(pagoDeOrden({ status: 'at_terminal', status_detail: 'accredited', ...pagos('processed') }, 20920).pagado, true, 'accredited aunque el estado de arriba no diga processed');
  assert.equal(pagoDeOrden({ status: 'created', ...pagos('processed', { status_detail: 'accredited', paid_amount: '20920.00' }) }, 20920).pagado, true, 'el pago acreditado cubre el monto');
  assert.equal(pagoDeOrden({ status: 'created', ...pagos('approved') }, 20920).pagado, true, 'pago approved');
  assert.equal(pagoDeOrden({ status: 'created', ...pagos('created') }, 20920).pagado, false, 'sin pagar');
  assert.equal(pagoDeOrden({ status: 'created', ...pagos('processed', { paid_amount: '100.00' }) }, 20920).pagado, false, 'pagó menos: no');
  assert.equal(pagoDeOrden({ status: 'refunded', status_detail: 'refunded', ...pagos('refunded') }, 20920).pagado, false, 'devuelto: no');
  assert.equal(pagoDeOrden({ status: 'expired', ...pagos('expired') }, 20920).pagado, false, 'vencido: no');
  assert.equal(pagoDeOrden(null, 20920).pagado, false);
});

test('un pago de la búsqueda sirve si está aprobado, por el monto y sin devolver', () => {
  assert.equal(pagoSirve({ status: 'approved', transaction_amount: 20920 }, 20920), true);
  assert.equal(pagoSirve({ status: 'approved', transaction_amount: 20920.004 }, 20920), true);
  assert.equal(pagoSirve({ status: 'approved', transaction_amount: 20919 }, 20920), false, 'otro monto');
  assert.equal(pagoSirve({ status: 'pending', transaction_amount: 20920 }, 20920), false, 'pendiente');
  assert.equal(pagoSirve({ status: 'approved', transaction_amount: 20920, transaction_amount_refunded: 20920 }, 20920), false, 'devuelto');
});

test('con qué pagó el cliente: dinero en cuenta, crédito en cuotas, y sin el pago clásico', () => {
  const cuenta = resumenPago({ payment_type_id: 'account_money', payment_method_id: 'account_money', installments: 1, transaction_amount: 20920,
    fee_details: [{ type: 'mercadopago_fee', amount: 167.36, fee_payer: 'collector' }], transaction_details: { net_received_amount: 20752.64, total_paid_amount: 20920 } }, null, 20920);
  assert.deepEqual(cuenta, { tipo: 'account_money', metodo: 'account_money', cuotas: 1, comision: 167.36, interesCliente: 0, neto: 20752.64, total: 20920, completo: true });
  const credito = resumenPago({ payment_type_id: 'credit_card', payment_method_id: 'visa', installments: 3, transaction_amount: 20920,
    fee_details: [{ type: 'mercadopago_fee', amount: 836.8, fee_payer: 'collector' }, { type: 'financing_fee', amount: 3100, fee_payer: 'payer' }],
    transaction_details: { net_received_amount: 20083.2, total_paid_amount: 24020 } }, null, 20920);
  assert.equal(credito!.cuotas, 3);
  assert.equal(credito!.comision, 836.8, 'al comercio: solo la comisión');
  assert.equal(credito!.interesCliente, 3100, 'el interés lo pagó el cliente');
  assert.equal(credito!.neto, 20083.2);
  const sinInteres = resumenPago({ payment_type_id: 'credit_card', installments: 6, transaction_amount: 10000,
    fee_details: [{ type: 'mercadopago_fee', amount: 400, fee_payer: 'collector' }, { type: 'financing_fee', amount: 1500, fee_payer: 'collector' }],
    transaction_details: { net_received_amount: 8100, total_paid_amount: 10000 } }, null, 10000);
  assert.equal(sinInteres!.comision, 1900, 'cuotas sin interés: el costo lo paga el comercio');
  assert.equal(sinInteres!.interesCliente, 0);
  const deOrden = resumenPago(null, { payment_method: { id: 'master', type: 'debit_card', installments: 1 }, paid_amount: '500.00' }, 500);
  assert.deepEqual(deOrden, { tipo: 'debit_card', metodo: 'master', cuotas: 1, comision: null, interesCliente: 0, neto: null, total: 500, completo: false });
  assert.equal(resumenPago(null, null, 1), null);
});
