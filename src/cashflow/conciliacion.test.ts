import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armarConciliacion, type TurnoConc } from './conciliacion';

/** Un turno que cuadra: abre con 50.000, vende 100.000, paga 10.000 a un proveedor, cuenta justo, deja 50.000 y manda 90.000. */
const turno = (o: Partial<TurnoConc> = {}): TurnoConc => {
  const base: TurnoConc = {
    id: 1, sucursalId: 1, sucursal: 'Centro', cajero: 'Ana', apertura: null, cierre: '2026-10-10T23:00:00.000Z', cierreDia: '2026-10-10',
    fondoInicial: 50000, ventas: 100000, cobranzas: 0, ingresos: 0, pagosProveedor: 10000, devoluciones: 0, otrosEgresos: 0,
    esperado: 140000, contado: 140000, difCajero: 0, envio: 90000, fondoQueda: 50000, fondoAnterior: null,
    sobreId: 9, sobreEnviado: 90000, sobreContado: 90000, sobreDif: 0, descartado: false,
  };
  return { ...base, ...o };
};
const INICIO = '2026-10-01';

test('un turno rendido: de lo cobrado a lo contado, cada renglón', () => {
  const r = armarConciliacion([turno()], INICIO, null);
  const t = r.total;
  assert.equal(t.ventas, 100000);
  assert.equal(t.pagosProveedor, 10000);
  assert.equal(t.generado, 90000);
  assert.equal(t.fondoAbrieron - t.fondoDejaron, 0);
  assert.equal(t.debiaSobres, 90000);
  assert.equal(t.enviado, 90000);
  assert.equal(t.controlado, 90000);
  assert.equal(t.contado, 90000);
  assert.equal(t.diferencias, 0);
  assert.deepEqual(r.descuadres, []);
});

test('la cascada suma: generado − jefe ± fondo = debía; debía ± cajeros = enviado; enviado − pendientes ± control = contado', () => {
  const lista = [
    turno(),
    // Faltan 2.000 al contar: el cajero cuenta 138.000 y manda 88.000.
    turno({ id: 2, contado: 138000, difCajero: -2000, envio: 88000, sobreEnviado: 88000, sobreContado: 87000, sobreDif: -1000 }),
    // Sin rendir todavía.
    turno({ id: 3, sobreId: null, sobreEnviado: null, sobreContado: null, sobreDif: null }),
    // No corresponde.
    turno({ id: 4, descartado: true, sobreContado: 0, sobreDif: -90000 }),
    // Deja más fondo del que encontró: abre con 50.000 y deja 60.000 (manda 80.000).
    turno({ id: 5, envio: 80000, fondoQueda: 60000, sobreEnviado: 80000, sobreContado: 80000 }),
    // Lo cerró un jefe sin sobre.
    turno({ id: 6, envio: null, fondoQueda: null, contado: 139500, difCajero: -500, sobreId: null, sobreEnviado: null, sobreContado: null, sobreDif: null }),
    // Antes de arrancar el Cash Flow.
    turno({ id: 7, cierreDia: '2026-09-30', sobreId: null, sobreEnviado: null, sobreContado: null, sobreDif: null }),
  ];
  const t = armarConciliacion(lista, INICIO, null).total;
  assert.equal(t.turnos, 7);
  assert.equal(t.porJefe, 1);
  assert.equal(t.generado, 7 * 90000);
  assert.equal(t.jefeGenerado, 90000);
  assert.equal(t.jefeDif, -500);
  assert.equal(t.fondoAbrieron - t.fondoDejaron, -10000, 'el turno 5 dejó 10.000 más de fondo');
  assert.equal(t.debiaSobres, t.generado - t.jefeGenerado + t.difApertura + t.fondoAbrieron - t.fondoDejaron);
  assert.equal(t.enviado, t.debiaSobres + t.difCajeros);
  assert.equal(t.controlado, t.enviado - t.sinRendir - t.previo - t.noCorresponde);
  assert.equal(t.contado, t.controlado + t.difControl);
  assert.equal(t.sinRendir, 90000);
  assert.equal(t.sinRendirN, 1);
  assert.equal(t.previo, 90000);
  assert.equal(t.noCorresponde, 90000);
  assert.equal(t.difCajeros, -2000);
  assert.equal(t.difControl, -1000, 'el «no corresponde» no cuenta como faltante');
  assert.equal(t.diferencias, -3000);
  assert.equal(t.faltantes, -3500, 'también el jefe, que contó 500 de menos');
  assert.equal(t.sobrantes, 0);
});

