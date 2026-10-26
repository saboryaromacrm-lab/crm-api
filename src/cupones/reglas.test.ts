/*
 * Cupones (0190): las reglas y la cuenta con números hechos a mano.
 * Carrito: A $1.000 neto ×2 (IVA 21 → $2.420 final), B $500 neto ×1 con oferta, C $2.000 neto ×1 (IVA 10,5 → $2.210).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aplicar, descuentoCuponNeto, enFranja, errorDeCupon, mejorPorMedio, momentoAr, motivoNoVale, parteDeCaja, type Contexto, type Cupon, type Renglon } from './reglas';

const cupon = (x: Partial<Cupon> = {}): Cupon => ({
  codigo: 'BIENVENIDA', activo: true, tipo: 'porcentaje', valor: 10, tope: 0, montoMinimo: 0, desde: null, hasta: null,
  dias: '', horaDesde: '', horaHasta: '', mediosPago: '', entrega: '', marcas: '', categorias: '',
  usosMax: 0, usosPorCliente: 1, soloPrimeraCompra: false, enOfertas: false, enRescate: false, ...x,
});
/* Miércoles 21/10/2026 a las 10:30 de Argentina (13:30 UTC). */
const MIE_1030 = new Date('2026-10-21T13:30:00Z');
const ctx = (x: Partial<Contexto> = {}): Contexto => ({
  ahora: MIE_1030, entrega: 'retiro', medioPago: null, subtotal: 5000, usos: 0, usosCliente: 0, primeraCompra: true, ...x,
});
const carrito = (): Renglon[] => [
  { productoId: 1, marcaId: 7, categoriaId: 3, ofertaId: null, cantidad: 2, precioLista: 1000, iva: 21, descuento: 0 },
  { productoId: 2, marcaId: 7, categoriaId: 3, ofertaId: 99, cantidad: 1, precioLista: 500, iva: 21, descuento: 20 },
  { productoId: 3, marcaId: 8, categoriaId: 4, ofertaId: null, cantidad: 1, precioLista: 2000, iva: 10.5, descuento: 0 },
];

test('el momento en Argentina: miércoles 10:30', () => {
  assert.deepEqual(momentoAr(MIE_1030), { dia: 2, hora: '10:30' });
});

test('10 %: solo en lo que no está en oferta; el de oferta queda igual', () => {
  const r: any = aplicar(cupon(), carrito(), ctx());
  assert.equal(r.vale, true);
  assert.equal(r.descuento, 463);                 // (2.420 + 2.210) × 10 %
  assert.equal(r.renglones[0].descuento, 10);
  assert.equal(r.renglones[1].descuento, 20);     // en oferta: no se toca
  assert.equal(r.renglones[1].cuponPct, 0);
  assert.equal(r.renglones[2].cuponPct, 0.1);
});

test('sobre el descuento del barrio: 1 − (1 − barrio)(1 − cupón)', () => {
  const conBarrio = carrito().map((x) => (x.ofertaId ? x : { ...x, descuento: 5 }));
  const r: any = aplicar(cupon(), conBarrio, ctx());
  assert.ok(Math.abs(r.renglones[0].descuento - 14.5) < 1e-9);   // 1 − 0,95 × 0,9
  assert.equal(r.descuento, 439.85);                              // (2.299 + 2.099,5) × 10 %
});

test('tope en pesos y monto fijo repartido', () => {
  const tope: any = aplicar(cupon({ valor: 50, tope: 500 }), carrito(), ctx());
  assert.equal(tope.descuento, 500);
  const monto: any = aplicar(cupon({ tipo: 'monto', valor: 1000 }), carrito(), ctx());
  assert.equal(monto.descuento, 1000);
  assert.ok(Math.abs(monto.fraccion - 1000 / 4630) < 1e-12);
  const enorme: any = aplicar(cupon({ tipo: 'monto', valor: 100000 }), carrito(), ctx());
  assert.equal(enorme.fraccion, 0.95);           // nunca regala la mercadería
});

test('marcas y categorías', () => {
  const r: any = aplicar(cupon({ marcas: '8' }), carrito(), ctx());
  assert.equal(r.descuento, 221);                // solo C
  const nada = aplicar(cupon({ categorias: '99' }), carrito(), ctx());
  assert.equal(nada.vale, false);
});

test('días, horario (también cruzando medianoche), fechas', () => {
  assert.match(motivoNoVale(cupon({ dias: '1100000' }), ctx())!, /lunes y martes/);
  assert.equal(motivoNoVale(cupon({ dias: '0010000' }), ctx()), null);
  assert.match(motivoNoVale(cupon({ horaDesde: '18:00', horaHasta: '22:00' }), ctx())!, /de 18:00 a 22:00/);
  assert.equal(enFranja('23:30', '22:00', '02:00'), true);
  assert.equal(enFranja('10:30', '22:00', '02:00'), false);
  assert.match(motivoNoVale(cupon({ hasta: '2026-10-20T23:59:59-03:00' }), ctx())!, /venció/);
  assert.match(motivoNoVale(cupon({ desde: '2026-10-22T00:00:00-03:00' }), ctx())!, /vale desde/);
});

