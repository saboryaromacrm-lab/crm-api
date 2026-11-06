import test from 'node:test';
import assert from 'node:assert/strict';
import { armarLocales, diasDelPeriodo, turnoDeHora } from './locales';

const nombres = new Map([[1, 'Distribuidora'], [2, 'Express 1']]);
const dia = [
  { sucursal_id: 1, tickets: 10, venta_neta: 1000, dias: 2 },
  { sucursal_id: 2, tickets: 4, venta_neta: 1000, dias: 1 },
];
const anterior = [{ sucursal_id: 1, tickets: 5, venta_neta: 800, dias: 2 }];
const hora = [
  { sucursal_id: 1, dia: '2026-11-01', hora: 9, tickets: 3, venta_neta: 300 },
  { sucursal_id: 1, dia: '2026-11-01', hora: 13, tickets: 1, venta_neta: 100 },
  { sucursal_id: 1, dia: '2026-11-02', hora: 9, tickets: 2, venta_neta: 200 },
  { sucursal_id: 1, dia: '2026-11-02', hora: 18, tickets: 4, venta_neta: 400 },
  { sucursal_id: 2, dia: '2026-11-02', hora: 18, tickets: 4, venta_neta: 1000 },
];

test('el turno: mañana antes de las 14, tarde desde las 14', () => {
  assert.equal(turnoDeHora(13), 'manana');
  assert.equal(turnoDeHora(14), 'tarde');
});

test('cada local: venta, tickets, promedio, participación y contra el período anterior', () => {
  const r = armarLocales(dia, anterior, hora, nombres);
  const d = r.sucursales.find((x) => x.sucursalId === 1)!;
  assert.equal(d.nombre, 'Distribuidora');
  assert.equal(d.ticketPromedio, 100);
  assert.equal(d.participacion, 50);
  assert.equal(d.ventaPorDia, 500);
  assert.equal(d.variacionVenta, 25);
  assert.equal(d.variacionTickets, 100);
  assert.equal(d.variacionPromedio, -37.5, 'promedio 100 contra 160');
  const e = r.sucursales.find((x) => x.sucursalId === 2)!;
  assert.equal(e.variacionVenta, null, 'sin base anterior no hay variación');
});

test('por turno: total del turno y promedio POR TURNO trabajado', () => {
  const d = armarLocales(dia, anterior, hora, nombres).sucursales.find((x) => x.sucursalId === 1)!;
  assert.deepEqual(d.turnos.manana, { tickets: 6, ventaNeta: 600, ticketPromedio: 100, dias: 2, ventaPorDia: 300, ticketsPorDia: 3 });
  assert.deepEqual(d.turnos.tarde, { tickets: 4, ventaNeta: 400, ticketPromedio: 100, dias: 1, ventaPorDia: 400, ticketsPorDia: 4 });
});

test('por hora: solo las horas con venta, y el total suma los locales', () => {
  const r = armarLocales(dia, anterior, hora, nombres);
  assert.deepEqual(r.total.horas.map((h) => h.hora), [9, 13, 18]);
  const h18 = r.total.horas.find((h) => h.hora === 18)!;
  assert.equal(h18.tickets, 8);
  assert.equal(h18.ventaNeta, 1400);
  assert.equal(h18.ticketPromedio, 175);
  assert.equal(h18.turno, 'tarde');
  const e = r.sucursales.find((x) => x.sucursalId === 2)!;
  assert.equal(e.horas.find((h) => h.hora === 9)!.tickets, 0, 'la hora sin venta de ese local va en cero');
  assert.equal(r.total.ticketPromedio, r2(2000 / 14));
});

function r2(n: number) { return Math.round(n * 100) / 100; }

test('los días: un mes se completa hasta su último día; varios meses, los del período', () => {
  const nov = diasDelPeriodo('2026-11-01', '2026-11-06');
  assert.equal(nov.length, 30);
  assert.equal(nov[29], '2026-11-30');
  assert.equal(diasDelPeriodo('2026-02-01', '2026-02-10').length, 28);
  assert.equal(diasDelPeriodo('2026-10-25', '2026-11-03').length, 10);
});

test('día por día: por local y total, y los días que no llegaron marcados', () => {
  const r = armarLocales(dia, anterior, hora, nombres, {
    lista: ['2026-11-01', '2026-11-02', '2026-11-03'],
    filas: [
      { sucursal_id: 1, dia: '2026-11-01', tickets: 4, venta_neta: 400 },
      { sucursal_id: 2, dia: '2026-11-01', tickets: 1, venta_neta: 100 },
    ],
    hoy: '2026-11-02',
  });
  assert.deepEqual(r.total.dias[0], { dia: '2026-11-01', tickets: 5, ventaNeta: 500, ticketPromedio: 100, futuro: false });
  assert.equal(r.total.dias[2].futuro, true);
  assert.equal(r.sucursales.find((x) => x.sucursalId === 2)!.dias[1].tickets, 0);
});
