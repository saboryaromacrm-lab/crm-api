import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIJOS_FORMOSA, JUEVES_SANTO, feriadosDelAnio } from './reglas';

const NACIONALES = [
  { fecha: '2027-01-01', tipo: 'inamovible', nombre: 'Año nuevo' },
  { fecha: '2027-03-26', tipo: 'inamovible', nombre: 'Viernes Santo' },
  { fecha: '2027-06-21', tipo: 'trasladable', nombre: 'Paso a la Inmortalidad del General Martín Güemes' },
  { fecha: '2027-07-10', tipo: 'puente', nombre: 'Puente turístico no laborable' },
  { fecha: '2026-12-25', tipo: 'inamovible', nombre: 'Navidad' },
];

test('feriadosDelAnio: inamovible y trasladable son feriado; el puente, día no laborable', () => {
  const l = feriadosDelAnio(2027, NACIONALES);
  assert.equal(l.find((f) => f.nombre === 'Año nuevo')?.tipo, 'feriado');
  assert.equal(l.find((f) => f.nombre.startsWith('Paso a la'))?.tipo, 'feriado');
  assert.equal(l.find((f) => f.nombre.startsWith('Puente'))?.tipo, 'no_laborable');
});

test('feriadosDelAnio: solo los del año pedido', () => {
  assert.ok(!feriadosDelAnio(2027, NACIONALES).some((f) => f.fecha.startsWith('2026')));
});

test('feriadosDelAnio: Jueves Santo es el día antes del Viernes Santo (también cruzando de mes)', () => {
  assert.deepEqual(feriadosDelAnio(2027, NACIONALES).find((f) => f.nombre === JUEVES_SANTO),
    { fecha: '2027-03-25', nombre: JUEVES_SANTO, tipo: 'no_laborable', alcance: 'nacional' });
  const abril = feriadosDelAnio(2029, [{ fecha: '2029-04-01', tipo: 'inamovible', nombre: 'Viernes Santo' }]);
  assert.equal(abril.find((f) => f.nombre === JUEVES_SANTO)?.fecha, '2029-03-31');
  assert.ok(!feriadosDelAnio(2028, []).some((f) => f.nombre === JUEVES_SANTO), 'sin Viernes Santo publicado, no se inventa');
});

test('feriadosDelAnio: los de Formosa de fecha fija, provinciales, ordenados por fecha', () => {
  const l = feriadosDelAnio(2027, NACIONALES);
  for (const f of FIJOS_FORMOSA) {
    const x = l.find((y) => y.nombre === f.nombre);
    assert.equal(x?.fecha, `2027-${String(f.mes).padStart(2, '0')}-${String(f.dia).padStart(2, '0')}`);
    assert.equal(x?.alcance, 'provincial');
  }
  assert.deepEqual(l.map((f) => f.fecha), [...l.map((f) => f.fecha)].sort());
});
