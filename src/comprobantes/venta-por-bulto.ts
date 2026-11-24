/*
 * LA VENTA POR BULTO CERRADO CUANDO CAMBIA EL BULTO (0243, 24/11/2026, pedido
 * del dueño): la avena venía en bolsa de 30 kg y llegó en bolsa de 20. La
 * factura ya cambia el bulto del formato de compra junto con su costo (0108);
 * pero si una lista vende la bolsa CERRADA («unidades» = 30 kg en la mayorista),
 * seguiría cobrando 30 kg por una bolsa de 20. Las filas que quien carga eligió
 * pasan al bulto nuevo, y el comprobante guarda el cambio para deshacerlo si
 * se anula. Los paquetes fraccionados no se tocan: su costo sale del kilo.
 */

export type VentaPorBulto = { productoId: number; listaId: number; antes: number; despues: number };

const igual = (a: number, b: number) => Math.abs(a - b) < 0.0005;

/**
 * Qué filas de venta cambiar: las pedidas que todavía venden el bulto VIEJO.
 * `bultos`: por producto, el bulto del formato antes y después de la factura.
 * `filas`: el formato de venta del producto suelto (sin paquetes).
 * Devuelve los cambios y los errores (un pedido sin cambio de bulto que lo respalde).
 */
export function ventasACambiar(
  pedidas: { productoId: number; listas: number[] }[],
  bultos: Map<number, { antes: number; despues: number }>,
  filas: { productoId: number; listaId: number; unidades: number }[],
) {
  const cambios: VentaPorBulto[] = [];
  const errores: number[] = [];
  for (const p of pedidas) {
    const b = bultos.get(p.productoId);
    if (!b || igual(b.antes, b.despues)) { errores.push(p.productoId); continue; }
    const listas = new Set(p.listas);
    for (const f of filas) {
      if (f.productoId === p.productoId && listas.has(f.listaId) && igual(Number(f.unidades), b.antes)) {
        cambios.push({ productoId: p.productoId, listaId: f.listaId, antes: b.antes, despues: b.despues });
      }
    }
  }
  return { cambios, errores };
}
