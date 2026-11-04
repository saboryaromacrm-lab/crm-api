/*
 * Gastos fijos para el estado de resultados (0216, 3/11/2026): el estimado de
 * los meses sin gasto cargado, el reparto por % entre locales y cómo los dos
 * entran en el armado.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armarEstado, type Catalogos, type HechosLeidos } from './estado';
import { estimadoFijoMes, normalizarReparto, r2, type GastoFijo } from './reglas';

const ALQUILER: GastoFijo = {
  id: 1, nombre: 'Alquiler Express 1', rubro: 10, sucursalId: 2, reparto: null,
  importe: 500_000, frecuencia: 'mensual', desde: '2026-09', hasta: null,
};

test('estimado: solo en los meses en que corre y sin gasto cargado', () => {
  assert.equal(estimadoFijoMes(ALQUILER, '2026-08', undefined), 0); // antes de «desde»
  assert.equal(estimadoFijoMes(ALQUILER, '2026-09', undefined), 500_000);
  assert.equal(estimadoFijoMes(ALQUILER, '2026-10', new Set(['2026-10'])), 0); // ya cargado
  assert.equal(estimadoFijoMes({ ...ALQUILER, hasta: '2026-10' }, '2026-11', undefined), 0); // dado de baja
});

test('estimado: un bimestral va por mitades y el mes que cubre un gasto cargado no suma', () => {
  const seguro = { ...ALQUILER, frecuencia: 'bimestral', importe: 100_000 };
  assert.equal(estimadoFijoMes(seguro, '2026-09', undefined), 50_000);
  const cargado = new Set(['2026-09']);
  assert.equal(estimadoFijoMes(seguro, '2026-09', cargado), 0);
  assert.equal(estimadoFijoMes(seguro, '2026-10', cargado), 0); // lo cubre el de septiembre
  assert.equal(estimadoFijoMes(seguro, '2026-11', cargado), 50_000);
});

test('reparto: dos locales o más, sin repetir, más de 0 % y suma 100', () => {
  assert.deepEqual(normalizarReparto(null), { reparto: null });
  assert.deepEqual(normalizarReparto([]), { reparto: null });
  assert.deepEqual(normalizarReparto([{ sucursalId: 4, pct: 40 }, { sucursalId: 2, pct: 60 }]),
    { reparto: [{ sucursalId: 2, pct: 60 }, { sucursalId: 4, pct: 40 }] });
  assert.ok('error' in normalizarReparto([{ sucursalId: 2, pct: 100 }]));
  assert.ok('error' in normalizarReparto([{ sucursalId: 2, pct: 50 }, { sucursalId: 2, pct: 50 }]));
  assert.ok('error' in normalizarReparto([{ sucursalId: 2, pct: 0 }, { sucursalId: 4, pct: 100 }]));
  assert.ok('error' in normalizarReparto([{ sucursalId: 2, pct: 50 }, { sucursalId: 4, pct: 40 }]));
  assert.ok('error' in normalizarReparto([{ sucursalId: 2, pct: 33.33 }, { sucursalId: 4, pct: 33.33 }, { sucursalId: 5, pct: 33.33 }]));
  assert.ok(!('error' in normalizarReparto([{ sucursalId: 2, pct: 33.34 }, { sucursalId: 4, pct: 33.33 }, { sucursalId: 5, pct: 33.33 }])));
});

const vacios = (): HechosLeidos => ({ items: [], extras: [], fiscal: [], tarjetas: [], mp: [], stock: [], gastos: [], percIibb: [], retiros: [] });
const catalogos = (o: Partial<Catalogos> = {}): Catalogos => ({
  rubros: [
    { id: 10, nombre: 'Alquileres', tipo: 'fijo', resultado: 'normal', reparte: true, activa: true },
    { id: 11, nombre: 'Ingresos Brutos', tipo: 'variable', resultado: 'iibb', reparte: true, activa: true },
  ],
  empleados: [], bienes: [], tasas: [], escalas: [], config: { amortizaciones: false, gananciasBase: 'todo' },
  fijos: [], emitidos: new Map(), ...o,
});
const fijosDe = (r: ReturnType<typeof armarEstado>, balde: number) =>
  r.meses[0].baldes.find((b) => b.balde === balde)?.hechos.fijos['10'] ?? 0;

test('armado: el alquiler sin cargar entra con su estimado en su local y se avisa', () => {
  const r = armarEstado(vacios(), catalogos({ fijos: [ALQUILER] }), ['2026-10'], new Set(['2026-10']));
  assert.equal(fijosDe(r, 2), 500_000);
  assert.deepEqual(r.meses[0].info.fijosEstimados, [{ id: 1, nombre: 'Alquiler Express 1', importe: 500_000 }]);
});

test('armado: con el gasto real cargado manda el real y no se estima', () => {
  const h = { ...vacios(), gastos: [{ mes: '2026-10', suc: 2, rubro: 10, reparto: null, importe: 520_000, cantidad: 1 }] };
  const r = armarEstado(h, catalogos({ fijos: [ALQUILER], emitidos: new Map([[1, new Set(['2026-10'])]]) }), ['2026-10'], new Set(['2026-10']));
  assert.equal(fijosDe(r, 2), 520_000);
  assert.deepEqual(r.meses[0].info.fijosEstimados, []);
});

test('armado: un gasto repartido 70/30 va a cada local por su %, al centavo', () => {
  const reparto = [{ sucursalId: 2, pct: 70 }, { sucursalId: 4, pct: 30 }];
  const h = { ...vacios(), gastos: [{ mes: '2026-10', suc: null, rubro: 10, reparto, importe: 100_000.01, cantidad: 1 }] };
  const r = armarEstado(h, catalogos(), ['2026-10'], new Set(['2026-10']));
  assert.equal(fijosDe(r, 2), 70_000.01);
  assert.equal(fijosDe(r, 4), 30_000);
});

test('armado: un empleado compartido reparte su sueldo por % y un fijo de IIBB no estima', () => {
  const empleado = {
    id: 9, nombre: 'Karen', sucursalId: null, reparto: [{ sucursalId: 2, pct: 50 }, { sucursalId: 4, pct: 50 }],
    alta: '2026-01-01', baja: null, sueldos: [{ desde: '2026-01', bruto: 1_000_000, cargas: 0 }],
  };
  const iibb = { ...ALQUILER, id: 2, nombre: 'Anticipo IIBB', rubro: 11, sucursalId: null };
  const r = armarEstado(vacios(), catalogos({ empleados: [empleado], fijos: [iibb] }), ['2026-10'], new Set(['2026-10']));
  const sueldo = (b: number) => r.meses[0].baldes.find((x) => x.balde === b)?.hechos.sueldos ?? 0;
  assert.ok(sueldo(2) > 0);
  assert.ok(Math.abs(sueldo(2) - sueldo(4)) < 0.015); // el centavo impar va a uno
  assert.equal(Math.round((sueldo(2) + sueldo(4)) * 100), Math.round(r.meses[0].total.hechos.sueldos * 100));
  assert.deepEqual(r.meses[0].info.fijosEstimados, []);
});

test('armado: las diferencias de inventario son optativas (apagadas no tocan el margen y se avisan aparte)', () => {
  const h = { ...vacios(), stock: [{ mes: '2026-10', suc: 2, perdidas: 1_000, ajustes: 50_000 }] };
  const balde = (r: ReturnType<typeof armarEstado>) => r.meses[0].baldes.find((b) => b.balde === 2)!.hechos;
  const con = balde(armarEstado(h, catalogos(), ['2026-10'], new Set(['2026-10'])));
  assert.equal(con.ajustesStock, 50_000, 'sin el dato se cuentan, como antes');
  assert.equal(con.ajustesFuera, 0);
  const sin = balde(armarEstado(h, catalogos({ config: { amortizaciones: false, gananciasBase: 'todo', diferenciasInventario: false } }), ['2026-10'], new Set(['2026-10'])));
  assert.equal(sin.ajustesStock, 0);
  assert.equal(sin.ajustesFuera, 50_000);
  assert.equal(sin.mermas, 1_000, 'las mermas se cuentan igual');
});

test('armado: los sueldos se abren por empleado (la parte de cada local) y lo cobrado con tarjeta queda como base', () => {
  const karen = {
    id: 9, nombre: 'Karen', sucursalId: null, reparto: [{ sucursalId: 2, pct: 35 }, { sucursalId: 4, pct: 65 }],
    alta: '2026-01-01', baja: null, aguinaldo: false, sueldos: [{ desde: '2026-01', bruto: 1_000_000, cargas: 0 }],
  };
  const ale = { ...karen, id: 3, nombre: 'Ale', sucursalId: 2, reparto: null, sueldos: [{ desde: '2026-01', bruto: 600_000, cargas: 0 }] };
  const h = { ...vacios(), tarjetas: [{ mes: '2026-10', suc: 2, medio: 'tarjeta_debito', importe: 80_000 }] };
  const r = armarEstado(h, catalogos({ empleados: [karen, ale] }), ['2026-10'], new Set(['2026-10']));
  const b2 = r.meses[0].baldes.find((b) => b.balde === 2)!.hechos;
  assert.deepEqual(b2.sueldosPor, { e9: 350_000, e3: 600_000 });
  assert.equal(b2.sueldos, 950_000);
  assert.deepEqual(r.meses[0].total.hechos.sueldosPor, { e9: 1_000_000, e3: 600_000 });
  assert.equal(b2.cobradoTarjeta, 80_000);
});

test('armado: en el mes en curso la planilla y los fijos estimados cuentan los días que pasaron', () => {
  const emp = {
    id: 1, nombre: 'Julio', sucursalId: 2, reparto: null, aguinaldo: false,
    alta: '2026-01-01', baja: null, sueldos: [{ desde: '2026-01', bruto: 3_000_000, cargas: 0 }],
  };
  const cat = catalogos({ empleados: [emp], fijos: [ALQUILER] });
  const curso = armarEstado(vacios(), cat, ['2026-11'], new Set(['2026-11']), '', '2026-11-04');
  const h = curso.meses[0].total.hechos;
  assert.equal(h.sueldos, 400_000, '4 de 30 días');
  assert.equal(curso.meses[0].total.cascada.otrosFijos, r2(500_000 * 4 / 30));
  assert.deepEqual(curso.meses[0].enCurso, { dias: 4, de: 30 });
  const cerrado = armarEstado(vacios(), cat, ['2026-10'], new Set(['2026-10']), '', '2026-11-04');
  assert.equal(cerrado.meses[0].total.hechos.sueldos, 3_000_000, 'un mes cerrado va entero');
  assert.equal(cerrado.meses[0].enCurso, null);
});
