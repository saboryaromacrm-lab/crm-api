/*
 * Links medibles de la tienda (0195): a dónde puede llevar un link y su código.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codigoNuevo, destinoValido } from './links';

test('a dónde lleva: solo una página de la tienda, sin los parámetros que pone el link', () => {
  assert.equal(destinoValido(''), '/');
  assert.equal(destinoValido('/tienda?oferta=1'), '/tienda?oferta=1');
  assert.equal(destinoValido('https://tiendaonline.saboryaroma.com/producto/yerba-x1kg?utm_source=ig&l=abc&cat=3'), '/producto/yerba-x1kg?cat=3');
  assert.equal(destinoValido('tienda'), null, 'sin barra no es una página');
  assert.equal(destinoValido('//otro-sitio.com'), null, 'no se sale del sitio');
  assert.equal(destinoValido('/' + 'x'.repeat(400)), null);
});

test('el código: seis caracteres sin los que se confunden', () => {
  const codigos = new Set(Array.from({ length: 500 }, codigoNuevo));
  assert.ok(codigos.size > 490, 'casi nunca se repiten');
  for (const c of codigos) assert.match(c, /^[a-hjkmnp-z2-9]{6}$/);
});
