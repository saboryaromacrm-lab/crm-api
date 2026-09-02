/**
 * PRUEBAS DE `pricing.ts` — la aritmética del dinero.
 *
 * Es el primer test del sistema, y empieza acá a propósito: `pricing.ts` es
 * puro (sin base, sin Nest) y es el único lugar donde se derivan los precios
 * que ven la etiqueta, el POS, el sitio y las métricas. Un error acá no tira
 * una excepción: cobra mal, en silencio, en todas las cajas.
 *
 * Corre con el runner nativo de Node sobre el JavaScript compilado
 * (`npm test` = `nest build` + `node --test`), sin dependencias nuevas.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  costosFormato,
  costoNetoPresentacion,
  descuentoEfectivo,
  formatoActivo,
  precioFinal,
  precioLista,
  precioVentaFila,
  redondearPrecio,
} from './pricing';

/** Igualdad con tolerancia de centavo: la coma flotante no es exacta. */
function cerca(real: number, esperado: number, mensaje?: string, tolerancia = 0.005) {
  assert.ok(
    Math.abs(real - esperado) <= tolerancia,
    `${mensaje ?? 'valor'}: se esperaba ${esperado}, llegó ${real}`,
  );
}

test('descuentoEfectivo: la escala es en cascada, no se suma', () => {
  // "30 y 10" es 37%, no 40%: el error caro que este cálculo existe para evitar.
  cerca(descuentoEfectivo({ costo: 0, descuento: 30, descuento2: 10, flete: 0 }), 37);
  cerca(descuentoEfectivo({ costo: 0, descuento: 0, flete: 0 }), 0);
  assert.equal(descuentoEfectivo(null), 0);
});

test('costosFormato: la cadena lista → descuento → flete → neto → IVA', () => {
  const c = costosFormato({ cantidad: 12, costo: 1200, descuento: 10, flete: 5 }, 21);
  cerca(c.costoBruto, 1080, 'bruto (lista menos 10%)');
  cerca(c.costoNeto, 1134, 'neto (bruto + 5% de flete)');
  cerca(c.costoFinal, 1372.14, 'final (neto × 1,21)');
  cerca(c.costoNetoUnitario, 94.5, 'neto por unidad');
  // Todo facturado: la base del precio ES el costo real y no se absorbe IVA.
  cerca(c.costoPrecio, c.costoNeto, 'base del precio = costo real');
  cerca(c.ivaAbsorbido, 0, 'sin IVA absorbido');
  cerca(c.desembolso, 1306.8, 'lo pagado al proveedor (bruto con IVA, sin flete)');
});

test('costosFormato: modo final deriva el neto hacia atrás', () => {
  const c = costosFormato({ modoCosto: 'final', costoFinal: 1210, cantidad: 10, costo: 0, descuento: 0, flete: 0 }, 21);
  cerca(c.costoNeto, 1000, 'neto = final ÷ 1,21');
  cerca(c.costoNetoUnitario, 100);
  cerca(c.desembolso, 1210, 'se paga lo cargado');
});

test('costosFormato: una cantidad en 0 no deja precios en Infinity', () => {
  const c = costosFormato({ cantidad: 0, costo: 100, descuento: 0, flete: 0 }, 21);
  assert.ok(Number.isFinite(c.costoNetoUnitario));
});

test('costosFormato: mercadería 100% sin factura absorbe el IVA de la venta', () => {
  const c = costosFormato({ costo: 1000, descuento: 0, flete: 0, porcSinFactura: 100 }, 21);
  cerca(c.costoNeto, 1000, 'cuesta lo que se pagó: no hay IVA que recuperar');
  cerca(c.costoPrecio, 1000 / 1.21, 'la base del precio pierde el IVA que la venta genera');
  cerca(c.ivaAbsorbido, 1000 - 1000 / 1.21, 'la diferencia es lo que absorbe el negocio');
  cerca(c.desembolso, 1000, 'al proveedor se le paga sin IVA');
  // La prueba de que la cuenta es la del negocio: la base con IVA devuelve lo
  // que salió del bolsillo.
  cerca(c.costoPrecio * 1.21, c.desembolso, 'costoPrecio × factor = desembolso');
});

