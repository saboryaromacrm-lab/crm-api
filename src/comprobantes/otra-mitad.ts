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

/*
 * LAS MITADES SIN CARGAR (25/11/2026, pedido del dueño: «si cargo solo la
 * factura A y me olvido de la X, ¿cómo me entero?»). El costo no lo nota (lo
 * mezcla el «Sin factura %» del formato), pero la mercadería, la deuda y la
 * parte sin factura del IVA quedan con la mitad. El recordatorio al cargar se
 * ve una sola vez: esto lista lo que sigue sin su otra mitad.
 */
export type PapelMitad = { id: number; proveedorId: number; tipo: string; letra?: string | null; dia: string };

const diaNumero = (dia: string) => Math.round(Date.parse(`${dia}T00:00:00Z`) / 86_400_000);

/**
 * Los papeles (factura A o liquidación) desde `desde` (AAAA-MM-DD, día de
 * Argentina) sin un papel de la otra mitad del mismo proveedor a ±7 días.
 * `papeles` tiene que traer también los de los 7 días anteriores a `desde`,
 * para que un papel del borde encuentre su pareja.
 */
export function sinSuOtraMitad<T extends PapelMitad>(papeles: T[], desde: string): T[] {
  const porProveedor = new Map<number, { tipo: string; dia: number }[]>();
  for (const p of papeles) {
    const tipo = tipoDeLaOtraMitad(p.tipo, p.letra) ? p.tipo : null;
    if (!tipo) continue;
    const l = porProveedor.get(p.proveedorId) ?? [];
    l.push({ tipo, dia: diaNumero(p.dia) });
    porProveedor.set(p.proveedorId, l);
  }
  const d0 = diaNumero(desde);
  return papeles.filter((p) => {
    if (!tipoDeLaOtraMitad(p.tipo, p.letra) || diaNumero(p.dia) < d0) return false;
    const dia = diaNumero(p.dia);
    return !(porProveedor.get(p.proveedorId) ?? [])
      .some((o) => o.tipo !== p.tipo && Math.abs(o.dia - dia) <= VENTANA_OTRA_MITAD);
  });
}
