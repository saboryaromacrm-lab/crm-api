import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agendaEnvios, cuandoDe, excepcionesDe, tramosDe } from './horario-envio';

/** Lunes a sábado de 8 a 13 y de 17 a 21; domingo cerrado. */
const SEMANA = { lun: '08:00-13:00, 17:00-21:00', mar: '08:00-13:00, 17:00-21:00', mie: '08:00-13:00, 17:00-21:00', jue: '08:00-13:00, 17:00-21:00', vie: '08:00-13:00, 17:00-21:00', sab: '08:00-13:00, 17:00-21:00', dom: '' };
const SIN = new Map<string, string | null>();
/** Un instante en hora argentina. */
const ar = (s: string) => new Date(`${s}:00-03:00`);
const hora = (iso: string) => new Date(iso).toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

test('tramosDe: minutos del día, y lo que no es un horario no cuenta', () => {
  assert.deepEqual(tramosDe('08:00-13:00, 17:00-21:00'), [[480, 780], [1020, 1260]]);
  assert.deepEqual(tramosDe(''), []);
  assert.deepEqual(tramosDe('cualquier cosa'), []);
});

test('abierto: «lo antes posible» es de 20 a 40 minutos, y las franjas de hoy arrancan después', () => {
  const a = agendaEnvios(SEMANA, SIN, ar('2026-10-23T10:05')); // viernes
  assert.equal(a.conHorario, true);
  assert.equal(hora(a.pronto!.desde), '10:25');
  assert.equal(hora(a.pronto!.hasta), '10:45');
  assert.equal(a.dias[0].fecha, '2026-10-23');
  assert.equal(hora(a.dias[0].franjas[0].desde), '11:00');
  assert.equal(hora(a.dias[0].franjas.at(-1)!.hasta), '21:00');
  /* 11:00 a 13:00 son 6 franjas; 17:00 a 21:00, 12. */
  assert.equal(a.dias[0].franjas.length, 18);
});

test('por cerrar o cerrado: sin «lo antes posible»', () => {
  assert.equal(agendaEnvios(SEMANA, SIN, ar('2026-10-23T12:30')).pronto, null);
  assert.equal(agendaEnvios(SEMANA, SIN, ar('2026-10-23T14:00')).pronto, null);
  assert.ok(agendaEnvios(SEMANA, SIN, ar('2026-10-23T12:20')).pronto);
});

test('abierto, por cerrar y cerrado: a qué hora cierra y cuándo vuelve a abrir', () => {
  const abierto = agendaEnvios(SEMANA, SIN, ar('2026-10-23T12:20')); // viernes, cierra 13:00
  assert.equal(abierto.abierto, true);
  assert.equal(hora(abierto.cierra!), '13:00');
  assert.equal(abierto.abre, null);
  const siesta = agendaEnvios(SEMANA, SIN, ar('2026-10-23T14:00'));
  assert.equal(siesta.abierto, false);
  assert.equal(siesta.abre, new Date('2026-10-23T17:00:00-03:00').toISOString());
  const sabadoNoche = agendaEnvios(SEMANA, SIN, ar('2026-10-24T21:30'));
  assert.equal(sabadoNoche.abre, new Date('2026-10-26T08:00:00-03:00').toISOString(), 'el domingo está cerrado: abre el lunes');
  const madrugada = agendaEnvios(SEMANA, SIN, ar('2026-10-23T06:00'));
  assert.equal(madrugada.abre, new Date('2026-10-23T08:00:00-03:00').toISOString());
  assert.equal(agendaEnvios(SEMANA, SIN, ar('2026-10-23T13:00')).abierto, false, 'a la hora de cierre ya está cerrado');
});

test('un feriado cerrado hoy: cerrado aunque sea horario de semana, abre el próximo día', () => {
  const a = agendaEnvios(SEMANA, excepcionesDe([{ fecha: '2026-10-23', abre: false, horario: '' }]), ar('2026-10-23T10:00'));
  assert.equal(a.abierto, false);
  assert.equal(a.abre, new Date('2026-10-24T08:00:00-03:00').toISOString());
});

test('tres días con horario, salteando el domingo cerrado; de noche hoy ya no tiene franjas', () => {
  const a = agendaEnvios(SEMANA, SIN, ar('2026-10-24T20:50')); // sábado
  assert.deepEqual(a.dias.map((d) => d.fecha), ['2026-10-26', '2026-10-27', '2026-10-28']);
  assert.equal(hora(a.dias[0].franjas[0].desde), '08:00');
});

test('un feriado cerrado saca el día; abierto con otro horario, lo cambia', () => {
  const ex = excepcionesDe([
    { fecha: '2026-10-26', abre: false, horario: '' },
    { fecha: '2026-10-27', abre: true, horario: '9 a 12' },
    { fecha: '2026-10-28', abre: true, horario: '' },
  ]);
  const a = agendaEnvios(SEMANA, ex, ar('2026-10-25T10:00')); // domingo
  assert.deepEqual(a.dias.map((d) => d.fecha), ['2026-10-27', '2026-10-28', '2026-10-29']);
  assert.equal(a.dias[0].franjas.length, 9);
  assert.equal(a.dias[1].franjas.length, 27);
});

test('sin horario cargado: «lo antes posible» y nada más', () => {
  const a = agendaEnvios({}, SIN, ar('2026-10-23T03:00'));
  assert.equal(a.conHorario, false);
  assert.equal(a.abierto, null, 'sin horario no se sabe: no hay aviso de cerrado');
  assert.ok(a.pronto);
  assert.deepEqual(a.dias, []);
});

test('cuandoDe: valida contra la agenda de ahora', () => {
  const a = agendaEnvios(SEMANA, SIN, ar('2026-10-23T10:05'));
  assert.deepEqual(cuandoDe({ tipo: 'whatsapp' }, a), { cuando: { tipo: 'whatsapp' } });
  assert.equal('cuando' in cuandoDe({ tipo: 'pronto' }, a), true);
  const f = a.dias[1].franjas[2];
  assert.deepEqual(cuandoDe({ tipo: 'horario', desde: f.desde }, a), { cuando: { tipo: 'horario', ...f } });
  assert.equal('error' in cuandoDe({ tipo: 'horario', desde: '2026-10-23T10:10:00-03:00' }, a), true);
  assert.equal('error' in cuandoDe({ tipo: 'pronto' }, agendaEnvios(SEMANA, SIN, ar('2026-10-23T14:00'))), true);
  assert.equal('error' in cuandoDe({}, a), true);
});
