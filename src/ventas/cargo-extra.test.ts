import test from 'node:test';
import assert from 'node:assert/strict';
import { cargosNoPermitidos, esCargoFijo, mensajeCargoNoPermitido } from './cargo-extra';

test('sin permiso pasan solo los que pone el sistema: el envío del pedido y el recargo por cuotas', () => {
  assert.ok(esCargoFijo({ concepto: 'Envío a domicilio', iva: 21 }));
  assert.ok(esCargoFijo({ concepto: 'Envío a domicilio (B° Centro)', iva: 21 }));
  assert.ok(esCargoFijo({ concepto: 'Recargo 3 cuotas (20%)', iva: 21 }));
  assert.ok(esCargoFijo({ concepto: 'Recargo 1 cuota (5%)', iva: 21 }));
});

test('sin permiso NO pasa nada tipeado: ni Envío ni Bolsa', () => {
  assert.ok(!esCargoFijo({ concepto: 'Envío', iva: 21 }));
  assert.ok(!esCargoFijo({ concepto: 'Bolsa', iva: 21 }));
  assert.ok(!esCargoFijo({ concepto: 'Yerba Playadito 1kg', iva: 0 }));
  assert.ok(!esCargoFijo({ concepto: 'Yerba Playadito 1kg', iva: 21 }));
  assert.ok(!esCargoFijo({ concepto: 'Bolsa', iva: 0 }), 'la bolsa exenta era justamente el problema');
  assert.ok(!esCargoFijo({ concepto: 'Envío', iva: 10.5 }));
  assert.ok(!esCargoFijo({ concepto: 'Envío Yerba', iva: 21 }));
  assert.ok(!esCargoFijo({ concepto: 'Bolsa ecologica', iva: 21 }));
});

test('con el permiso pasa todo', () => {
  assert.deepEqual(cargosNoPermitidos([{ concepto: 'Lo que sea', importe: 100, iva: 0 }], true), []);
});

test('sin permiso: lo que el ticket ya tenía guardado sigue, uno por uno', () => {
  const previo = { concepto: 'Packaging', importe: 500, iva: 0 };
  assert.deepEqual(cargosNoPermitidos([previo], false, [previo]), []);
  const dos = cargosNoPermitidos([previo, previo], false, [previo]);
  assert.equal(dos.length, 1, 'un segundo igual es uno NUEVO');
  const otroPrecio = cargosNoPermitidos([{ ...previo, importe: 900 }], false, [previo]);
  assert.equal(otroPrecio.length, 1, 'cambiarle el importe es cargar otro');
});

test('el mensaje nombra lo que no pasó y dice qué se puede', () => {
  const m = mensajeCargoNoPermitido([{ concepto: 'Yerba 1kg' }]);
  assert.match(m, /«Yerba 1kg»/);
  assert.match(m, /Cargo extra a mano/);
});