test('costosFormato: la identidad de control cierra con parte sin factura y flete', () => {
  const iva = 21;
  const factor = 1 + iva / 100;
  const q = 0.5;
  const c = costosFormato({ costo: 1000, descuento: 0, flete: 10, porcSinFactura: 50 }, iva);
  const flete = 100; // 10% de la mercadería post descuento
  // costoPrecio × factor = desembolso al proveedor + pagado al fletero
  cerca(c.costoPrecio * factor, c.desembolso + flete * ((1 - q) * factor + q), 'identidad de control');
  // Con q=0 el ratio es 1 y todo queda como siempre.
  const sinNegro = costosFormato({ costo: 1000, descuento: 0, flete: 10, porcSinFactura: 0 }, iva);
  cerca(sinNegro.costoPrecio, sinNegro.costoNeto);
});

test('redondearPrecio: sin redondeo normaliza a centavos; con unidad, a la unidad', () => {
  assert.equal(redondearPrecio(1234.567), 1234.57);
  assert.equal(redondearPrecio(1234.567, 1), 1235);
  assert.equal(redondearPrecio(1815, 10), 1820);
  assert.equal(redondearPrecio(1815, 100), 1800);
});

test('precioLista + precioFinal: el redondeo de góndola es idempotente', () => {
  // costo 1000, markup 50% → neto 1500 → final 1815 → góndola a $10 → 1820.
  const neto = precioLista(1000, 50, { iva: 21, redondeo: 10 });
  const final = precioFinal(neto, 21, 10);
  assert.equal(final, 1820, 'la etiqueta cae en la unidad de redondeo');
  cerca(neto, 1820 / 1.21, 'el neto se deriva hacia atrás desde la etiqueta', 0.01);
  // Aplicar de nuevo no mueve el número: etiqueta y ticket no discrepan.
  assert.equal(precioFinal(precioLista(neto, 0, { iva: 21, redondeo: 10 }), 21, 10), 1820);
});

test('precioVentaFila: modo markup — la caja vale N veces la unidad redondeada', () => {
  const p = precioVentaFila(100, { unidades: 6, markup: 40 }, { iva: 21, redondeo: 1 });
  assert.equal(p.unidades, 6);
  assert.equal(p.finalUnitario, 169, 'neto 140 → final 169,4 → al entero 169');
  cerca(p.netoUnitario, 169 / 1.21, 'neto unitario derivado del final', 0.01);
  assert.equal(p.finalFormato, 169 * 6);
});

test('precioVentaFila: modo precio — el final del formato es exacto, sin góndola', () => {
  const p = precioVentaFila(100, { unidades: 12, modoPrecio: 'precio', precioFijo: 10000 }, { iva: 21, redondeo: 100 });
  assert.equal(p.finalFormato, 10000, 'lo fijado no se toca');
  cerca(p.finalUnitario, 10000 / 12, 'la unidad es informativa, puede dar centavos', 0.01);
  cerca(p.netoUnitario, 10000 / 1.21 / 12, 'neto unitario', 0.01);
});

test('formatoActivo: el marcado para precio, si no el primero', () => {
  const a = { id: 'a', usarParaPrecio: false };
  const b = { id: 'b', usarParaPrecio: true };
  assert.equal(formatoActivo([a, b]), b);
  assert.equal(formatoActivo([a]), a);
  assert.equal(formatoActivo([]), null);
});

test('costoNetoPresentacion: el paquete hereda el costo del kilo por lo que consume', () => {
  assert.equal(costoNetoPresentacion(1000, 0.5), 500);
  assert.equal(costoNetoPresentacion(1000, 0), 0);
});
