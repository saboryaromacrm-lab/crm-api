import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claveDe, movimientoDe, pendienteDe, repartirEntrega } from './diferencias';

test('sin contar nada, todo llega como dice el papel', () => {
  const r = repartirEntrega({ items: [{ productoId: 1, cantidad: 12 }] });
  assert.deepEqual(r.noEntra, [0]);
  assert.deepEqual(r.faltantes, []);
  assert.deepEqual(r.sobrantes, []);
});

test('faltante: el papel cobra 12, llegaron 10 → entran 10 y quedan 2 pendientes', () => {
  const r = repartirEntrega({ items: [{ productoId: 1, cantidad: 12 }], llegaron: [{ productoId: 1, cantidad: 10 }] });
  assert.deepEqual(r.noEntra, [2]);
  assert.deepEqual(r.faltantes, [{ productoId: 1, presentacionId: null, cantidad: 2 }]);
  assert.deepEqual(r.sobrantes, []);
});

test('sobrante: llegaron 15 de 12 y un producto que no está en el papel', () => {
  const r = repartirEntrega({
    items: [{ productoId: 1, cantidad: 12 }],
    llegaron: [{ productoId: 1, cantidad: 15 }, { productoId: 2, presentacionId: 7, cantidad: 4 }],
  });
  assert.deepEqual(r.noEntra, [0]);
  assert.deepEqual(r.sobrantes, [{ productoId: 1, presentacionId: null, cantidad: 3 }, { productoId: 2, presentacionId: 7, cantidad: 4 }]);
});

test('el faltante se reparte entre los renglones del mismo producto, sin pasarse de cada uno', () => {
  const r = repartirEntrega({
    items: [{ productoId: 1, cantidad: 6 }, { productoId: 1, cantidad: 6 }],
    llegaron: [{ productoId: 1, cantidad: 4 }],
  });
  assert.deepEqual(r.noEntra, [6, 2]);
});

test('mitad y mitad: se compara contra las dos mitades juntas', () => {
  const otra = new Map([[claveDe(1), 6]]);
  /* La A trae 6, la liquidación trajo 6: llegaron 12 → nada de más. */
  assert.deepEqual(repartirEntrega({ items: [{ productoId: 1, cantidad: 6 }], llegaron: [{ productoId: 1, cantidad: 12 }], otraMitad: otra }).sobrantes, []);
  /* Llegaron 10 de 12 entre las dos: faltan 2, y salen de lo que trae este papel. */
  const r = repartirEntrega({ items: [{ productoId: 1, cantidad: 6 }], llegaron: [{ productoId: 1, cantidad: 10 }], otraMitad: otra });
  assert.deepEqual(r.noEntra, [2]);
  assert.deepEqual(r.faltantes, [{ productoId: 1, presentacionId: null, cantidad: 2 }]);
  /* Faltan 8: más de lo que trae este papel (6) → se marca en el otro. */
  const mal = repartirEntrega({ items: [{ productoId: 1, cantidad: 6 }], llegaron: [{ productoId: 1, cantidad: 4 }], otraMitad: otra });
  assert.equal(mal.errores[0].tipo, 'falta_mas_que_el_papel');
  assert.equal(mal.errores[0].puede, 6);
});

test('lo que ya había entrado de más y este papel cobra no vuelve a entrar', () => {
  const cub = new Map([[claveDe(1), 3]]);
  /* El papel cobra 10, 3 ya habían entrado: llegan 7 ahora → sin diferencia, no entran 3. */
  const r = repartirEntrega({ items: [{ productoId: 1, cantidad: 10 }], llegaron: [{ productoId: 1, cantidad: 7 }], cubiertos: cub });
  assert.deepEqual(r.noEntra, [3]);
  assert.deepEqual(r.faltantes, []);
  /* Sin contar: igual no entran los 3. */
  assert.deepEqual(repartirEntrega({ items: [{ productoId: 1, cantidad: 10 }], cubiertos: cub }).noEntra, [3]);
  /* Cobrar 3 ya entrados en un papel que trae 2 no puede ser. */
  assert.equal(repartirEntrega({ items: [{ productoId: 1, cantidad: 2 }], cubiertos: cub }).errores[0].tipo, 'cobra_mas_de_lo_que_entro');
});

test('lo pendiente y qué mueve cada resolución', () => {
  assert.equal(pendienteDe(5, 2), 3);
  assert.equal(pendienteDe(5, 5.0000001), 0);
  assert.equal(movimientoDe('faltante', 'llego'), 1);
  assert.equal(movimientoDe('faltante', 'nota_credito'), 0);
  assert.equal(movimientoDe('sobrante', 'devuelto'), -1);
  assert.equal(movimientoDe('sobrante', 'sin_cargo'), 0);
});
