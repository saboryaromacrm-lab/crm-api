import test from 'node:test';
import assert from 'node:assert/strict';
import { comoRenglonesDelPie, separarPruebas } from './renglones-prueba';

test('el renglón de prueba entra al pie como un renglón más, con su neto y su IVA', () => {
  const [r] = comoRenglonesDelPie([{ descripcion: ' YACAI - HELADO ACAI ', codigo: '7313', cantidad: 6, neto: 228857.88, iva: 21 }]);
  assert.equal(r.cantidad, 1);
  assert.equal(r.costoUnitario, 228857.88);
  assert.equal(r.iva, 21);
  assert.deepEqual(r.prueba, { descripcion: 'YACAI - HELADO ACAI', codigo: '7313', cantidad: 6 });
});

test('sin alícuota la decide el pie (queda undefined); sin renglones, nada', () => {
  assert.equal(comoRenglonesDelPie([{ descripcion: 'x', cantidad: 1, neto: 10 }])[0].iva, undefined);
  assert.deepEqual(comoRenglonesDelPie(), []);
});

test('después del pie: los productos por un lado, los de prueba con su neto bonificado por el otro', () => {
  const { productos, pruebas } = separarPruebas([
    { productoId: 1, iva: 21, subtotal: 900 },
    { prueba: { descripcion: 'CAJA MIXTA', codigo: '7725', cantidad: 1 }, iva: 21, subtotal: 120217 },
  ] as any[]);
  assert.equal(productos.length, 1);
  assert.equal(productos[0].productoId, 1);
  assert.deepEqual(pruebas, [{ descripcion: 'CAJA MIXTA', codigo: '7725', cantidad: 1, neto: 120217, iva: 21 }]);
});
