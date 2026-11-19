import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bloqueosEdicion, textoForma, type InfoEdicion } from './editar-pago';

const base: InfoEdicion = {
  estado: 'activo', medio: 'transferencia', cuentaDisponible: false, desdeCashflow: false,
  conEcheq: false, cierraCompromisoManual: false, cajaMovimientoId: null, turnoAbierto: null,
};

test('un pago común se modifica entero', () => {
  assert.deepEqual(bloqueosEdicion(base), { plata: null, fecha: null });
  // Salió de un turno que sigue abierto: el egreso se ajusta junto.
  assert.deepEqual(bloqueosEdicion({ ...base, medio: 'efectivo', cajaMovimientoId: 9, turnoAbierto: true }), { plata: null, fecha: null });
});

test('lo que no se toca, y por qué', () => {
  assert.match(bloqueosEdicion({ ...base, estado: 'anulado' }).plata!, /anulado/);
  const cf = bloqueosEdicion({ ...base, desdeCashflow: true });
  assert.match(cf.plata!, /Cash Flow/); assert.match(cf.fecha!, /Cash Flow/);
  const cd = bloqueosEdicion({ ...base, cuentaDisponible: true });
  assert.match(cd.plata!, /cuenta disponible/); assert.ok(cd.fecha);
  assert.ok(bloqueosEdicion({ ...base, medio: 'pago_coffit' }).fecha);
  // Echeq, compromiso manual y turno cerrado: la plata no, la fecha sí.
  assert.deepEqual(bloqueosEdicion({ ...base, conEcheq: true }).fecha, null);
  assert.ok(bloqueosEdicion({ ...base, conEcheq: true }).plata);
  assert.ok(bloqueosEdicion({ ...base, cierraCompromisoManual: true }).plata);
  const cerrado = bloqueosEdicion({ ...base, medio: 'efectivo', cajaMovimientoId: 9, turnoAbierto: false });
  assert.match(cerrado.plata!, /turno de caja ya cerrado/); assert.equal(cerrado.fecha, null);
});

test('cómo se pagó, en una línea para la auditoría', () => {
  assert.equal(textoForma({ medio: 'transferencia', cuenta: 'Galicia' }), 'Transferencia desde Galicia');
  assert.equal(textoForma({ medio: 'transferencia', cambioPor: 'Juan' }), 'Efectivo por transferencia (Juan)');
  assert.equal(
    textoForma({ medio: 'efectivo', formas: [{ medio: 'efectivo', importe: 100 }, { medio: 'transferencia', importe: 50.5, cuenta: 'MP' }] }),
    'Efectivo $ 100,00 + Transferencia desde MP $ 50,50',
  );
});
