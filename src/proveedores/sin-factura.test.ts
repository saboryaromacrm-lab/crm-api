/*
 * Mercadería recibida sin su factura cargada (7/11/2026): cada tarjeta en
 * «Recibido» necesita su propio comprobante del proveedor, desde que se pidió.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sinFactura } from './sin-factura';

const d = (s: string) => new Date(`${s}T12:00:00Z`);
const tarjeta = (id: number, proveedorId: number, pedido: string | null, llego: string) =>
  ({ id, proveedorId, fechaPedido: pedido ? d(pedido) : null, fechaRecepcion: d(llego) });
const carga = (proveedorId: number, en: string) => ({ proveedorId, en: d(en) });
const ids = (xs: { id: number }[]) => xs.map((x) => x.id);

test('con su factura cargada después del pedido no avisa; sin ninguna, sí', () => {
  const t = [tarjeta(1, 10, '2026-10-01', '2026-10-05'), tarjeta(2, 20, '2026-10-01', '2026-10-04')];
  assert.deepEqual(ids(sinFactura(t, [carga(10, '2026-10-06')])), [2]);
});

test('la factura de un pedido viejo no sirve (antes del pedido, pasado el margen)', () => {
  const t = [tarjeta(1, 10, '2026-10-10', '2026-10-12')];
  assert.deepEqual(ids(sinFactura(t, [carga(10, '2026-10-01')])), [1]);
  /* Dentro del margen de 2 días antes del pedido, sí. */
  assert.deepEqual(ids(sinFactura(t, [carga(10, '2026-10-09')])), []);
});

test('una factura no tapa dos entregas: queda sin pareja la más nueva', () => {
  const t = [tarjeta(1, 10, '2026-10-01', '2026-10-03'), tarjeta(2, 10, '2026-10-06', '2026-10-08')];
  assert.deepEqual(ids(sinFactura(t, [carga(10, '2026-10-09')])), [2]);
  assert.deepEqual(ids(sinFactura(t, [carga(10, '2026-10-09'), carga(10, '2026-10-04')])), []);
  /* La de la primera se cargó antes del segundo pedido: la segunda sigue faltando. */
  assert.deepEqual(ids(sinFactura(t, [carga(10, '2026-10-02'), carga(10, '2026-10-02')])), [2]);
});

test('pasada directo a Recibido (sin fecha de pedido) cuenta desde que llegó', () => {
  const t = [tarjeta(1, 10, null, '2026-10-10')];
  assert.deepEqual(ids(sinFactura(t, [carga(10, '2026-10-09')])), []);
  assert.deepEqual(ids(sinFactura(t, [carga(10, '2026-10-05')])), [1]);
});

test('ordenadas por cuándo llegaron', () => {
  const t = [tarjeta(1, 10, null, '2026-10-09'), tarjeta(2, 20, null, '2026-10-02'), tarjeta(3, 30, null, '2026-10-05')];
  assert.deepEqual(ids(sinFactura(t, [])), [2, 3, 1]);
});
