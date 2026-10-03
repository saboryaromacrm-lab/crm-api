/*
 * Resultados IVA (3/10/2026): la posición mes a mes con el saldo a favor arrastrado,
 * y la regla de qué impuesto es cada percepción.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrastrar } from './iva';
import { tipoPercepcion } from '../common/iva';

test('a pagar o saldo a favor, mes a mes', () => {
  const m = arrastrar([
    { mes: '2026-07', debito: 100000, credito: 60000, percepciones: 5000 },   // a pagar 35.000
    { mes: '2026-08', debito: 50000, credito: 80000, percepciones: 2000 },    // a favor 32.000
    { mes: '2026-09', debito: 90000, credito: 40000, percepciones: 0 },       // 50.000 − 32.000 = a pagar 18.000
    { mes: '2026-10', debito: 10000, credito: 10000, percepciones: 1000 },    // a favor 1.000
  ], 0);
  assert.deepEqual(m.map((x) => [x.saldoAnterior, x.aPagar, x.saldoAFavor]), [[0, 35000, 0], [0, 0, 32000], [32000, 18000, 0], [0, 0, 1000]]);
});

test('arranca con el saldo inicial de la contadora', () => {
  const m = arrastrar([{ mes: '2026-09', debito: 100000, credito: 30000, percepciones: 0 }], 80000);
  assert.deepEqual([m[0].saldoAnterior, m[0].aPagar, m[0].saldoAFavor], [80000, 0, 10000]);
  assert.equal(arrastrar([{ mes: '2026-09', debito: 1, credito: 0, percepciones: 0 }], -500)[0].saldoAnterior, 0, 'un saldo negativo no existe: arranca en 0');
});

test('de qué impuesto es cada percepción', () => {
  assert.equal(tipoPercepcion('', 'Perc. IVA RG 5329'), 'iva');
  assert.equal(tipoPercepcion('', 'Percepción RG 3337'), 'iva');
  assert.equal(tipoPercepcion('', 'Perc. IIBB Formosa'), 'iibb');
  assert.equal(tipoPercepcion('', 'Ingresos Brutos CABA'), 'iibb');
  assert.equal(tipoPercepcion('', 'Perc. DGR'), 'iibb');
  assert.equal(tipoPercepcion('', 'Privado'), 'otro', '«privado» no es IVA aunque contenga «iva»');
  assert.equal(tipoPercepcion('', 'Impuesto municipal'), 'otro');
  assert.equal(tipoPercepcion('iibb', 'Perc. IVA'), 'iibb', 'la marcada manda');
});
