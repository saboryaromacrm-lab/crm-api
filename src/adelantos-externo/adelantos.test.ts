import test from 'node:test';
import assert from 'node:assert/strict';
import { esConceptoAdelanto } from '../cashflow/conceptos';
import { armarRespuesta, detalleDeMotivo, rangoPedido, type Adelanto } from './adelantos';

test('concepto de adelanto: egreso que dice «adelanto», sin importar tildes ni mayúsculas', () => {
  assert.ok(esConceptoAdelanto({ nombre: 'Adelantos sueldos', tipo: 'egreso' }));
  assert.ok(esConceptoAdelanto({ nombre: 'ADELANTO aguinaldo', tipo: 'egreso' }));
  assert.ok(!esConceptoAdelanto({ nombre: 'Adelantos sueldos', tipo: 'ingreso' }));
  assert.ok(!esConceptoAdelanto({ nombre: 'Sueldos', tipo: 'egreso' }));
});

test('el período: sin fechas el mes en curso; mal o al revés, error', () => {
  assert.deepEqual(rangoPedido({}, '2026-11-06'), { desde: '2026-11-01', hasta: '2026-11-06' });
  assert.deepEqual(rangoPedido({ desde: '2026-10-01', hasta: '2026-10-31' }, '2026-11-06'), { desde: '2026-10-01', hasta: '2026-10-31' });
  assert.deepEqual(rangoPedido({ hasta: '2026-10-15' }, '2026-11-06'), { desde: '2026-10-01', hasta: '2026-10-15' });
  assert.ok('error' in rangoPedido({ desde: '2026-13-01' }, '2026-11-06'));
  assert.ok('error' in rangoPedido({ desde: '2026-02-30' }, '2026-11-06'));
  assert.ok('error' in rangoPedido({ desde: '2026-11-05', hasta: '2026-11-01' }, '2026-11-06'));
});

test('el detalle de la caja del local sale del texto «concepto · detalle»', () => {
  assert.equal(detalleDeMotivo('Adelantos sueldos · Juan Pérez', 'Adelantos sueldos'), 'Juan Pérez');
  assert.equal(detalleDeMotivo('Adelantos sueldos', 'Adelantos sueldos'), '');
  assert.equal(detalleDeMotivo('Adelanto · Ana · semana 2', 'Adelantos sueldos'), 'Ana · semana 2', 'concepto renombrado después');
});

const a = (p: Partial<Adelanto>): Adelanto => ({
  id: 'x', origen: 'cashflow', movimientoId: 1, fecha: '2026-11-01T12:00:00.000Z', dia: '2026-11-01', importe: 0, detalle: '',
  concepto: 'Adelantos sueldos', lugar: '', sucursalId: null, turnoCajaId: null, cargadoPor: '', anulado: false, anuladoEn: null, anuladoMotivo: null, empleado: null, ...p,
});

test('la respuesta: del más viejo al más nuevo, el total sin los anulados', () => {
  const r = armarRespuesta([
    a({ id: 'caja-2', fecha: '2026-11-03T12:00:00.000Z', importe: 50000 }),
    a({ id: 'cashflow-1', fecha: '2026-11-02T12:00:00.000Z', importe: 100000.5 }),
    a({ id: 'cashflow-9', fecha: '2026-11-04T12:00:00.000Z', importe: 70000, anulado: true }),
  ], { desde: '2026-11-01', hasta: '2026-11-06' }, [], 'ahora');
  assert.deepEqual(r.adelantos.map((x) => x.id), ['cashflow-1', 'caja-2', 'cashflow-9']);
  assert.equal(r.total, 150000.5);
  assert.equal(r.cantidad, 2);
  assert.equal(r.anulados, 1);
});
