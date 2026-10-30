/*
 * CON QUÉ MEDIOS SE PUEDE PAGAR UN DESCUENTO CON NOMBRE (0208, 30/10/2026).
 *
 * Antes era UN medio («Solo con Efectivo»); ahora es una lista («Efectivo o
 * Transferencia»), guardada separada por comas como en los cupones. La regla
 * del candado sigue igual: al contado y NINGÚN pago fuera de la lista. Repartir
 * entre medios de la lista está bien (mitad efectivo, mitad transferencia): los
 * dos son medios que el dueño aceptó para ese descuento.
 */

/** El orden en que se guardan y se nombran: el mismo de la caja. */
export const ORDEN_MEDIOS = [
  'efectivo', 'transferencia', 'transferencia_proveedor', 'tarjeta_debito', 'tarjeta_credito', 'cheque', 'qr', 'otro',
] as const;

const LEGIBLE: Record<string, string> = {
  efectivo: 'efectivo',
  transferencia: 'transferencia',
  transferencia_proveedor: 'transferencia a proveedor',
  tarjeta_debito: 'tarjeta de débito',
  tarjeta_credito: 'tarjeta de crédito',
  cheque: 'cheque',
  qr: 'QR / billetera',
  otro: 'otro',
};

/** Los medios de un descuento. Lee la columna vieja si la nueva está vacía (filas de antes de 0208 sin migrar). */
export function mediosDeDescuento(d: { mediosPago?: string | null; medioPago?: string | null }): string[] {
  const lista = String(d.mediosPago ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  if (lista.length) return normalizarMedios(lista);
  return d.medioPago ? [d.medioPago] : [];
}

/** Sin repetidos, solo conocidos y en el orden de la caja. */
export function normalizarMedios(lista: readonly string[]): string[] {
  const set = new Set(lista.map((m) => String(m).trim()));
  return ORDEN_MEDIOS.filter((m) => set.has(m));
}

/** «efectivo o transferencia». */
export const mediosLegibles = (medios: readonly string[]) => {
  const n = medios.map((m) => LEGIBLE[m] ?? m);
  return n.length > 1 ? `${n.slice(0, -1).join(', ')} o ${n[n.length - 1]}` : (n[0] ?? '');
};

/** El primer pago con plata que NO es de la lista (null = todos cumplen). */
export function pagoFueraDeLista(permitidos: readonly string[], pagos: readonly { medio: string; importe: unknown }[] | null | undefined) {
  return (pagos ?? []).find((p) => Number(p.importe) > 0 && !permitidos.includes(p.medio)) ?? null;
}
