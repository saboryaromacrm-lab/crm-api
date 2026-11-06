/**
 * ¿EL PRESUPUESTO TODAVÍA GARANTIZA SU PRECIO? (6/11/2026, decisión del dueño)
 *
 * El vencimiento es el plazo que tiene el CLIENTE para decir que sí:
 *
 *   · borrador  → nada prometido todavía: precio de hoy.
 *   · enviado   → precio garantizado hasta el vencimiento. Vencido no se
 *                 confirma (se reabre y se re-cotiza con los precios de hoy).
 *   · confirmado → el cliente ya dijo que sí DENTRO del plazo y la casa apartó
 *                 la mercadería: el trato está cerrado. El precio vale hasta que
 *                 se cobre o se cancele, aunque la fecha del papel haya pasado.
 *                 Antes se le quitaba al pasar la fecha y el cajero quedaba
 *                 trabado con «hace falta el permiso para pisar precios» sobre un
 *                 pedido que la casa ya había firmado.
 *
 * Lo que impide que un precio viejo viva para siempre no es el reloj sino el
 * ESTADO: un confirmado se cierra en la caja o se cancela a mano. Para que no
 * quede olvidado, Presupuestos marca el confirmado que pasó su fecha.
 */
export function garantizaPrecio(pre: { estado?: string | null }): boolean {
  return pre?.estado === 'confirmado';
}
