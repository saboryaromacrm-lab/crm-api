/*
 * Estado de resultados (0152, 9/10/2026): las reglas puras — tasas con
 * vigencia, sueldo devengado, amortización, reparto al centavo, Ganancias por
 * lo acumulado y la cascada.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMINISTRACION, amortizacionMes, cascada, costoEmpleadoMes, escalaDelAnio, gananciasDelAnio, hechosVacios,
  impuestoEscala, mesesEntre, parteDelMes, repartir, sumarHechos, sumarMeses, tasaVigente, type Escala, type Tasa,
} from './reglas';

const ESCALA_2026: Escala = {
  anio: 2026,
  tramos: [
    { desde: 0, fijo: 0, pct: 5 }, { desde: 2336953.69, fijo: 116847.68, pct: 9 },
    { desde: 4673907.36, fijo: 327173.52, pct: 12 }, { desde: 7010861.05, fijo: 607607.96, pct: 15 },
    { desde: 10516291.59, fijo: 1133422.54, pct: 19 }, { desde: 21032583.18, fijo: 3131517.94, pct: 23 },
    { desde: 31548874.77, fijo: 5550265.01, pct: 27 }, { desde: 47323312.16, fijo: 9809363.10, pct: 31 },
    { desde: 70984968.25, fijo: 17144476.49, pct: 35 },
  ],
  deducciones: { gni: 6019671.36, especial: 21068849.78 },
};

test('meses: de a uno y sumando', () => {
  assert.deepEqual(mesesEntre('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.equal(sumarMeses('2026-01', -1), '2025-12');
  assert.equal(sumarMeses('2026-10', -12), '2025-10');
  assert.equal(sumarMeses('2026-12', 1), '2027-01');
});

test('la tasa del mes: manda la del local y, entre iguales, la más nueva', () => {
  const t: Tasa[] = [
    { concepto: 'municipalidad', sucursalId: null, medio: null, porcentaje: 0.5, minimo: 0, desde: '2026-01' },
    { concepto: 'municipalidad', sucursalId: 6, medio: null, porcentaje: 0.8, minimo: 20000, desde: '2026-01' },
    { concepto: 'municipalidad', sucursalId: null, medio: null, porcentaje: 0.6, minimo: 0, desde: '2026-03' },
    { concepto: 'tarjeta', sucursalId: null, medio: null, porcentaje: 4, minimo: 0, desde: '2026-01' },
    { concepto: 'tarjeta', sucursalId: null, medio: 'tarjeta_credito', porcentaje: 5, minimo: 0, desde: '2026-06' },
  ];
  assert.equal(tasaVigente(t, 'municipalidad', '2026-04', { sucursalId: 6 })?.porcentaje, 0.8);
  assert.equal(tasaVigente(t, 'municipalidad', '2026-04', { sucursalId: 2 })?.porcentaje, 0.6);
  assert.equal(tasaVigente(t, 'municipalidad', '2026-02', { sucursalId: 2 })?.porcentaje, 0.5);
  assert.equal(tasaVigente(t, 'municipalidad', '2025-12', { sucursalId: 2 }), null, 'antes de la primera no hay tasa');
  assert.equal(tasaVigente(t, 'tarjeta', '2026-07', { medio: 'tarjeta_credito' })?.porcentaje, 5);
  assert.equal(tasaVigente(t, 'tarjeta', '2026-07', { medio: 'tarjeta_debito' })?.porcentaje, 4);
  assert.equal(tasaVigente(t, 'tarjeta', '2026-05', { medio: 'tarjeta_credito' })?.porcentaje, 4);
});

test('sueldo devengado: bruto + cargas + 1/12 de aguinaldo, proporcional a los días', () => {
  const e = {
    id: 1, nombre: 'ZZ', sucursalId: 6, alta: '2026-10-16', baja: null,
    sueldos: [{ desde: '2026-10', bruto: 1000000, cargas: 25 }, { desde: '2027-04', bruto: 1200000, cargas: 25 }],
  };
  assert.equal(parteDelMes(e.alta, null, '2026-10'), 16 / 31);
  const nov = costoEmpleadoMes(e, '2026-11')!;
  assert.equal(nov.total, 1354166.67); // (1.000.000 + 250.000) × 13/12
  assert.equal(nov.aguinaldo, 104166.67);
  const oct = costoEmpleadoMes(e, '2026-10')!;
  assert.ok(Math.abs(oct.total - 1354166.67 * 16 / 31) < 0.02);
  assert.equal(costoEmpleadoMes(e, '2027-05')!.total, 1625000); // 1.500.000 × 13/12
  assert.equal(costoEmpleadoMes(e, '2026-09'), null, 'antes del alta no cuesta');
  assert.equal(costoEmpleadoMes({ ...e, baja: '2026-12-31' }, '2027-01'), null, 'después de la baja tampoco');
  assert.equal(costoEmpleadoMes({ ...e, sueldos: [] }, '2026-11')!.sinSueldo, true);
});

test('amortización en línea recta, del mes de alta hasta completar la vida o la baja', () => {
  const b = { id: 1, nombre: 'Heladera', sucursalId: null, valor: 1200000, alta: '2026-01-01', vidaMeses: 24, baja: null };
  assert.equal(amortizacionMes(b, '2025-12'), 0);
  assert.equal(amortizacionMes(b, '2026-01'), 50000);
  assert.equal(amortizacionMes(b, '2027-12'), 50000);
  assert.equal(amortizacionMes(b, '2028-01'), 0);
  assert.equal(amortizacionMes({ ...b, baja: '2026-06-15' }, '2026-07'), 0);
});

test('repartir al centavo por ventas; sin ventas, a Administración', () => {
  const r = repartir(1000, new Map([[1, 1], [2, 2]]));
  assert.equal(r.get(1), 333.33);
  assert.equal(r.get(2), 666.67);
  assert.equal([...r.values()].reduce((a, v) => a + v, 0), 1000);
  const tres = repartir(100, new Map([[1, 1], [2, 1], [3, 1], [4, 0]]));
  assert.equal(Math.round([...tres.values()].reduce((a, v) => a + v, 0) * 100), 10000);
  assert.equal(tres.has(4), false);
  assert.deepEqual([...repartir(500, new Map([[1, 0]]))], [[ADMINISTRACION, 500]]);
  assert.equal(repartir(0, new Map([[1, 1]])).size, 0);
});

test('Ganancias: la escala 2026 de ARCA', () => {
  assert.equal(impuestoEscala(ESCALA_2026.tramos, 1000000), 50000);
  // 32.911.478,86: 5.550.265,01 + 27 % de (32.911.478,86 − 31.548.874,77)
  assert.equal(impuestoEscala(ESCALA_2026.tramos, 32911478.86), 5918168.11);
  assert.equal(impuestoEscala(ESCALA_2026.tramos, -5), 0);
});

test('Ganancias por lo acumulado: el año entero cierra con la escala anual', () => {
  const meses = gananciasDelAnio(ESCALA_2026, Array(12).fill(5000000));
  const total = meses.reduce((a, m) => a + m.impuesto, 0);
  // 60.000.000 − 27.088.521,14 de deducciones = 32.911.478,86 imponible
  assert.equal(meses[11].imponible, 32911478.86);
  assert.ok(Math.abs(total - 5918168.11) < 0.05);
  assert.ok(Math.abs(meses[5].impuestoAcum - 5918168.11 / 2) < 0.05, 'a mitad de año, la mitad');
  // Un mes con pérdida devuelve lo reconocido de más.
  const vuelta = gananciasDelAnio(ESCALA_2026, [10000000, -10000000]);
  assert.ok(vuelta[0].impuesto > 0);
  assert.equal(r(vuelta[0].impuesto + vuelta[1].impuesto), 0);
  // Por debajo de las deducciones no hay impuesto.
  assert.equal(gananciasDelAnio(ESCALA_2026, [2000000])[0].impuesto, 0);
});
const r = (n: number) => Math.round(n * 100) / 100;

test('la escala del año, o la última anterior', () => {
  const e25 = { ...ESCALA_2026, anio: 2025 };
  assert.equal(escalaDelAnio([ESCALA_2026, e25], 2026)?.escala.anio, 2026);
  assert.deepEqual(escalaDelAnio([ESCALA_2026, e25], 2027), { escala: ESCALA_2026, propia: false });
  assert.equal(escalaDelAnio([ESCALA_2026], 2024)?.escala.anio, 2026);
  assert.equal(escalaDelAnio([], 2026), null);
});

test('la cascada y su suma', () => {
  const h = {
    ...hechosVacios(), ventasLista: 1000, descuentos: 100, notasCredito: 50, cargos: 20,
    cmv: 500, mermas: 10, ajustesStock: -5, iibb: 25, municipalidad: 5, comisiones: 8, variables: { 9: 12 },
    sueldos: 150, fijos: { 1: 60 }, amortizaciones: 10, recargos: 7, financieros: { 30: 2 },
  };
  const c = cascada(h);
  assert.equal(c.ventasNetas, 870);
  assert.equal(c.margenBruto, 355);
  assert.equal(c.contribucion, 305);
  assert.equal(c.operativo, 85);
  assert.equal(c.antesGanancias, 90);
  const doble = sumarHechos(h, h);
  assert.equal(cascada(doble).antesGanancias, 180);
  assert.deepEqual(doble.variables, { 9: 24 });
});
