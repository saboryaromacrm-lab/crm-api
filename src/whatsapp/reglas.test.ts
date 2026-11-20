import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { aWhatsapp, buscarEn, firmaMetaValida, leerAviso, numeroDe, partir, sanitizarConfig, sesionVencida, slug, textoDeMensaje, BOT_DEFAULTS } from './reglas';

test('numeroDe: el argentino a 10 dígitos; otro país, sus dígitos', () => {
  assert.equal(numeroDe('5493704123456'), '3704123456');
  assert.equal(numeroDe('+54 9 370 15 412-3456'), '3704123456');
  assert.equal(numeroDe('59899123456'), '59899123456');
  assert.equal(numeroDe('123'), '');
});

test('sanitizarConfig: defaults, números normalizados sin repetir, topes y modelo válido', () => {
  assert.deepEqual(sanitizarConfig(null), BOT_DEFAULTS);
  const c = sanitizarConfig({
    activo: 'si', modelo: 'gpt', horasPausaHumano: 500, topeGastoMesUsd: -3, linkTienda: 'javascript:alert(1)',
    numerosSinIa: [{ numero: '+54 9 370 4123456', nombre: '  Juan   (depósito) ' }, { numero: '3704123456', nombre: 'otra vez' }, { numero: 'x' }],
  });
  assert.equal(c.activo, false);
  assert.equal(c.modelo, 'claude-haiku-5-5');
  assert.equal(c.horasPausaHumano, 72);
  assert.equal(c.topeGastoMesUsd, 1);
  assert.equal(c.linkTienda, BOT_DEFAULTS.linkTienda);
  assert.deepEqual(c.numerosSinIa, [{ numero: '3704123456', nombre: 'Juan (depósito)' }]);
  assert.equal(sanitizarConfig({ linkTienda: 'https://tienda.com/' }).linkTienda, 'https://tienda.com');
});

test('firmaMetaValida: solo con el secreto correcto sobre el cuerpo crudo', () => {
  const cuerpo = Buffer.from('{"entry":[]}');
  const firma = `sha256=${createHmac('sha256', 'secreto').update(cuerpo).digest('hex')}`;
  assert.equal(firmaMetaValida(cuerpo, firma, 'secreto'), true);
  assert.equal(firmaMetaValida(cuerpo, firma, 'otro'), false);
  assert.equal(firmaMetaValida(Buffer.from('{"entry":[1]}'), firma, 'secreto'), false);
  assert.equal(firmaMetaValida(undefined, firma, 'secreto'), false);
  assert.equal(firmaMetaValida(cuerpo, 'sha256=zz', 'secreto'), false);
  assert.equal(firmaMetaValida(cuerpo, firma, ''), false);
});

test('leerAviso: mensajes con su nombre, ecos del celular; estados y basura afuera', () => {
  const aviso = {
    entry: [{
      changes: [
        {
          value: {
            contacts: [{ wa_id: '5493704123456', profile: { name: 'Ana' } }],
            messages: [
              { from: '5493704123456', id: 'wamid.1', type: 'text', text: { body: ' tienen almendras? ' } },
              { from: '5493704123456', id: 'wamid.2', type: 'audio', audio: { id: 'x' } },
              { id: 'sin-from', type: 'text', text: { body: 'x' } },
            ],
            statuses: [{ id: 'wamid.9', status: 'read' }],
          },
        },
        { value: { message_echoes: [{ from: '5493700000000', to: '5493704123456', id: 'wamid.3', type: 'text', text: { body: 'Hola Ana, sí' } }] } },
      ],
    }],
  };
  const { entrantes, ecos } = leerAviso(aviso);
  assert.deepEqual(entrantes, [
    { waId: '5493704123456', nombre: 'Ana', metaId: 'wamid.1', texto: 'tienen almendras?' },
    { waId: '5493704123456', nombre: 'Ana', metaId: 'wamid.2', texto: '[mandó un audio]' },
  ]);
  assert.deepEqual(ecos, [{ waId: '5493704123456', metaId: 'wamid.3', texto: 'Hola Ana, sí' }]);
  assert.deepEqual(leerAviso({ entry: 'x' }), { entrantes: [], ecos: [] });
});

test('textoDeMensaje: botones y fotos con epígrafe', () => {
  assert.equal(textoDeMensaje({ type: 'interactive', interactive: { button_reply: { title: 'Sí' } } }), 'Sí');
  assert.equal(textoDeMensaje({ type: 'image', image: { caption: 'esto' } }), '[mandó una foto] esto');
});

test('sesionVencida: después de 12 horas sin hablar', () => {
  const ahora = new Date('2026-11-19T20:00:00Z');
  assert.equal(sesionVencida(null, ahora), true);
  assert.equal(sesionVencida(new Date('2026-11-19T09:00:00Z'), ahora), false);
  assert.equal(sesionVencida(new Date('2026-11-19T07:59:00Z'), ahora), true);
});

test('aWhatsapp: negrita de WhatsApp, sin títulos y links legibles', () => {
  assert.equal(aWhatsapp('## Ofertas\n**Almendras** a $10\n\n\n[ver](https://t.com/p)'), '*Ofertas*\n*Almendras* a $10\n\nver: https://t.com/p');
});

test('partir: respeta el tope y corta en un espacio', () => {
  const partes = partir(`${'a '.repeat(30)}fin`, 20);
  assert.ok(partes.every((p) => p.length <= 20));
  assert.equal(partes.join(' ').replace(/\s+/g, ' '), `${'a '.repeat(30)}fin`.replace(/\s+/g, ' '));
});

test('buscarEn: todas las palabras primero, plural, acentos; si no, las que más coinciden', () => {
  const items = [
    { nombre: 'Almendra pelada', categoria: 'Frutos secos', enStock: true },
    { nombre: 'Almendra con cáscara', categoria: 'Frutos secos', enStock: false },
    { nombre: 'Maní tostado', categoria: 'Frutos secos', enStock: true },
    { nombre: 'Yerba suave', marca: 'Taragüi', categoria: 'Infusiones', enStock: true },
  ];
  assert.deepEqual(buscarEn(items, 'almendras peladas', 5).map((x) => x.nombre), ['Almendra pelada']);
  assert.deepEqual(buscarEn(items, 'almendras', 5).map((x) => x.nombre), ['Almendra pelada', 'Almendra con cáscara']);
  assert.deepEqual(buscarEn(items, 'mani', 5).map((x) => x.nombre), ['Maní tostado']);
  assert.deepEqual(buscarEn(items, 'yerba sin palo', 5).map((x) => x.nombre), ['Yerba suave']);
  assert.deepEqual(buscarEn(items, 'de la', 5), []);
});

test('slug: igual que el sitio', () => {
  assert.equal(slug('Maní tostado 1 kg'), 'mani-tostado-1-kg');
});
