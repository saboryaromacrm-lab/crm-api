/**
 * MERCADERÍA QUE LLEGÓ Y SU FACTURA NO SE CARGÓ (7/11/2026, pedido del dueño:
 * «avisá a admin y superadmin cuando llega mercadería de un proveedor —tomalo
 * de la tarjeta de Pedidos— y no se cargó su factura, así sabemos qué facturas
 * faltan cargar»).
 *
 * La regla, pura: cada tarjeta en «Recibido» necesita SU comprobante que entró
 * stock (factura, remito o liquidación con recepción) de ese proveedor, cargado
 * o fechado desde que se le pidió. Uno a uno: si llegaron dos entregas y se
 * cargó una sola factura, la que queda sin pareja es la más nueva — una
 * factura no tapa dos entregas.
 */

/** La factura puede venir unos días antes de que se mueva la tarjeta a «Pedido». */
export const MARGEN_DIAS = 2;
const DIA_MS = 86_400_000;

export interface Recibida { id: number; proveedorId: number; fechaPedido: Date | null; fechaRecepcion: Date }
/** `en`: la fecha más tardía entre la del papel y la de carga. */
export interface Carga { proveedorId: number; en: Date }

/** Desde cuándo un comprobante le sirve a la tarjeta. */
export function desdeDe(r: Recibida): number {
  const pedido = r.fechaPedido ? Math.min(r.fechaPedido.getTime(), r.fechaRecepcion.getTime()) : r.fechaRecepcion.getTime();
  return pedido - MARGEN_DIAS * DIA_MS;
}

/** Las tarjetas sin comprobante, en el orden en que llegaron. */
export function sinFactura<T extends Recibida>(recibidas: T[], cargas: Carga[]): T[] {
  /* Por proveedor, sus comprobantes del más viejo al más nuevo, y un puntero al primero sin usar. */
  const porProv = new Map<number, { en: number[]; j: number }>();
  for (const c of [...cargas].sort((a, b) => a.en.getTime() - b.en.getTime())) {
    const p = porProv.get(c.proveedorId) ?? { en: [], j: 0 };
    p.en.push(c.en.getTime());
    porProv.set(c.proveedorId, p);
  }
  const faltan: T[] = [];
  for (const t of [...recibidas].sort((a, b) => desdeDe(a) - desdeDe(b) || a.id - b.id)) {
    const p = porProv.get(t.proveedorId) ?? { en: [], j: 0 };
    /* Los anteriores a esta tarjeta tampoco le sirven a las que siguen (arrancan más tarde). */
    while (p.j < p.en.length && p.en[p.j] < desdeDe(t)) p.j++;
    if (p.j < p.en.length) p.j++;
    else faltan.push(t);
  }
  return faltan.sort((a, b) => a.fechaRecepcion.getTime() - b.fechaRecepcion.getTime() || a.id - b.id);
}
