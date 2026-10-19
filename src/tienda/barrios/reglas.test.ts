import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barrioDe, condiciones, dentro, describirPromo, diaDeSemana, poligonoValido, puntoValido, vigente, type Barrio, type PromoBarrio } from './reglas';

/* Un cuadrado de ~1 km en Formosa y una «L» (cóncava) al lado. */
const CUADRADO: [number, number][] = [[-26.18, -58.18], [-26.18, -58.17], [-26.19, -58.17], [-26.19, -58.18]];
const ELE: [number, number][] = [[-26.20, -58.18], [-26.20, -58.17], [-26.21, -58.17], [-26.21, -58.175], [-26.205, -58.175], [-26.205, -58.18]];
const indep: Barrio = { id: 1, nombre: 'Independencia', poligono: CUADRADO, costoEnvio: 1500 };
const sinCosto: Barrio = { id: 2, nombre: 'San Miguel', poligono: ELE, costoEnvio: null };
const promo = (x: Partial<PromoBarrio>): PromoBarrio => ({ id: 1, barrioIds: [1], tipo: 'envio_gratis', valor: 0, dias: [], desde: null, hasta: null, minimo: 0, activa: true, ...x });
const MARTES = '2026-10-20';

test('dentro: adentro, afuera y la parte vacía de un polígono cóncavo', () => {
  assert.equal(dentro(CUADRADO, { lat: -26.185, lng: -58.175 }), true);
  assert.equal(dentro(CUADRADO, { lat: -26.195, lng: -58.175 }), false);
  assert.equal(dentro(ELE, { lat: -26.202, lng: -58.178 }), true);
  assert.equal(dentro(ELE, { lat: -26.208, lng: -58.178 }), false, 'el hueco de la L no es del barrio');
});

test('barrioDe: el que contiene el punto; sin punto o fuera de todos, ninguno', () => {
  assert.equal(barrioDe([indep, sinCosto], { lat: -26.202, lng: -58.172 })?.nombre, 'San Miguel');
  assert.equal(barrioDe([indep, sinCosto], { lat: -26.3, lng: -58.3 }), null);
  assert.equal(barrioDe([indep, sinCosto], null), null);
});

test('puntoValido y poligonoValido: rechazan lo que no es un lugar del mapa', () => {
  assert.deepEqual(puntoValido({ lat: -26.1, lng: -58.1 }), { lat: -26.1, lng: -58.1 });
  assert.equal(puntoValido({ lat: '-26', lng: -58 }), null);
  assert.equal(puntoValido({ lat: 91, lng: 0 }), null);
  assert.equal(poligonoValido([[0, 0], [1, 1]]), null, 'dos puntos no son un barrio');
  assert.equal(poligonoValido([[0, 0], [1, 1], [1, 'x']]), null);
  assert.deepEqual(poligonoValido(CUADRADO), CUADRADO);
});

test('vigente: días de la semana, fechas y activa', () => {
  assert.equal(diaDeSemana(MARTES), 2);
  assert.equal(vigente(promo({ dias: [2] }), MARTES), true);
  assert.equal(vigente(promo({ dias: [1, 3] }), MARTES), false);
  assert.equal(vigente(promo({ desde: '2026-10-21' }), MARTES), false);
  assert.equal(vigente(promo({ hasta: '2026-10-20' }), MARTES), true, 'el último día cuenta');
  assert.equal(vigente(promo({ activa: false }), MARTES), false);
});

test('condiciones: el costo del barrio, y sin barrio la regla general de siempre', () => {
  assert.equal(condiciones(indep, [], 10_000, 0, MARTES).envio, 1500);
  assert.equal(condiciones(sinCosto, [], 10_000, 0, MARTES).envio, null, 'sin costo propio: se coordina');
  assert.equal(condiciones(null, [], 10_000, 0, MARTES).envio, null);
  assert.equal(condiciones(null, [], 50_000, 40_000, MARTES).envio, 0, 'gratis desde: como hoy');
  assert.equal(condiciones(indep, [], 50_000, 40_000, MARTES).envio, 0, 'el general también vale adentro de un barrio');
});

test('condiciones: gana lo más conveniente y la promo se muestra solo si mejora', () => {
  const gratisMartes = promo({ dias: [2] });
  const c = condiciones(indep, [gratisMartes], 5_000, 0, MARTES);
  assert.equal(c.envio, 0);
  assert.deepEqual(c.aplicadas.map((p) => p.id), [1]);
  const caro = promo({ id: 2, tipo: 'envio_fijo', valor: 2000 });
  const c2 = condiciones(indep, [caro], 5_000, 0, MARTES);
  assert.equal(c2.envio, 1500, 'una promo más cara que el costo del barrio no lo sube');
  assert.equal(c2.aplicadas.length, 0);
  assert.equal(condiciones(sinCosto, [promo({ id: 3, barrioIds: [2], tipo: 'envio_fijo', valor: 800 })], 1, 0, MARTES).envio, 800);
  assert.equal(condiciones(sinCosto, [gratisMartes], 1, 0, MARTES).envio, null, 'la promo de otro barrio no aplica');
});

test('condiciones: mínimo, descuento (gana el mayor) y lo que falta para la próxima', () => {
  const desde20 = promo({ minimo: 20_000 });
  const c = condiciones(indep, [desde20], 15_000, 0, MARTES);
  assert.equal(c.envio, 1500);
  assert.equal(c.proxima?.faltan, 5_000);
  assert.equal(condiciones(indep, [desde20], 20_000, 0, MARTES).envio, 0, 'el mínimo justo alcanza');
  const d = condiciones(indep, [promo({ id: 4, tipo: 'descuento', valor: 10 }), promo({ id: 5, tipo: 'descuento', valor: 15 })], 1, 0, MARTES);
  assert.equal(d.descuentoPct, 15);
  assert.deepEqual(d.aplicadas.map((p) => p.id), [5]);
  assert.equal(condiciones(indep, [promo({ tipo: 'descuento', valor: 10, dias: [3] })], 1, 0, MARTES).descuentoPct, 0, 'otro día: nada');
});

test('describirPromo: en palabras del cliente', () => {
  const nombres = new Map([[1, 'Independencia'], [2, 'San Miguel'], [3, 'Centro']]);
  assert.equal(describirPromo(promo({}), nombres), 'Envío gratis a Independencia');
  assert.equal(describirPromo(promo({ barrioIds: [1, 2, 3], tipo: 'envio_fijo', valor: 1500, minimo: 20000 }), nombres),
    'Envío a $1.500 a Independencia, San Miguel y Centro en compras desde $20.000');
  assert.equal(describirPromo(promo({ barrioIds: [1, 2], tipo: 'descuento', valor: 10 }), nombres), '10% de descuento en Independencia y San Miguel');
});
