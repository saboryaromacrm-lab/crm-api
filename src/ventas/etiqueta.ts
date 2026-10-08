/**
 * El NOMBRE de un comprobante del sistema, en un archivo sin dependencias: lo
 * usan las ventas y Gerencia › Auditoría, y la auditoría no puede importar el
 * módulo de ventas (que a través de la caja ya depende de ella).
 */

/** ¿Este comprobante RESTA en vez de sumar? Las notas de crédito, y solo ellas. */
export const esNotaCredito = (tipo: string) => String(tipo ?? '').startsWith('nota_credito');

/** La letra de un comprobante del sistema: 'factura_b' → 'B'. */
export const letraDe = (tipo: string) => {
  const m = /_([abc])$/.exec(String(tipo ?? ''));
  return m ? (m[1].toUpperCase() as 'A' | 'B' | 'C') : null;
};

/** "Factura B 0003-00000042", para mensajes y rastros. */
export const etiquetaVenta = (v: { tipo: string; puntoVenta: string; numero: number | null }) => {
  const nombre = v.tipo === 'ticket' ? 'Ticket'
    : v.tipo === 'nota_credito_ticket' ? 'Devolución'
      : `${esNotaCredito(v.tipo) ? 'Nota de crédito' : String(v.tipo).startsWith('nota_debito') ? 'Nota de débito' : 'Factura'} ${letraDe(v.tipo) ?? ''}`.trim();
  return `${nombre} ${v.puntoVenta}-${String(v.numero ?? 0).padStart(8, '0')}`;
};