test('entrega, medio de pago, usos, primera compra, mínimo', () => {
  assert.match(motivoNoVale(cupon({ entrega: 'envio' }), ctx())!, /envío a domicilio/);
  assert.match(motivoNoVale(cupon({ tipo: 'envio_gratis' }), ctx())!, /envío gratis/);
  assert.equal(motivoNoVale(cupon({ mediosPago: 'efectivo' }), ctx()), null);                 // todavía no eligió
  assert.match(motivoNoVale(cupon({ mediosPago: 'efectivo' }), ctx({ medioPago: 'transferencia' }))!, /pagando con efectivo/);
  assert.match(motivoNoVale(cupon({ usosMax: 10 }), ctx({ usos: 10 }))!, /agotaron/);
  assert.match(motivoNoVale(cupon(), ctx({ usosCliente: 1 }))!, /Ya usaste/);
  assert.equal(motivoNoVale(cupon({ usosPorCliente: 0 }), ctx({ usosCliente: 5 })), null);   // sin tope
  assert.match(motivoNoVale(cupon({ soloPrimeraCompra: true }), ctx({ primeraCompra: false }))!, /primera compra/);
  assert.match(motivoNoVale(cupon({ montoMinimo: 6000 }), ctx())!, /te faltan \$1\.000/);
  assert.match(motivoNoVale(cupon({ activo: false }), ctx())!, /no está activo/);
});

test('envío gratis: no toca los productos', () => {
  const r: any = aplicar(cupon({ tipo: 'envio_gratis' }), carrito(), ctx({ entrega: 'envio' }));
  assert.equal(r.vale, true);
  assert.equal(r.envioGratis, true);
  assert.equal(r.descuento, 0);
});

test('lo que fue cupón en la venta, neto', () => {
  /* $2.000 neto, barrio 5 % y cupón 10 %: bonificado 1.710; antes del cupón 1.900; cupón 190. */
  assert.ok(Math.abs(descuentoCuponNeto(1710, 0.1) - 190) < 1e-9);
  assert.equal(descuentoCuponNeto(1000, 0), 0);
});

test('validación de la definición', () => {
  assert.equal(errorDeCupon(cupon()), null);
  assert.ok(errorDeCupon(cupon({ codigo: 'con espacio' })));
  assert.ok(errorDeCupon(cupon({ valor: 96 })));
  assert.ok(errorDeCupon(cupon({ mediosPago: 'tarjeta_credito' })));
  assert.ok(errorDeCupon(cupon({ tipo: 'envio_gratis', entrega: 'retiro' })));
  assert.ok(errorDeCupon(cupon({ tipo: 'monto', valor: 5000, montoMinimo: 3000 })));
  assert.ok(errorDeCupon(cupon({ horaDesde: '25:00' })));
});

test('automáticos (0199): el mejor de cada medio; sin medio elegido, solo los de cualquier medio', () => {
  const evaluar = (codigo: string, x: Partial<Cupon>) => ({ codigo, resultado: aplicar(cupon({ codigo, ...x }), carrito(), ctx()) });
  const efectivo5 = evaluar('EFECTIVO5', { valor: 5, mediosPago: 'efectivo' });
  const todos3 = evaluar('TODOS3', { valor: 3 });
  const vencido = evaluar('VIEJO', { valor: 50, hasta: '2026-01-01T23:59:59-03:00' });
  const m = mejorPorMedio([efectivo5, todos3, vencido]);
  assert.equal(m.porMedio.efectivo?.codigo, 'EFECTIVO5');     // 5 % le gana al 3 %; el vencido no cuenta
  assert.equal(m.porMedio.transferencia?.codigo, 'TODOS3');   // el de efectivo no vale con transferencia
  assert.equal(m.todos?.codigo, 'TODOS3');                    // antes de elegir, solo el que vale con cualquiera
  assert.equal(mejorPorMedio([efectivo5]).todos, null);
  assert.equal(mejorPorMedio([]).porMedio.efectivo, null);
});

test('ofertas (0199): por defecto no entran; NutriOfertas y NutriRescate se habilitan por separado', () => {
  const rescate = { productoId: 4, marcaId: 7, categoriaId: 3, ofertaId: 50, porVencer: true, ofertaTipo: 'precio_fijo', cantidad: 1, precioLista: 800, iva: 21, descuento: 0 };
  const items = [...carrito(), rescate];
  const nada: any = aplicar(cupon(), items, ctx());
  assert.equal(nada.renglones[1].cuponPct, 0);     // la oferta común, afuera
  assert.equal(nada.renglones[3].cuponPct, 0);     // la por vencer, afuera
  const conOfertas: any = aplicar(cupon({ enOfertas: true }), items, ctx());
  assert.equal(conOfertas.renglones[1].cuponPct, 0.1);
  assert.ok(Math.abs(conOfertas.renglones[1].descuento - 28) < 1e-9);   // 1 − 0,8 × 0,9
  assert.equal(conOfertas.renglones[3].cuponPct, 0);                   // el rescate sigue afuera
  const conRescate: any = aplicar(cupon({ enRescate: true }), items, ctx());
  assert.equal(conRescate.renglones[1].cuponPct, 0);
  assert.equal(conRescate.renglones[3].cuponPct, 0.1);
});

test('la parte de la caja: en el pack, el % achicado a lo que se paga del pack', () => {
  const base = { productoId: 1, marcaId: null, categoriaId: null, cantidad: 3, precioLista: 1000, iva: 21 };
  assert.equal(parteDeCaja({ ...base, ofertaId: null, descuento: 0 }, 0.1), 0.1);
  assert.equal(parteDeCaja({ ...base, ofertaId: 9, ofertaTipo: 'porcentaje', descuento: 20 }, 0.1), 0.1);
  /* Pack 3 × $2.400 (20 % menos que $3.000): la caja cobra 2.400 − 3.000 × c; para 2.400 × 0,9 → c = 0,08. */
  assert.equal(parteDeCaja({ ...base, ofertaId: 9, ofertaTipo: 'pack', descuento: 20 }, 0.1), 0.08);
});

