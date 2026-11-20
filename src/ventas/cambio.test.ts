import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saldoDelCambio } from './cambio';

test('lo que le queda a un cambio: total menos lo usado menos lo devuelto', () => {
  const nc = { total: 18480, cambioEfectivo: 0, cambioMedio: 0 };
  assert.equal(saldoDelCambio({ ...nc, usado: 0 }), 18480);
  // Se llevó más: la nota se usa entera y el cliente paga la diferencia.
  assert.equal(saldoDelCambio({ ...nc, usado: 18480 }), 0);
  // Se llevó menos: el sobrante se devuelve en el acto y no queda nada.
  assert.equal(saldoDelCambio({ ...nc, usado: 10000, cambioMedio: 8480 }), 0);
  assert.equal(saldoDelCambio({ ...nc, usado: 10000, cambioEfectivo: 8480 }), 0);
  // La venta del cambio se anuló: lo usado deja de contar y vuelve a quedar todo.
  assert.equal(saldoDelCambio({ ...nc, usado: 0, cambioEfectivo: 0 }), 18480);
  // Nunca negativo, y sin arrastre de flotantes.
  assert.equal(saldoDelCambio({ total: 0.3, usado: 0.1, cambioEfectivo: 0.2, cambioMedio: 0 }), 0);
  assert.equal(saldoDelCambio({ total: 100, usado: 150, cambioEfectivo: 0, cambioMedio: 0 }), 0);
});
