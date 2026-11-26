import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agrupar, claseConcepto, cuadrarEfectivo, deDondeSalio, esPagoEnEfectivo, estimarSaldo, grupoCobro, grupoDelPago, suma, sumarFugas } from './plata';

test('los conceptos por su nombre: lo interno no es plata que se fue', () => {
  assert.equal(claseConcepto('Depósito en el banco'), 'interno');
  assert.equal(claseConcepto('Cambio a mi cuenta (efectivo por transferencia)'), 'interno');
  assert.equal(claseConcepto('Retiro del dueño'), 'retiro');
  assert.equal(claseConcepto('Adelantos sueldos'), 'sueldos');
  assert.equal(claseConcepto('Sueldos'), 'sueldos');
  assert.equal(claseConcepto('Alquileres'), 'otro');
});

test('lo que un cliente le pagó directo a un proveedor no entra como plata tuya', () => {
  assert.equal(grupoCobro('transferencia_proveedor'), null);
  assert.equal(grupoCobro('nota_credito'), null);
  assert.equal(grupoCobro('qr'), 'mercadopago');
  assert.equal(grupoCobro('tarjeta_credito'), 'mercadopago');
  assert.equal(grupoCobro('efectivo'), 'efectivo');
  assert.equal(grupoCobro('cheque'), 'otros');
});

test('de dónde salió cada pago', () => {
  assert.equal(deDondeSalio({ medio: 'efectivo', cajaSesionId: 5 }), 'Efectivo de la caja de un local');
  assert.equal(deDondeSalio({ medio: 'efectivo', deCf: true }), 'Efectivo de la caja central');
  assert.equal(deDondeSalio({ medio: 'transferencia', cambioPor: 'Juan', cuenta: 'saboryaroma' }), 'Efectivo por transferencia');
  assert.equal(deDondeSalio({ medio: 'transferencia', cuenta: 'saboryaroma' }), 'Transferencia desde saboryaroma');
  assert.equal(deDondeSalio({ medio: 'echeq' }), 'Echeq debitado');
});

test('en qué se fue: el rubro del gasto como lo lee Resultados', () => {
  assert.equal(grupoDelPago('mercaderia', null), 'mercaderia');
  assert.equal(grupoDelPago('gastos', 'sueldos'), 'sueldos');
  assert.equal(grupoDelPago('gastos', 'iibb'), 'impuestos');
  assert.equal(grupoDelPago('gastos', 'comisiones'), 'financiero');
  assert.equal(grupoDelPago('gastos', 'normal'), 'gastos');
  assert.equal(grupoDelPago('gastos', null), 'gastos');
});

test('agrupar suma por grupo, ordena y deja afuera los ceros', () => {
  const g = agrupar([
    { grupo: 'b', texto: 'x', importe: 10 }, { grupo: 'a', texto: 'y', importe: 5 },
    { grupo: 'a', texto: 'y', importe: 2.5 }, { grupo: 'a', texto: 'z', importe: 100 }, { grupo: 'c', texto: 'w', importe: 0 },
  ], { a: 'A', b: 'B' }, ['a', 'b']);
  assert.deepEqual(g.map((x) => [x.clave, x.texto, x.importe]), [['a', 'A', 107.5], ['b', 'B', 10]]);
  assert.deepEqual(g[0].detalle, [{ texto: 'z', importe: 100 }, { texto: 'y', importe: 7.5 }]);
  assert.equal(suma(g), 117.5);
});

test('el saldo estimado necesita un saldo cargado: no inventa el punto de partida', () => {
  assert.equal(estimarSaldo(null, 100, 50), null);
  assert.equal(estimarSaldo(1000, 250.5, 100.25), 1150.25);
  assert.equal(estimarSaldo(0, 0, 0), 0);
});

test('las fugas suman faltantes y sobrantes por separado', () => {
  assert.deepEqual(sumarFugas([{ faltantes: -625311.01, sobrantes: 0 }, { faltantes: -100, sobrantes: 50 }]), { faltantes: -625411.01, sobrantes: 50, neto: -625361.01 });
});

test('el cuadre del efectivo: lo que no da es «sin explicar»', () => {
  const { esperado, real, sinExplicar } = cuadrarEfectivo({ inicio: 11915000, fin: 11243600, entro: 29703469.8, salio: 23561276.59, aCuentas: 5755555, fugas: -1058038.21 });
  assert.equal(esperado, -671400);
  assert.equal(real, -671400);
  assert.equal(sinExplicar, 0);
  assert.equal(cuadrarEfectivo({ inicio: 100, fin: 50, entro: 0, salio: 0, aCuentas: 0, fugas: 0 }).sinExplicar, -50);
});

test('un pago es efectivo si sale en billetes (también el depósito y el efectivo que otro transfiere)', () => {
  assert.equal(esPagoEnEfectivo('efectivo', false), true);
  assert.equal(esPagoEnEfectivo('deposito', false), true);
  assert.equal(esPagoEnEfectivo('transferencia', true), true);
  assert.equal(esPagoEnEfectivo('transferencia', false), false);
  assert.equal(esPagoEnEfectivo('echeq', false), false);
  assert.equal(deDondeSalio({ medio: 'efectivo' }), 'Efectivo que no salió de ninguna caja');
  assert.equal(deDondeSalio({ medio: 'efectivo', deCf: true }), 'Efectivo de la caja central');
});
