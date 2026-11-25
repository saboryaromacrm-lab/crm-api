import test from 'node:test';
import assert from 'node:assert/strict';
import { planDirecto, referenciaDirecta, referenciaOriginal } from './transferencia-directa';

test('la referencia dice a quién fue y al deshacer vuelve la de antes', () => {
  assert.equal(referenciaDirecta('ALDANA', ''), 'ALDANA · directo');
  assert.equal(referenciaDirecta('ALDANA', ' op 123 '), 'ALDANA · directo · op 123');
  assert.equal(referenciaOriginal('ALDANA', 'ALDANA · directo · op 123'), 'op 123');
  assert.equal(referenciaOriginal('ALDANA', 'ALDANA · directo'), '');
  /* El proveedor cambió de nombre: no se adivina, queda como está. */
  assert.equal(referenciaOriginal('ALDANA SRL', 'ALDANA · directo · op 123'), 'ALDANA · directo · op 123');
});

test('sin documentos queda a cuenta, en la bandeja del proveedor', () => {
  assert.deepEqual(planDirecto(1000, [], false), { destino: 'mercaderia' });
  assert.deepEqual(planDirecto(1000, [], true), { destino: 'gastos' });
});

test('con documentos: el destino sale de ellos y no se pasa de lo transferido', () => {
  assert.deepEqual(planDirecto(1000, [{ comprobanteId: 1, importe: 600 }, { comprobanteId: 2, importe: 400 }], true), { destino: 'mercaderia' });
  assert.deepEqual(planDirecto(1000, [{ gastoId: 5, importe: 300 }], false), { destino: 'gastos' });
  assert.match((planDirecto(1000, [{ comprobanteId: 1, importe: 1000.5 }], false) as any).error, /transferencia es de \$1000\.00/);
});

test('lo que no se acepta', () => {
  assert.ok('error' in planDirecto(1000, [{ comprobanteId: 1, gastoId: 2, importe: 10 }], false));
  assert.ok('error' in planDirecto(1000, [{ importe: 10 }], false));
  assert.ok('error' in planDirecto(1000, [{ comprobanteId: 1, importe: 0 }], false));
  assert.ok('error' in planDirecto(1000, [{ comprobanteId: 1, importe: 10 }, { comprobanteId: 1, importe: 10 }], false));
  assert.match((planDirecto(1000, [{ comprobanteId: 1, importe: 10 }, { gastoId: 2, importe: 10 }], false) as any).error, /no a los dos/);
});
