import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esAjusteManual } from './ajusteManual';

test('ajuste a mano: el que carga una persona, no las reservas, anulaciones, conteos ni descartes', () => {
  assert.equal(esAjusteManual({ tipo: 'ajuste', signo: 1, descripcion: 'Ajuste +8 u. · ERROR DE CONTEO' }), true);
  assert.equal(esAjusteManual({ tipo: 'ajuste', signo: -1, descripcion: 'Ajuste −2,5 kg · rotura' }), true);
  assert.equal(esAjusteManual({ tipo: 'ajuste', signo: 0, descripcion: 'PR0049: cerrado en venta' }), false);
  assert.equal(esAjusteManual({ tipo: 'ajuste', signo: -1, descripcion: 'Anulación de Factura A 0001-00000012' }), false);
  assert.equal(esAjusteManual({ tipo: 'ajuste', signo: 1, descripcion: 'Conteo: había 5, el sistema decía 3 (+2)' }), false);
  assert.equal(esAjusteManual({ tipo: 'ajuste', signo: -1, descripcion: 'Se tiró lo vencido: −3 u.' }), false);
  assert.equal(esAjusteManual({ tipo: 'merma', signo: -1, descripcion: 'Merma −1 u.' }), false);
});
