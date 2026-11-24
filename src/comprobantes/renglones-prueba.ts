/*
 * LOS RENGLONES DE PRUEBA (0242, 24/11/2026, pedido del dueño): lo que se pide
 * poco, para probar, y no se da de alta en el catálogo. El renglón SUMA a la
 * factura —neto, IVA por alícuota, total y deuda: el papel tiene que cerrar y
 * el crédito fiscal es real— pero no es un producto: no entra al stock, no
 * toca costos ni aprende códigos. Queda guardado en el comprobante para que su
 * detalle explique el total.
 */

/** Cómo queda guardado: el neto ya bonificado y la alícuota que se le aplicó. */
export type RenglonPrueba = { descripcion: string; codigo: string; cantidad: number; neto: number; iva: number };

/** Solo la compra de mercadería los trae: la factura y la liquidación. */
export const TIPOS_CON_PRUEBA = new Set(['factura', 'liquidacion']);

type Entrada = { descripcion: string; codigo?: string; cantidad: number; neto: number; iva?: number };

/**
 * Los renglones de prueba como renglones más del pie (`armarPie`): así la
 * bonificación general y el IVA por alícuota les caen con la misma cuenta que
 * a los productos. La marca `prueba` es la que después los separa.
 */
export const comoRenglonesDelPie = (pruebas: Entrada[] = []) => pruebas.map((p) => ({
  cantidad: 1, costoUnitario: p.neto, iva: p.iva,
  prueba: { descripcion: p.descripcion.trim(), codigo: String(p.codigo ?? '').trim(), cantidad: p.cantidad },
}));

/** Separa lo que devolvió el pie: los productos (van a `comprobante_items`) y los de prueba (al comprobante). */
export function separarPruebas<T extends { prueba?: Omit<RenglonPrueba, 'neto' | 'iva'>; iva: number; subtotal: number }>(items: T[]) {
  return {
    productos: items.filter((it) => !it.prueba),
    pruebas: items.filter((it) => it.prueba).map((it): RenglonPrueba => ({ ...it.prueba!, neto: it.subtotal, iva: it.iva })),
  };
}
