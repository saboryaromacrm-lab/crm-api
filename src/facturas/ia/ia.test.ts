/*
 * Facturas con IA (0153): la limpieza de lo que devuelve la IA, el control de
 * la cuenta, los candidatos de producto y el costo de cada llamada.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidatos, elegido } from './candidatos';
import { controlar, descuentoEquivalente, renglonCierra } from './control';
import { contenidoDe, limpiar } from './lectura';
import { costoUsd } from './precios';
import { codigoDeRenglon } from './ia.service';

const renglon = (o: Partial<any> = {}) => ({
  codigo: 'A1', descripcion: 'YERBA X 1KG', cantidad: 10, unidad: 'UN', precioUnitario: 1000, descuentos: [], importe: 10000, alicuotaIva: 21, ...o,
});
const leida = (renglones: any[], pie: Partial<any> = {}, tipo = 'factura') => ({
  encabezado: { tipo } as any,
  renglones,
  pie: { subtotal: 0, bonificacionPct: 0, bonificacionImporte: 0, ivas: [], percepciones: [], impuestosInternos: 0, otrosImpuestos: 0, total: 0, ...pie },
});

test('limpiar: tipo y letra por el código de ARCA, punto de venta, CUIT y topes', () => {
  const x = limpiar({
    esComprobante: true,
    encabezado: {
      tipo: 'factura', letra: 'B', codigoArca: 1, puntoVenta: '00012', numero: '0000-00004567', fecha: '2026-10-05', cae: '7412 3456',
      cuitEmisor: '30-71234567-9', razonSocialEmisor: '  Molino   Sur SRL ', domicilioEmisor: '', condicionIvaEmisor: 'responsable_inscripto', cuitReceptor: '20-1-2', moneda: 'ars',
    },
    renglones: [renglon({ descuentos: [10, 5, 200, -3] }), renglon({ descripcion: '', codigo: '', importe: 0 })],
    pie: { subtotal: 1, bonificacionPct: 0, bonificacionImporte: -50, ivas: [{ alicuota: 21, importe: 0 }, { alicuota: 21, importe: 210 }], percepciones: [], impuestosInternos: 0, otrosImpuestos: 0, total: 1 },
    nota: '',
  });
  assert.equal(x.encabezado.tipo, 'factura');
  assert.equal(x.encabezado.letra, 'A', 'el código 01 manda sobre la letra leída');
  assert.equal(x.encabezado.puntoVenta, '0012');
  assert.equal(x.encabezado.numero, 4567);
  assert.equal(x.encabezado.cuitEmisor, '30712345679');
  assert.equal(x.encabezado.razonSocialEmisor, 'Molino Sur SRL');
  assert.equal(x.encabezado.moneda, 'PES');
  assert.deepEqual(x.renglones[0].descuentos, [10, 5, 100], 'los % van de 0 a 100 y los ceros se van');
  assert.equal(x.renglones.length, 1, 'un renglón vacío se descarta');
  assert.equal(x.pie.bonificacionImporte, 50);
  assert.equal(x.pie.ivas.length, 1, 'un IVA en cero no se guarda');
});

test('limpiar: letra M, remito sin letra, fecha inválida, no comprobante', () => {
  const m = limpiar({ encabezado: { tipo: 'factura', letra: 'M', codigoArca: 0, fecha: '2026-02-31' }, renglones: [], pie: {} });
  assert.equal(m.encabezado.letra, 'A');
  assert.match(m.nota, /Factura M/);
  assert.equal(m.encabezado.fecha, '');
  assert.equal(limpiar({ encabezado: { tipo: 'remito', letra: '' }, renglones: [], pie: {} }).encabezado.letra, 'X');
  assert.equal(limpiar({ esComprobante: false, encabezado: { tipo: 'otro' }, renglones: [], pie: {} }).esComprobante, false);
});

test('limpiar: papel interno = liquidación (X), y la empresa nunca queda de emisor', () => {
  const liq = limpiar({ encabezado: { tipo: 'liquidacion', letra: 'A' }, renglones: [], pie: {} });
  assert.deepEqual([liq.encabezado.tipo, liq.encabezado.letra], ['liquidacion', 'X'], 'liquidación: letra X siempre');
  const interna = limpiar({ encabezado: { tipo: 'factura', letra: '', cae: '' }, renglones: [], pie: {} });
  assert.deepEqual([interna.encabezado.tipo, interna.encabezado.letra], ['liquidacion', 'X'], '«Factura interna» sin CAE ni letra');
  assert.match(interna.nota, /liquidación/);
  const sinCaeConLetra = limpiar({ encabezado: { tipo: 'factura', letra: 'A', cae: '' }, renglones: [], pie: {} });
  assert.equal(sinCaeConLetra.encabezado.tipo, 'factura', 'con letra fiscal sigue siendo factura (el CAE puede no leerse)');
  const conArca = limpiar({ encabezado: { tipo: 'factura', letra: '', codigoArca: 1, cae: '' }, renglones: [], pie: {} });
  assert.deepEqual([conArca.encabezado.tipo, conArca.encabezado.letra], ['factura', 'A'], 'el código de ARCA manda');
  const propia = limpiar({ encabezado: { tipo: 'liquidacion', cuitEmisor: '20-12345678-6', razonSocialEmisor: 'NOSOTROS' }, renglones: [], pie: {} }, '20123456786');
  assert.deepEqual([propia.encabezado.cuitEmisor, propia.encabezado.razonSocialEmisor], ['', ''], 'la empresa no es el proveedor');
  assert.equal(limpiar({ encabezado: { cuitEmisor: '30711111119' }, renglones: [], pie: {} }, '20123456786').encabezado.cuitEmisor, '30711111119');
});

test('el renglón: cantidad × precio × (1 − descuentos) = importe', () => {
  assert.equal(renglonCierra(renglon()), true);
  assert.equal(renglonCierra(renglon({ descuentos: [10, 5], importe: 8550 })), true);
  assert.equal(renglonCierra(renglon({ importe: 1000 })), false, '1 × 1000 leído como 10');
  assert.equal(renglonCierra(renglon({ precioUnitario: 0, importe: 999 })), true, 'sin precio impreso no se controla');
  assert.equal(descuentoEquivalente([10, 5]), 14.5);
});

test('la cuenta de una factura A: renglones, subtotal, IVA, percepciones y total', () => {
  const r = [renglon(), renglon({ codigo: 'B2', cantidad: 2, precioUnitario: 2500, importe: 5000 })];
  const ok = controlar(leida(r, { subtotal: 15000, bonificacionPct: 10, ivas: [{ alicuota: 21, importe: 2835 }], percepciones: [{ nombre: 'IIBB', alicuota: 3, importe: 405 }], total: 16740 }));
  assert.deepEqual(ok.problemas, []);
  assert.equal(ok.cierra, true);
  const mal = controlar(leida(r, { subtotal: 15000, ivas: [{ alicuota: 21, importe: 3150 }], total: 19000 }));
  assert.equal(mal.cierra, false);
  assert.match(mal.problemas[0], /total impreso/);
});

test('la cuenta de una B (IVA adentro), con renglón mal y contra el QR', () => {
  const b = controlar(leida([renglon({ importe: 12100, precioUnitario: 1210 })], { total: 12100 }));
  assert.equal(b.cierra, true);
  const malRenglon = controlar(leida([renglon(), renglon({ importe: 999 })], { subtotal: 10999, total: 10999 }));
  assert.deepEqual(malRenglon.renglonesMal, [1]);
  const qr = controlar(leida([renglon()], { total: 10000 }), 12100);
  assert.match(qr.problemas.join(' '), /QR/);
  assert.equal(controlar(leida([], { total: 100 })).cierra, false, 'sin renglones no cierra');
  assert.equal(controlar(leida([renglon({ precioUnitario: 0, importe: 0 })], {}, 'remito')).cierra, true, 'un remito sin precios cierra');
});

test('candidatos: del más parecido al menos; uno claro solo si no empata', () => {
  const cat = [
    { id: 1, nombre: 'Avena Instantánea Cumaná 400 g' },
    { id: 2, nombre: 'Avena Arrollada Cumaná 400 g' },
    { id: 3, nombre: 'Yerba Mate Playadito 1 kg' },
  ];
  const c = candidatos('AVENA INSTANT CUM 400G', cat);
  assert.equal(c[0].p.id, 1);
  assert.ok(!c.some((x) => x.p.id === 3), 'lo que no comparte nada, afuera');
  assert.equal(elegido(candidatos('YERBA MATE PLAYADITO 1KG', cat))?.id, 3);
  assert.equal(elegido(candidatos('CUMANA 400', cat)), null, 'empate: no se elige');
});

test('el código con que se aprende un renglón', () => {
  assert.equal(codigoDeRenglon({ codigo: 'A-17', descripcion: 'x' }), 'A-17');
  assert.equal(codigoDeRenglon({ codigo: '', descripcion: 'Aceite Girasol 1,5 L' }), 'D:ACEITEGIRASOL15L');
});

test('el contenido: PDF como documento, foto como imagen y el receptor', () => {
  const c = contenidoDe([{ mime: 'application/pdf', data: 'QQ==' }, { mime: 'image/webp', data: 'Qg==' }], { nombre: 'Sabor y Aroma', cuit: '20123' });
  assert.equal(c[0].type, 'document');
  assert.equal(c[1].type, 'image');
  assert.equal(c[1].source.media_type, 'image/webp');
  assert.match(c[2].text, /2 archivos, en orden.*CUIT 20123/);
});

test('el costo: Haiku y Sonnet a precio oficial; un modelo desconocido, al más caro', () => {
  const uso = { entrada: 5000, salida: 1800, cacheEscritura: 0, cacheLectura: 0 };
  assert.equal(costoUsd('claude-haiku-5-5', uso), 0.0014);
  assert.equal(costoUsd('claude-sonnet-5-5', uso), 0.028);
  assert.equal(costoUsd('modelo-nuevo', uso), 0.056);
});