test('diferencia al abrir: lo que falta entre el cierre y la apertura es faltante, no fondo', () => {
  // Anoche quedaron 50.000; hoy se abre con 49.000, se vende 100.000, se paga 10.000: debía 139.000, cuenta justo, deja 50.000 y manda 89.000.
  const r = armarConciliacion([
    turno({ fondoAnterior: 50000, fondoInicial: 49000, esperado: 139000, contado: 139000, envio: 89000, sobreEnviado: 89000, sobreContado: 89000 }),
  ], INICIO, null);
  const t = r.total;
  assert.equal(t.difApertura, -1000);
  assert.equal(t.fondoAbrieron, 50000, 'lo que encontraron según el cierre anterior');
  assert.equal(t.fondoAbrieron - t.fondoDejaron, 0, 'el fondo no se movió: lo que faltó no es fondo');
  assert.equal(t.debiaSobres, 89000);
  assert.equal(t.debiaSobres, t.generado - t.jefeGenerado + t.difApertura + t.fondoAbrieron - t.fondoDejaron);
  assert.equal(t.diferencias, -1000);
  assert.equal(t.faltantes, -1000);
  assert.equal(r.turnos[0].difApertura, -1000);
  // Sin cierre anterior que dejara un fondo contado, no hay contra qué medir.
  const sinAnterior = armarConciliacion([turno({ fondoAnterior: null, fondoInicial: 49000, esperado: 139000, contado: 139000, envio: 89000, sobreEnviado: 89000, sobreContado: 89000 })], INICIO, null);
  assert.equal(sinAnterior.total.difApertura, 0);
  assert.equal(sinAnterior.turnos[0].difApertura, null);
  assert.equal(sinAnterior.total.fondoAbrieron - sinAnterior.total.fondoDejaron, -1000, 'el fondo creció de 49.000 a 50.000');
});

test('diferencia al abrir de una caja que cerró un jefe: faltante, aparte del camino de los sobres', () => {
  const t = armarConciliacion([
    turno({ fondoAnterior: 50000, fondoInicial: 40000, esperado: 140000, contado: 140000, envio: null, fondoQueda: null, sobreId: null, sobreEnviado: null, sobreContado: null, sobreDif: null }),
  ], INICIO, null).total;
  assert.equal(t.jefeApertura, -10000);
  assert.equal(t.difApertura, 0);
  assert.equal(t.diferencias, 0, 'no toca lo que debía llegar en sobres');
  assert.equal(t.faltantes, -10000, 'pero sí es plata que faltó');
});

test('faltantes y sobrantes no se compensan entre cajas', () => {
  const t = armarConciliacion([
    turno({ contado: 90000, difCajero: -50000, envio: 40000, sobreEnviado: 40000, sobreContado: 40000 }),
    turno({ id: 2, contado: 190000, difCajero: 50000, envio: 140000, sobreEnviado: 140000, sobreContado: 140500, sobreDif: 500 }),
  ], INICIO, null).total;
  assert.equal(t.diferencias, 500);
  assert.equal(t.faltantes, -50000);
  assert.equal(t.sobrantes, 50500);
});

test('por local: cada uno con sus turnos, y los locales suman el total', () => {
  const r = armarConciliacion([
    turno(), turno({ id: 2, sucursalId: 2, sucursal: 'Alberdi', contado: 139000, difCajero: -1000, envio: 89000, sobreEnviado: 89000, sobreContado: 89000 }),
  ], INICIO, null);
  assert.deepEqual(r.porSucursal.map((x) => x.sucursal), ['Alberdi', 'Centro']);
  assert.equal(r.porSucursal[0].difCajeros, -1000);
  assert.equal(r.porSucursal.reduce((a, x) => a + x.contado, 0), r.total.contado);
});

test('los centavos no se pierden al sumar muchos turnos', () => {
  const lista = Array.from({ length: 300 }, (_, i) => turno({ id: i + 1, ventas: 0.1, pagosProveedor: 0, esperado: 50000.1, contado: 50000.1, envio: 0.1, fondoQueda: 50000, sobreEnviado: 0.1, sobreContado: 0.1 }));
  const t = armarConciliacion(lista, INICIO, null).total;
  assert.equal(t.ventas, 30);
  assert.equal(t.contado, 30);
});

test('un turno que no cuadra consigo mismo se nombra, no se tapa', () => {
  const r = armarConciliacion([turno({ id: 8, esperado: 141000, difCajero: -1000 })], INICIO, null);
  assert.equal(r.total.sinDetalle, 1000);
  assert.equal(r.descuadres.length, 1);
  assert.equal(r.descuadres[0].id, 8);
  assert.match(r.descuadres[0].motivos[0], /esperado guardado/);
  const r2 = armarConciliacion([turno({ id: 9, sobreEnviado: 80000 })], INICIO, null);
  assert.match(r2.descuadres[0].motivos.join(' '), /sobre controlado/);
});

test('el puente con Métricas: por día de venta → efectivo de ventas de los turnos', () => {
  const ventasMes = { metricas: 130000, otrosTurnos: 20000, sinCaja: 5000, esperandoCae: 7000, deOtroMes: 2000 };
  const r = armarConciliacion([turno()], INICIO, ventasMes);
  assert.equal(r.desdeMetricas!.resultado, 100000);
  assert.equal(r.desdeMetricas!.cuadra, true);
  const mal = armarConciliacion([turno()], INICIO, { ...ventasMes, sinCaja: 4000 });
  assert.equal(mal.desdeMetricas!.cuadra, false);
});

test('sin turnos: todo en cero, sin errores', () => {
  const r = armarConciliacion([], INICIO, null);
  assert.equal(r.total.turnos, 0);
  assert.equal(r.total.contado, 0);
  assert.deepEqual(r.porSucursal, []);
});
