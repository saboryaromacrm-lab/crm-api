/*
 * Reglas de oferta por vencimiento (0188): la cuenta de la plata, con números hechos a mano.
 * Artículo de prueba: costo real $1.000 neto, IVA 21 % → el piso es $1.210 final.
 * Listas: Minorista (base) $2.000 · Promo $1.800 · Mayorista $1.500.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorDeRegla, pisoFinal, proponer, rangoDe, rentabilidadDeOferta, type Articulo, type Regla } from './reglas';

const art = (extra: Partial<Articulo> = {}): Articulo => ({
  iva: 21, redondeo: 10, costoReal: 1000, listaBaseId: 1,
  listas: [{ listaId: 1, nombre: 'Minorista', precio: 2000 }, { listaId: 2, nombre: 'Promo', precio: 1800 }, { listaId: 3, nombre: 'Mayorista', precio: 1500 }],
  ...extra,
});
const regla = (r: Partial<Regla>): Regla => ({ rango: 'd30', mecanica: 'ninguna', valor: 0, lleva: 0, paga: 0, ...r });
const de = (p: any, id: number) => p.porLista.find((x: any) => x.listaId === id);

test('los rangos: mismos cortes que el panel', () => {
  assert.deepEqual([-1, 0, 7, 8, 15, 16, 30, 31].map(rangoDe), ['vencido', 'd7', 'd7', 'd15', 'd15', 'd30', 'd30', 'vigente']);
});

test('25 %: un precio para todos sobre la lista base; corre donde baja', () => {
  const p: any = proponer(regla({ mecanica: 'descuento', valor: 25 }), art());
  assert.equal(p.hay, true);
  assert.equal(p.tipo, 'precio_fijo');
  assert.equal(p.precio, 1500);
  assert.deepEqual(p.listas, [1, 2]);                       // la mayorista ya está en $1.500: no le baja nada
  assert.equal(de(p, 3).aplica, false);
  assert.equal(de(p, 1).ganancia, 239.67);                   // 1500 / 1,21 − 1000
  assert.equal(de(p, 1).sobreCosto, 24);
  assert.equal(p.topeAlCosto, false);
});

test('40 %: pide menos que el costo → queda AL COSTO, nunca debajo', () => {
  const p: any = proponer(regla({ mecanica: 'descuento', valor: 40 }), art());
  assert.equal(p.precio, 1210);                              // 2000 × 0,6 = 1200 < piso 1210
  assert.equal(p.topeAlCosto, true);
  assert.deepEqual(p.listas, [1, 2, 3]);
  assert.equal(de(p, 3).ganancia, 0);
});

test('costo + 5 %: gana el 5 % sobre el costo real', () => {
  const p: any = proponer(regla({ mecanica: 'costo', valor: 5 }), art());
  assert.equal(p.precio, 1270);                              // 1000 × 1,05 × 1,21 = 1270,5 → góndola de a 10
  assert.equal(de(p, 1).ganancia, 49.59);
  assert.equal(de(p, 1).sobreCosto, 5);
  const exacto: any = proponer(regla({ mecanica: 'costo', valor: 5 }), art({ redondeo: 0 }));
  assert.equal(exacto.precio, 1270.5);
});

test('al costo (costo + 0): el neto queda justo en el costo, nunca debajo', () => {
  const p: any = proponer(regla({ rango: 'd7', mecanica: 'costo', valor: 0 }), art());
  assert.equal(p.precio, 1210);                              // 1000 × 1,21
  assert.deepEqual(p.listas, [1, 2, 3]);
  assert.equal(de(p, 1).ganancia, 0);
  const conRedondeo: any = proponer(regla({ rango: 'd7', mecanica: 'costo', valor: 0 }), art({ costoReal: 1003 }));
  assert.equal(conRedondeo.precio, 1220);                    // 1213,63 → para ARRIBA al paso de $10
  assert.ok(de(conRedondeo, 1).ganancia >= 0);
});

test('3×2: cada lista con su precio; no corre donde queda debajo del costo', () => {
  const p: any = proponer(regla({ mecanica: 'nxm', lleva: 3, paga: 2 }), art());
  assert.equal(p.tipo, 'nxm');
  assert.deepEqual(p.listas, [1]);                           // 2000 × 2/3 = 1333 ≥ 1210; 1800 → 1200 y 1500 → 1000 no
  assert.equal(de(p, 1).precioOferta, 1333.33);
  assert.equal(de(p, 2).aplica, false);
});

test('el piso redondeado nunca queda debajo del costo', () => {
  const a = art({ iva: 10.5, redondeo: 100 });
  assert.equal(pisoFinal(a), 1105);
  const p: any = proponer(regla({ mecanica: 'descuento', valor: 60 }), a);
  assert.equal(p.precio, 1200);                              // 800 pedido → piso 1105 redondeado para ARRIBA
  assert.ok(p.precio / 1.105 >= a.costoReal);
});

test('sin costo, sin listas o sin regla: no se arma a ciegas', () => {
  assert.equal(proponer(regla({ mecanica: 'descuento', valor: 25 }), art({ costoReal: 0 })).hay, false);
  assert.equal(proponer(regla({ mecanica: 'descuento', valor: 25 }), art({ listas: [] })).hay, false);
  assert.equal(proponer(regla({ mecanica: 'ninguna' }), art()).hay, false);
  /* Lista ya al costo: no hay nada que bajar. */
  assert.equal(proponer(regla({ mecanica: 'descuento', valor: 25 }), art({ listas: [{ listaId: 1, nombre: 'M', precio: 1210 }] })).hay, false);
});

test('validación de la regla', () => {
  assert.equal(errorDeRegla(regla({ mecanica: 'descuento', valor: 25 })), null);
  assert.ok(errorDeRegla(regla({ mecanica: 'descuento', valor: 0 })));
  assert.ok(errorDeRegla(regla({ mecanica: 'descuento', valor: 100 })));
  assert.equal(errorDeRegla(regla({ mecanica: 'costo', valor: 0 })), null);
  assert.ok(errorDeRegla(regla({ mecanica: 'nxm', lleva: 2, paga: 2 })));
  assert.equal(errorDeRegla(regla({ mecanica: 'nxm', lleva: 3, paga: 2 })), null);
  assert.ok(errorDeRegla(regla({ rango: 'vencido' as any, mecanica: 'ninguna' })));
});

test('la oferta puesta a mano: se ve si vende debajo del costo', () => {
  const o = { tipo: 'porcentaje', porcentaje: 60, precio: 0, lleva: 0, paga: 0, listas: '1,2' };
  const r = { porLista: rentabilidadDeOferta(o, art())! };
  assert.equal(de(r, 1).precioOferta, 800);                  // 2000 × 0,4
  assert.equal(de(r, 1).ganancia, -338.84);                  // 800 / 1,21 − 1000: PIERDE
  assert.equal(de(r, 3).aplica, false);                      // no corre en la mayorista
  const fijo = rentabilidadDeOferta({ ...o, tipo: 'precio_fijo', precio: 1700, listas: '' }, art())!;
  assert.deepEqual(fijo.map((x) => x.aplica), [true, true, false]); // a $1.500 no le baja nada
  assert.equal(rentabilidadDeOferta({ ...o, tipo: 'nxm', lleva: 3, paga: 2 }, art())![0].precioOferta, 1333.33);
  assert.equal(rentabilidadDeOferta({ ...o, tipo: 'segunda_unidad', porcentaje: 50 }, art())![0].precioOferta, 1500);
  assert.equal(rentabilidadDeOferta({ ...o, tipo: 'combo' }, art()), null);
});
