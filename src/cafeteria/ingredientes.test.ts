/*
 * Coffit · el costo convertido de un ingrediente (0140) y la horma al peso (0250).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertir } from './ingredientes.module';

const horma = { contenido: 3500, contenidoUnidad: 'g', unidadCosto: 'kg' };

test('el envase configurado: la horma de 3,5 kg', () => {
  assert.equal(convertir(35000, 'entero', horma), 10000);
  assert.equal(convertir(35000, 'entero', { ...horma, unidadCosto: 'g' }), 10);
  assert.equal(convertir(35000, 'entero', { ...horma, unidadCosto: 'u' }), 35000);
});

test('al peso manda lo que pesó: 14,97 kg en 4 hormas (La Serenísima, 28/11/2026)', () => {
  // El renglón: $195.304,61 neto en 4 hormas, con 21 % de IVA; cada horma pesó 3,7425 kg.
  const porHorma = (195304.61 / 4) * 1.21;
  const real = convertir(porHorma, 'entero', horma, 14.97 / 4)!;
  assert.ok(Math.abs(real - 13046.40 * 1.21) < 0.01, `kilo real ${real}`); // $15.786,14/kg con IVA
  const delNombre = convertir(porHorma, 'entero', horma)!;
  assert.ok(Math.abs(delNombre / real - 14.97 / 14) < 1e-6); // con los 3,5 kg del nombre: 6,9 % de más
  // Por unidad o por docena, el peso no importa.
  assert.equal(convertir(porHorma, 'entero', { ...horma, unidadCosto: 'u' }, 3.7425), porHorma);
});
