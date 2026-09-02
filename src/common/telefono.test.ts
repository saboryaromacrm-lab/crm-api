import { test } from 'node:test';
import assert from 'node:assert/strict';
import { telefonoArgentino } from './telefono';

test('telefonoArgentino: acepta las formas en que escribe la gente', () => {
  assert.equal(telefonoArgentino('370 4123456'), '3704123456', 'área + abonado con espacio');
  assert.equal(telefonoArgentino('0370 4123456'), '3704123456', 'con el 0 de larga distancia');
  assert.equal(telefonoArgentino('0370 15 4123456'), '3704123456', 'con el viejo 15');
  assert.equal(telefonoArgentino('+54 9 370 4123456'), '3704123456', 'internacional con 9 de celular');
  assert.equal(telefonoArgentino('549 370 4123456'), '3704123456', 'internacional sin +');
  assert.equal(telefonoArgentino('11 4123-4567'), '1141234567', 'AMBA (área de 2 dígitos)');
  assert.equal(telefonoArgentino('(0370) 4-123456'), '3704123456', 'con paréntesis y guiones');
});

test('telefonoArgentino: rechaza lo que no llega a un número completo', () => {
  assert.equal(telefonoArgentino('4123456'), '', 'sin código de área');
  assert.equal(telefonoArgentino('370 412345'), '', 'un dígito de menos');
  assert.equal(telefonoArgentino('370 41234567'), '', 'un dígito de más');
  assert.equal(telefonoArgentino(''), '');
  assert.equal(telefonoArgentino(undefined as unknown as string), '');
});
