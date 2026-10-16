/*
 * COFFIT PAGA PRECIO FINAL (0176): la parte de Coffit de una factura, el costo
 * sin factura y el corte de lo firmado sin IVA.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costoCafe, finalCafeteria, finalDelFormato, segunCorte } from './cuenta';

const pie = (items: Array<{ subtotal: number; iva: number; cafe?: boolean }>, ivaTotal: number, percepcionesTotal = 0) => ({
  items, ivaTotal, percepcionesTotal, subtotalNeto: items.reduce((a, it) => a + it.subtotal, 0),
});
const deCafe = (it: any) => !!it.cafe;

test('factura A mixta: su neto + su parte del IVA + su parte de las percepciones', () => {
  // 1.000 de Coffit al 21 % y 1.000 de la empresa al 10,5 %: IVA 315, percepciones 40.
  const p = pie([{ subtotal: 1000, iva: 21, cafe: true }, { subtotal: 1000, iva: 10.5 }], 315, 40);
  assert.equal(finalCafeteria(p, deCafe), 1230);
});

test('factura entera de Coffit: da el total del papel al centavo', () => {
  const p = pie([{ subtotal: 333.33, iva: 21, cafe: true }, { subtotal: 100, iva: 10.5, cafe: true }], 80.5, 8.67);
  assert.equal(finalCafeteria(p, deCafe), 522.5); // 333,33 + 100 + 80,50 + 8,67
});

test('B, C, liquidación o remito: sin IVA discriminado el precio ya es el final', () => {
  assert.equal(finalCafeteria(pie([{ subtotal: 1210, iva: 0, cafe: true }], 0), deCafe), 1210);
  assert.equal(finalCafeteria(pie([{ subtotal: 500, iva: 21 }], 105), deCafe), 0, 'sin renglones de Coffit no paga nada');
});

test('sin factura: la parte facturada con IVA y la parte sin factura tal cual', () => {
  assert.ok(Math.abs(finalDelFormato(100, 21, 0) - 121) < 1e-9);
  assert.ok(Math.abs(finalDelFormato(100, 21, 50) - 110.5) < 1e-9);
  assert.equal(finalDelFormato(100, 21, 100), 100);
  assert.equal(finalDelFormato(100, 21, 0, true), 100, 'lo que elabora Coffit va al costo que declaró');
});

test('costoCafe: manda la última factura; sin ella, el formato', () => {
  const ultima = new Map([[1, { neto: 100, final: 123 }]]);
  assert.deepEqual(costoCafe({ id: 1, iva: 21 }, null, ultima), { neto: 100, final: 123 });
  const sinFactura = costoCafe({ id: 2, iva: 21 }, { cantidad: 1, costo: 200, modoCosto: 'lista', porcSinFactura: 0 }, ultima);
  assert.ok(Math.abs(sinFactura.neto - 200) < 1e-9 && Math.abs(sinFactura.final - 242) < 1e-9);
});

test('lo firmado sin IVA (hasta el corte) se sigue contando igual', () => {
  const corte = new Date('2026-08-10T23:59:59.999-03:00');
  assert.equal(segunCorte(corte, new Date('2026-08-10T12:00:00-03:00'), 1000, 1210), 1000);
  assert.equal(segunCorte(corte, new Date('2026-08-11T00:00:00-03:00'), 1000, 1210), 1210);
  assert.equal(segunCorte(null, new Date('2026-08-01T00:00:00-03:00'), 1000, 1210), 1210, 'sin cierres: todo a precio final');
});
