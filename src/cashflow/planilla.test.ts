import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estadoTurno } from './planilla';

const t = (o: Partial<Parameters<typeof estadoTurno>[0]>) => ({ estado: 'cerrada', envio: 50000, sobreId: null, descartado: false, cierreDia: '2026-10-19', ...o });

test('estadoTurno: abierta manda sobre todo lo demás', () => {
  assert.equal(estadoTurno(t({ estado: 'abierta', envio: 0, cierreDia: null }), '2026-10-01'), 'abierta');
});

test('estadoTurno: cerró y mandó sobre sin control → sin rendir; con control → rendida', () => {
  assert.equal(estadoTurno(t({}), '2026-10-01'), 'sin_rendir');
  assert.equal(estadoTurno(t({ sobreId: 7 }), '2026-10-01'), 'rendida');
  assert.equal(estadoTurno(t({ sobreId: 7, descartado: true }), '2026-10-01'), 'no_corresponde');
});

test('estadoTurno: sin efectivo mandado no hay sobre que esperar', () => {
  assert.equal(estadoTurno(t({ envio: 0 }), '2026-10-01'), 'sin_sobre');
});

test('estadoTurno: antes del arranque del Cash Flow (o sin arrancar) no se rinde acá', () => {
  assert.equal(estadoTurno(t({ cierreDia: '2026-09-30' }), '2026-10-01'), 'previo');
  assert.equal(estadoTurno(t({}), null), 'previo');
  assert.equal(estadoTurno(t({ cierreDia: '2026-10-01' }), '2026-10-01'), 'sin_rendir', 'el mismo día del arranque ya cuenta');
});
