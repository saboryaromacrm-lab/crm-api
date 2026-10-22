/*
 * De dónde llega cada visitante de la tienda (0194).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clasificarLlegada, dominio } from './origen-llegada';

const c = (d: Parameters<typeof clasificarLlegada>[0]) => clasificarLlegada({ propio: 'saboryaroma.com', ...d });

test('el dominio: sin www, sin camino ni puerto; lo que no es dominio se descarta', () => {
  assert.equal(dominio('https://www.google.com.ar/search?q=x'), 'google.com.ar');
  assert.equal(dominio('l.instagram.com'), 'l.instagram.com');
  assert.equal(dominio('localhost:3005'), '');
  assert.equal(dominio('<script>'), '');
});

test('sin nada es directo; la propia tienda es otra pestaña', () => {
  assert.deepEqual(c({}), { origen: 'directo', detalle: '' });
  assert.equal(c({ referente: 'tienda.saboryaroma.com' }).origen, 'interno');
  assert.equal(c({ referente: 'saboryaroma.com' }).origen, 'interno');
  assert.equal(clasificarLlegada({ referente: 'localhost', propio: 'localhost' }).origen, 'interno');
});

test('el sitio que lo trajo', () => {
  assert.deepEqual(c({ referente: 'www.google.com.ar' }), { origen: 'buscadores', detalle: 'google.com.ar' });
  assert.equal(c({ referente: 'l.instagram.com' }).origen, 'instagram');
  assert.equal(c({ referente: 'lm.facebook.com' }).origen, 'facebook');
  assert.equal(c({ referente: 'web.whatsapp.com' }).origen, 'whatsapp');
  assert.equal(c({ referente: 't.co' }).origen, 'otras_redes');
  assert.deepEqual(c({ referente: 'mercadolibre.com.ar' }), { origen: 'otros_sitios', detalle: 'mercadolibre.com.ar' });
});

test('el utm manda sobre el sitio, y el clic de anuncio sobre todo', () => {
  assert.deepEqual(c({ utmSource: 'WhatsApp', utmCampaign: 'dia-madre' }), { origen: 'whatsapp', detalle: 'whatsapp · dia-madre' });
  assert.equal(c({ utmSource: 'ig', referente: 'google.com' }).origen, 'instagram');
  assert.deepEqual(c({ clic: 'google', utmCampaign: 'promo' }), { origen: 'campana', detalle: 'google · promo' });
  assert.equal(c({ meta: true, referente: 'l.instagram.com' }).origen, 'instagram', 'fbclid no es pago: manda el sitio');
  assert.equal(c({ meta: true }).origen, 'meta', 'fbclid sin sitio: Instagram o Facebook');
  assert.equal(c({ utmSource: 'google', utmMedium: 'cpc' }).origen, 'campana');
  assert.equal(c({ utmMedium: 'email', utmCampaign: 'novedades' }).origen, 'email');
  assert.equal(c({ utmSource: 'volante-local' }).origen, 'otros_sitios');
});
