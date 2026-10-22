/*
 * Asesor comercial (0193): el calendario de fechas comerciales y la simulación de promociones.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fechasComerciales, nesimo, pascua, proximasFechas, ultimo } from './calendario';
import { simular } from './simular';
import { detectar } from './senales';
import type { Articulo } from '../../vencimientos/reglas';
import { diaValido } from '../datos';

test('fechas que se corren: tercer domingo, cuarto jueves, Pascua', () => {
  assert.equal(nesimo(2026, 10, 0, 3), '2026-10-18'); // Día de la Madre 2026
  assert.equal(nesimo(2025, 10, 0, 3), '2025-10-19');
  assert.equal(nesimo(2026, 6, 0, 3), '2026-06-21'); // Día del Padre 2026
  assert.equal(nesimo(2026, 8, 0, 3), '2026-08-16'); // Día de las Infancias 2026
  assert.equal(pascua(2026), '2026-04-05');
  assert.equal(pascua(2025), '2025-04-20');
  assert.equal(pascua(2027), '2027-03-28');
  assert.equal(ultimo(2026, 10, 6), '2026-10-31');
  const f = fechasComerciales(2026);
  assert.equal(f.find((x) => x.nombre === 'Black Friday')?.fecha, '2026-11-27');
  assert.equal(f.find((x) => x.nombre === 'Hot Sale')?.aprox, true);
  assert.equal(f.find((x) => x.nombre === 'Día de la Madre')?.aprox, false);
});

test('un día que no existe no es válido (JavaScript correría el 30/2 al 2/3)', () => {
  assert.equal(diaValido('2026-02-28'), true);
  assert.equal(diaValido('2028-02-29'), true);
  for (const d of ['2026-02-30', '2026-02-29', '2026-04-31', '2026-13-01', '26-10-21', '', null]) assert.equal(diaValido(d), false, String(d));
});

test('las próximas fechas cruzan el año y dicen cuántos días faltan', () => {
  const p = proximasFechas('2026-12-20', 60);
  assert.deepEqual(p.map((x) => x.nombre), ['Nochebuena y Navidad', 'Fin de año', 'San Valentín']);
  assert.equal(p[0].faltan, 4);
  assert.equal(p[2].fecha, '2027-02-14');
});

const art = (precio: number, costo: number, iva = 21): Articulo => ({ iva, redondeo: 0, costoReal: costo, listaBaseId: 49, listas: [{ listaId: 49, nombre: 'minorista', precio }] });
const ARTS = new Map([['1-0', art(1210, 600)], ['2-0', art(2420, 1500)], ['3-5', art(605, 400)]]);
const base = { porcentaje: 0, precioFinal: 0, lleva: 0, paga: 0, montoMinimo: 0 };

test('porcentaje y precio fijo: precio, descuento y margen neto por unidad', () => {
  const r: any = simular({ ...base, tipo: 'porcentaje', porcentaje: 20, productos: [{ productoId: 1, presentacionId: 0, cantidad: 1 }] }, ARTS);
  assert.equal(r.productos[0].precioPromoPorUnidad, 968);
  assert.equal(r.productos[0].descuentoPct, 20);
  assert.equal(r.productos[0].margenAntesPorUnidad, 400); // 1210/1,21 − 600
  assert.equal(r.productos[0].margenPromoPorUnidad, 200); // 968/1,21 − 600
  const f: any = simular({ ...base, tipo: 'precio_fijo', precioFinal: 605, productos: [{ productoId: 1, presentacionId: 0, cantidad: 1 }] }, ARTS);
  assert.equal(f.productos[0].bajoCosto, true);
  assert.match(f.avisos.join(' '), /DEBAJO del costo/);
});

test('3x2, segunda unidad y pack: el precio efectivo por unidad', () => {
  const p = [{ productoId: 2, presentacionId: 0, cantidad: 1 }];
  assert.equal((simular({ ...base, tipo: 'nxm', lleva: 3, paga: 2, productos: p }, ARTS) as any).productos[0].precioPromoPorUnidad, 1613.33);
  assert.equal((simular({ ...base, tipo: 'segunda_unidad', porcentaje: 50, productos: p }, ARTS) as any).productos[0].precioPromoPorUnidad, 1815);
  assert.equal((simular({ ...base, tipo: 'pack', lleva: 2, precioFinal: 4000, productos: p }, ARTS) as any).productos[0].precioPromoPorUnidad, 2000);
  assert.match((simular({ ...base, tipo: 'nxm', lleva: 2, paga: 2, productos: p }, ARTS) as any).avisos.join(' '), /Faltan datos/);
});

test('combo: el conjunto con sus cantidades, el descuento y el margen del combo', () => {
  const r: any = simular({ ...base, tipo: 'combo', precioFinal: 3000, productos: [{ productoId: 1, presentacionId: 0, cantidad: 1 }, { productoId: 3, presentacionId: 5, cantidad: 2 }] }, ARTS);
  assert.equal(r.combo.precioListaTotal, 2420); // 1210 + 2 × 605
  assert.equal(r.combo.costoTotal, 1400);
  assert.equal(r.combo.descuentoPct, -24); // más caro que comprarlo suelto: se ve
  const b: any = simular({ ...base, tipo: 'combo', precioFinal: 2000, productos: [{ productoId: 1, presentacionId: 0, cantidad: 1 }, { productoId: 3, presentacionId: 5, cantidad: 2 }] }, ARTS);
  assert.equal(b.combo.descuentoPct, 17.4);
  assert.equal(b.combo.margenCombo, 252.89); // 2000/1,21 − 1400
  assert.equal(b.combo.bajoCosto, false);
});

test('lo que no se puede simular lo dice', () => {
  assert.match((simular({ ...base, tipo: 'combo', precioFinal: 100, productos: [{ productoId: 1, presentacionId: 0, cantidad: 1 }] }, ARTS) as any).avisos.join(' '), /al menos dos/);
  assert.match((simular({ ...base, tipo: 'porcentaje', porcentaje: 10, productos: [{ productoId: 99, presentacionId: 0, cantidad: 1 }] }, ARTS) as any).avisos.join(' '), /no existe/);
  assert.match((simular({ ...base, tipo: 'ticket', porcentaje: 10, montoMinimo: 50000, productos: [] }, ARTS) as any).avisos[0], /no se simula/);
});


const AHORA = new Date('2026-10-21T15:00:00-03:00');
const fotoBase = () => ({ contexto: { hoy: '2026-10-21', metricasAl: '2026-10-21T17:50:00Z' } });
const titulos = (f: any) => detectar(f, AHORA).map((x) => `${x.nivel}|${x.titulo}`);

test('comercial: sin nada raro, ninguna señal', () => {
  assert.deepEqual(titulos(fotoBase()), []);
});

test('vencimientos: sin oferta y no llega = urgente; con oferta y no llega = mirar; vencidos sin procesar', () => {
  const f: any = fotoBase();
  f.porVencer = { vencidosSinProcesar: 2, detalle: [
    { producto: 'Yogur', diasQueFaltan: 5, llegaAVenderse: false, oferta: null, valorACosto: 1000 },
    { producto: 'Queso', diasQueFaltan: 9, llegaAVenderse: false, oferta: { activa: true }, valorACosto: 500 },
    { producto: 'Leche', diasQueFaltan: 9, llegaAVenderse: true, oferta: null, valorACosto: 500 },
  ] };
  const t = titulos(f);
  assert.ok(t.includes('urgente|1 lote(s) por vencer no llegan a venderse y no tienen oferta'));
  assert.ok(t.includes('mirar|1 lote(s) no llegan a venderse ni con la oferta que tienen'));
  assert.ok(t.includes('mirar|2 lote(s) ya vencieron y siguen sin procesar'));
});

test('fechas: avisa la que está cerca sin nada armado; no avisa si hay una oferta que la cubre o si falta mucho', () => {
  const f: any = fotoBase();
  f.queViene = { fechasComerciales: [
    { fecha: '2026-11-02', faltan: 12, nombre: 'CyberMonday', aprox: true, nota: '' },
    { fecha: '2026-12-24', faltan: 64, nombre: 'Nochebuena y Navidad', nota: '' },
  ] };
  f.ofertasActivasHoy = [{ oferta: 'Liquidación', hasta: '2026-11-30', automaticaPorVencimiento: true }];
  assert.ok(titulos(f).includes('mirar|CyberMonday en 12 día(s) y no hay promociones armadas'));
  assert.ok(!titulos(f).some((x) => x.includes('Navidad')));
  f.ofertasActivasHoy.push({ oferta: 'Cyber', hasta: '2026-11-04' });
  assert.ok(!titulos(f).some((x) => x.includes('CyberMonday')));
});

test('ofertas, tienda, cupones y combos', () => {
  const f: any = fotoBase();
  f.comoRindieronLasOfertas60Dias = { descuentosPctDeLaVenta: 12, ofertas: [{ oferta: 'A', veredicto: 'pierde' }, { oferta: 'B', veredicto: 'sin_ventas', estado: 'vigente' }] };
  f.tiendaOnline30Dias = { minorista: { resumen: { sesiones: { ahora: 70, antes: 100, variacionPct: -30 }, pedidos: { antes: 10 }, conversion: { ahora: 1, antes: 2, variacionPct: -50 } }, seMiranYNoSeCompran: [{ producto: 'x' }, { producto: 'y' }, { producto: 'z' }] } };
  f.cupones60Dias = { cupones: [{ codigo: 'HOLA', usos: 3, ganancia: -100 }] };
  f.compradosJuntos60Dias = { pares: [{ productoA: { nombre: 'Yerba' }, productoB: { nombre: 'Azúcar' }, lift: 2.5, ticketsJuntos: 30 }] };
  const t = titulos(f);
  for (const x of ['mirar|1 oferta(s) pierden plata', 'dato|1 oferta(s) vigentes sin ninguna venta', 'mirar|Los descuentos son el 12 % de la venta',
    'mirar|Tienda minorista: 30 % menos visitantes', 'mirar|Tienda minorista: la conversión baja 50 %', 'dato|Tienda minorista: 3 producto(s) muy mirados que casi no se compran',
    'mirar|1 cupón(es) dejan pérdida', 'dato|1 par(es) de productos que se compran juntos mucho más de lo normal']) {
    assert.ok(t.includes(x), x);
  }
});
