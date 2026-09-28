/*
 * EL ARMADO DEL COMPROBANTE PARA ARCA (28/9/2026) — antes de facturar de
 * verdad. Todo lo que se prueba acá es puro (sin red ni certificado) y es lo
 * que, si está mal, ARCA rechaza o —peor— acepta con un dato equivocado: los
 * códigos, el desglose de IVA al centavo, el receptor, el QR y las fechas.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALICUOTA_ID, CBTE_TIPO, COND_IVA_RECEPTOR, DOC_TIPO, armarAlicuotas, armarReceptor, esFiscal, faltaIdentificar, letraDe,
} from './comprobante';
import { urlQrFiscal, codigoComprobante } from './qr';
import { fechaComprobante, fechaQr, parsearFechaArca, selloWsaa } from './fecha';

const CF = { tipoDoc: 'sin_identificar', numeroDoc: '', condicionIva: 'consumidor_final', esConsumidorFinal: true };

test('códigos de ARCA: tipos de comprobante, documentos, condición IVA y alícuotas', () => {
  assert.deepEqual(
    [CBTE_TIPO.factura_a, CBTE_TIPO.factura_b, CBTE_TIPO.factura_c, CBTE_TIPO.nota_credito_a, CBTE_TIPO.nota_credito_b],
    [1, 6, 11, 3, 8],
  );
  assert.deepEqual([DOC_TIPO.CUIT, DOC_TIPO.CUIL, DOC_TIPO.DNI, DOC_TIPO.SIN_IDENTIFICAR], [80, 86, 96, 99]);
  assert.deepEqual(
    [COND_IVA_RECEPTOR.responsable_inscripto, COND_IVA_RECEPTOR.exento, COND_IVA_RECEPTOR.consumidor_final, COND_IVA_RECEPTOR.monotributo],
    [1, 4, 5, 6],
  );
  assert.deepEqual([ALICUOTA_ID['21'], ALICUOTA_ID['10.5'], ALICUOTA_ID['0'], ALICUOTA_ID['27']], [5, 4, 3, 6]);
  assert.equal(letraDe('factura_b'), 'B');
  assert.equal(letraDe('nota_credito_a'), 'A');
  assert.equal(esFiscal('ticket'), false);
  assert.equal(esFiscal('factura_a'), true);
  assert.equal(codigoComprobante('factura_b'), 6);
});

test('desglose de IVA: una fila por alícuota y las sumas cierran AL CENTAVO con la venta', () => {
  // 3 × $0,01 de diferencia por redondeo renglón a renglón: el total de la venta manda.
  const renglones = [{ neto: 100.004, iva: 21 }, { neto: 200.004, iva: 21 }, { neto: 50.004, iva: 10.5 }];
  const filas = armarAlicuotas(renglones, { neto: 350.01, iva: 68.26 });
  assert.equal(filas.length, 2);
  assert.equal(filas[0].id, 5, 'la de base más grande primero (21%)');
  const base = Math.round(filas.reduce((a, f) => a + f.baseImp, 0) * 100) / 100;
  const iva = Math.round(filas.reduce((a, f) => a + f.importe, 0) * 100) / 100;
  assert.equal(base, 350.01);
  assert.equal(iva, 68.26);
  assert.throws(() => armarAlicuotas([{ neto: 100, iva: 19 }], { neto: 100, iva: 19 }), /alícuota/);
  assert.deepEqual(armarAlicuotas([], { neto: 0, iva: 0 }), []);
});

test('receptor: la Factura A exige CUIT; la B a consumidor final va 99/0', () => {
  assert.throws(() => armarReceptor('A', CF, 1000, 0), /CUIT/);
  assert.deepEqual(
    armarReceptor('A', { tipoDoc: 'cuit', numeroDoc: '30-62936116-9', condicionIva: 'responsable_inscripto', esConsumidorFinal: false }, 1000, 0),
    { docTipo: 80, docNro: '30629361169', condIvaReceptorId: 1 },
  );
  assert.deepEqual(
    armarReceptor('A', { tipoDoc: 'cuit', numeroDoc: '20111111112', condicionIva: 'monotributo', esConsumidorFinal: false }, 1000, 0).condIvaReceptorId,
    6, 'al monotributista, Factura A con condición 6',
  );
  assert.deepEqual(armarReceptor('B', CF, 5000, 10_000_000), { docTipo: 99, docNro: '0', condIvaReceptorId: 5 });
  assert.deepEqual(
    armarReceptor('B', { tipoDoc: 'dni', numeroDoc: '35.678.242', condicionIva: 'consumidor_final', esConsumidorFinal: false }, 20_000_000, 10_000_000),
    { docTipo: 96, docNro: '35678242', condIvaReceptorId: 5 },
  );
});

test('tope sin identificar: arriba del tope, la B sin documento no sale (ARCA la rechazaría)', () => {
  assert.throws(() => armarReceptor('B', CF, 10_000_000.01, 10_000_000), /supera el tope/);
  assert.equal(faltaIdentificar('B', CF, 10_000_000.01, 10_000_000), true);
  assert.equal(faltaIdentificar('B', CF, 10_000_000, 10_000_000), false, 'igual al tope, pasa');
  assert.equal(faltaIdentificar('B', CF, 99_000_000, 0), false, 'tope 0 = sin control');
  assert.equal(faltaIdentificar('B', { tipoDoc: 'dni', numeroDoc: '35678242' }, 99_000_000, 10), false, 'identificado, pasa');
  assert.equal(faltaIdentificar('B', { tipoDoc: 'sin_identificar', numeroDoc: '123' }, 99, 10), true, 'sin_identificar con número igual cuenta como no identificado');
  assert.equal(faltaIdentificar('A', CF, 99_000_000, 10), false, 'la A tiene su propia regla (CUIT siempre)');
});

test('QR (RG 4892): la URL de ARCA con los datos del comprobante', () => {
  const antes = process.env.ARCA_CUIT;
  process.env.ARCA_CUIT = '30-11111111-1';
  try {
    const url = urlQrFiscal({
      tipo: 'factura_b', puntoVenta: '00003', numero: 42, fecha: new Date('2026-09-28T15:00:00Z'), total: 1234.5,
      cae: '76123456789012', receptor: { tipoDoc: 'dni', numeroDoc: '35.678.242' },
    });
    assert.ok(url?.startsWith('https://www.afip.gob.ar/fe/qr/?p='));
    const p = JSON.parse(Buffer.from(url!.split('?p=')[1], 'base64').toString('utf8'));
    assert.deepEqual(p, {
      ver: 1, fecha: '2026-09-28', cuit: 30111111111, ptoVta: 3, tipoCmp: 6, nroCmp: 42, importe: 1234.5,
      moneda: 'PES', ctz: 1, tipoDocRec: 96, nroDocRec: 35678242, tipoCodAut: 'E', codAut: 76123456789012,
    });
    // Sin CAE real (provisorio) no hay QR que imprimir.
    assert.equal(urlQrFiscal({ tipo: 'factura_b', puntoVenta: '3', numero: 42, fecha: new Date(), total: 1, cae: '' }), null);
  } finally {
    if (antes === undefined) delete process.env.ARCA_CUIT; else process.env.ARCA_CUIT = antes;
  }
});

test('fechas: siempre en hora argentina, aunque el servidor corra en UTC', () => {
  // 02:00 UTC del 28 = 23:00 del 27 en Argentina: el comprobante es del 27.
  const d = new Date('2026-09-28T02:00:00Z');
  assert.equal(fechaComprobante(d), '20260927');
  assert.equal(fechaQr(d), '2026-09-27');
  assert.match(selloWsaa(d), /^2026-09-27T23:00:00-03:00$/);
  assert.equal(parsearFechaArca('20260927')?.toISOString().slice(0, 10), '2026-09-27');
});
