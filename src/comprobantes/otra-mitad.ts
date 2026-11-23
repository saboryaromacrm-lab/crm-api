/*
 * LA OTRA MITAD DE UNA COMPRA MITAD Y MITAD (21/11/2026).
 *
 * El proveedor que entrega la mitad con factura A y la otra mitad sin factura
 * (liquidación) cobra, casi siempre, el MISMO neto en los dos papeles: el
 * «Sin factura %» del formato hace la mezcla. Cuando no es así (la mitad sin
 * factura viene con el IVA adentro, o a otra lista), cada papel pisa el costo
 * del otro y gana el último que se carga. Para avisarlo, al cargar un papel se
 * busca su otra mitad cerca de la fecha y se compara el neto por unidad.
 */

/** Días alrededor de la fecha del papel en los que se busca la otra mitad. */
export const VENTANA_OTRA_MITAD = 7;

/** Qué papel es la otra mitad del que se carga: la factura A ↔ la liquidación. B y C no (su precio trae el IVA). */
export function tipoDeLaOtraMitad(tipo: string, letra?: string | null): 'factura' | 'liquidacion' | null {
  if (tipo === 'liquidacion') return 'factura';
  if (tipo === 'factura' && letra === 'A') return 'liquidacion';
  return null;
}

export type RenglonMitad = { comprobanteId: number; productoId: number; cantidad: number; subtotal: number };

/**
 * El neto por unidad (o kg) que pagó cada producto en la otra mitad: el
 * subtotal del renglón ya trae el descuento y la bonificación, y la cantidad
 * está en unidades del stock. Cuenta el papel más cercano a la fecha
 * (`papeles` viene en ese orden); varios renglones del mismo producto en ese
 * papel se juntan.
 */
export function netoPorProducto(papeles: number[], renglones: RenglonMitad[]) {
  const out = new Map<number, { netoUnitario: number; comprobanteId: number }>();
  for (const id of papeles) {
    const delPapel = new Map<number, { cantidad: number; neto: number }>();
    for (const r of renglones) {
      if (r.comprobanteId !== id || out.has(r.productoId)) continue;
      const a = delPapel.get(r.productoId) ?? { cantidad: 0, neto: 0 };
      a.cantidad += Number(r.cantidad) || 0;
      a.neto += Number(r.subtotal) || 0;
      delPapel.set(r.productoId, a);
    }
    for (const [productoId, a] of delPapel) {
      if (a.cantidad > 0 && a.neto > 0) {
        out.set(productoId, { netoUnitario: Math.round((a.neto / a.cantidad) * 10000) / 10000, comprobanteId: id });
      }
    }
  }
  return out;
}
