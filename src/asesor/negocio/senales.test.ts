/*
 * Asesor (0193): las señales que el sistema detecta solo sobre la foto.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectar } from './senales';
import { mismosDiasMesAnterior } from '../datos';

const AHORA = new Date('2026-10-21T15:00:00-03:00');
const base = () => ({
  contexto: { hoy: '2026-10-21', metricasAl: '2026-10-21T17:50:00Z' },
  ventasDelMes: {
    ventaNeta: 1_000_000, diasConVenta: 20, ticketPromedio: 5000, variacionVentaPct: 2, variacionTicketPromedioPct: 1,
    antes: { ventaNeta: 980_000, ticketPromedio: 4950 }, porSucursal: [],
  },
  rentabilidad: { porSucursalDelMes: { totales: { ventaNeta: 1_000_000, margenPct: 30, margenPctAntes: 30.5, ventaSinCosto: 0 } } },
});
const titulos = (f: any) => detectar(f, AHORA).map((x) => `${x.nivel}|${x.titulo}`);

test('un mes normal no levanta nada', () => {
  assert.deepEqual(titulos(base()), []);
});

test('métricas viejas o sin sincronizar avisan como dato', () => {
  const f: any = base(); f.contexto.metricasAl = '2026-10-21T10:00:00Z';
  assert.ok(titulos(f).some((t) => t.startsWith('dato|Los números de ventas no están al día')));
  f.contexto.metricasAl = null;
  assert.ok(titulos(f).some((t) => t.startsWith('dato|Los números')));
});

test('ventas que caen: urgente desde −20 %, mirar desde −10 %; con pocos días no se juzga', () => {
  const f: any = base(); f.ventasDelMes.variacionVentaPct = -25;
  assert.ok(titulos(f).includes('urgente|Las ventas del mes caen 25 %'));
  f.ventasDelMes.variacionVentaPct = -12;
  assert.ok(titulos(f).includes('mirar|Las ventas del mes bajan 12 %'));
  f.ventasDelMes.diasConVenta = 2;
  assert.ok(!titulos(f).some((t) => t.includes('ventas del mes')));
});

test('una sucursal chica que cae no molesta; una con peso, sí', () => {
  const f: any = base();
  f.ventasDelMes.porSucursal = [
    { sucursal: 'Express 1', participacionPct: 3, variacionVentaPct: -40, ventaNeta: 30000 },
    { sucursal: 'Fontana', participacionPct: 30, variacionVentaPct: -22, ventaNeta: 300000 },
  ];
  const t = titulos(f);
  assert.ok(t.includes('mirar|Fontana: ventas -22 %'));
  assert.ok(!t.some((x) => x.includes('Express 1')));
});

test('el margen que cae en puntos: 3 urgente, 1,5 mirar', () => {
  const f: any = base(); f.rentabilidad.porSucursalDelMes.totales.margenPct = 26.5;
  assert.ok(titulos(f).includes('urgente|El margen del mes cae 4 puntos'));
  f.rentabilidad.porSucursalDelMes.totales.margenPct = 28.6;
  assert.ok(titulos(f).includes('mirar|El margen del mes baja 1.9 puntos'));
});

test('productos a pérdida, precio fijo sin trasladar y paquetes: con sus nombres', () => {
  const f: any = base();
  f.rentabilidad.productosVendidosAPerdida30Dias = { filas: [{ nombre: 'Anís', margen: -1200 }, { nombre: 'Comino', margen: -300 }] };
  f.costosQueSubieron30Dias = { sinTrasladar: [{ producto: 'Yerba X' }] };
  f.paquetesDeGranel30Dias = {
    aFraccionar: [{ producto: 'Almendras' }], sinGranelParaFraccionar: [{ producto: 'Nuez' }],
    precioPorKgIncoherente: [{ producto: 'Pasas' }], sobrefraccionado: [{ producto: 'Maní', kgEnPaquetes: 12.4 }],
  };
  const s = detectar(f, AHORA);
  const de = (t: string) => s.find((x) => x.titulo.startsWith(t));
  assert.equal(de('2 producto(s) se vendieron a pérdida')?.nivel, 'urgente');
  assert.match(de('2 producto(s) se vendieron a pérdida')!.detalle, /Anís, Comino: entre todos, \$-1\.500/);
  assert.equal(de('1 producto(s) con precio fijo')?.nivel, 'urgente');
  assert.equal(de('1 paquete(s) se terminan y no hay granel')?.nivel, 'mirar');
  assert.equal(de('1 paquete(s) para fraccionar')?.nivel, 'dato');
  assert.equal(de('12 kg en paquetes que no rotan')?.nivel, 'mirar');
  /* Primero lo urgente, al final los datos. */
  assert.deepEqual([...new Set(s.map((x) => x.nivel))], ['urgente', 'mirar', 'dato']);
});

test('caja: un cajero con 3 faltantes o mucha plata faltante; «Otro egreso» muy usado', () => {
  const f: any = base();
  f.caja30Dias = {
    porCajero: [
      { nombre: 'Ana', turnos: 10, faltantes: 3, sumaFaltantes: -4000, neto: -3000 },
      { nombre: 'Juan', turnos: 10, faltantes: 1, sumaFaltantes: -25000, neto: -25000 },
      { nombre: 'Leo', turnos: 10, faltantes: 1, sumaFaltantes: -500, neto: 200 },
    ],
    egresosPorConcepto: [{ que: 'Otro egreso', pct: 35 }],
  };
  const t = titulos(f);
  assert.ok(t.some((x) => x.startsWith('mirar|Ana:')));
  assert.ok(t.some((x) => x.startsWith('mirar|Juan:')));
  assert.ok(!t.some((x) => x.includes('Leo')));
  assert.ok(t.some((x) => x.startsWith('dato|«Otro egreso»')));
});

test('resultados: mes pasado en rojo y proyección bajo el equilibrio', () => {
  const f: any = base();
  f.resultados = { meses: [
    { mes: '2026-09', enCurso: false, resultadoOperativo: -50000 },
    { mes: '2026-10', enCurso: true, ventasNetas: 1_000_000, puntoDeEquilibrio: 2_000_000, objetivoVenta: 3_000_000 },
  ] };
  const t = titulos(f);
  assert.ok(t.includes('urgente|2026-09 cerró con resultado operativo negativo'));
  assert.ok(t.includes('mirar|Al ritmo de hoy, el mes no llega al punto de equilibrio'));
  assert.ok(t.includes('mirar|Al ritmo de hoy, el mes queda lejos del objetivo'));
});

test('una parte de la foto con error no rompe nada', () => {
  const f: any = base(); f.paquetesDeGranel30Dias = { error: 'se cortó' }; f.caja30Dias = { error: 'x' };
  assert.deepEqual(titulos(f), []);
});

test('mismos días del mes anterior, recortado a fin de mes', () => {
  assert.deepEqual(mismosDiasMesAnterior({ desde: '2026-10-01', hasta: '2026-10-21', sucursalId: null }), { desde: '2026-09-01', hasta: '2026-09-21', sucursalId: null });
  assert.deepEqual(mismosDiasMesAnterior({ desde: '2026-03-01', hasta: '2026-03-31', sucursalId: 2 }), { desde: '2026-02-01', hasta: '2026-02-28', sucursalId: 2 });
  assert.deepEqual(mismosDiasMesAnterior({ desde: '2026-01-01', hasta: '2026-01-15', sucursalId: null }), { desde: '2025-12-01', hasta: '2025-12-15', sucursalId: null });
});
