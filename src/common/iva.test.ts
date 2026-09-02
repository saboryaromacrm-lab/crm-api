import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALICUOTAS_IVA, esAlicuotaValida } from './iva';

test('esAlicuotaValida: solo las alícuotas de la ley', () => {
  for (const a of ALICUOTAS_IVA) assert.equal(esAlicuotaValida(a), true, `${a}%`);
  assert.equal(esAlicuotaValida('21'), true, 'acepta el número como texto');
  assert.equal(esAlicuotaValida(300), false, 'el caso que inflaba el libro de IVA');
  assert.equal(esAlicuotaValida(20), false);
  assert.equal(esAlicuotaValida(-21), false);
  assert.equal(esAlicuotaValida(undefined), false);
  assert.equal(esAlicuotaValida('abc'), false);
  // Ojo: `Number(null)` es 0 y 0% ES una alícuota (exento). Quien valide un
  // campo opcional tiene que chequear presencia antes de llamar a esto.
  assert.equal(esAlicuotaValida(null), true);
});
