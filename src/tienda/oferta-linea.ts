/**
 * LO QUE VALE UN RENGLÓN CON UNA PROMO DE VARIAS UNIDADES (16/10/2026, pedido
 * del dueño: «el 3×2 tiene que cobrarse como 3×2»). Antes el sitio mostraba el
 * cartel y cobraba todo a precio lleno.
 *
 *   · nxm («3×2»): de cada grupo de `lleva` se pagan `paga`; lo que sobra, entero.
 *   · segunda_unidad («2ª al 50%»): cada par, la segunda con su descuento.
 *   · pack («3 x $1.000»): cada grupo de `lleva` a `precioPack`; lo que sobra, entero.
 *
 * `precioUnidad` es el precio FINAL de una unidad sin la promo; `unidades`, las
 * que lleva el renglón contadas como las cuenta la caja (una caja x6 son 6).
 *
 * Misma cuenta en el sitio (`saboryaroma-web/src/lib/oferta.ts`): duplicada
 * porque son proyectos separados, no porque la regla cambie.
 */
export type OfertaMulti = { tipo: string; lleva?: number; paga?: number; porcentaje?: number; precioPack?: number };

export const MULTI_UNIDAD = new Set(['nxm', 'segunda_unidad', 'pack']);

const money = (n: number) => Math.round(n * 100) / 100;

export function totalConOferta(o: OfertaMulti, precioUnidad: number, unidades: number): number {
  const lleno = precioUnidad * unidades;
  if (o.tipo === 'nxm' && (o.lleva ?? 0) > (o.paga ?? 0) && (o.paga ?? 0) > 0) {
    const grupos = Math.floor(unidades / o.lleva!);
    return money((grupos * o.paga! + (unidades - grupos * o.lleva!)) * precioUnidad);
  }
  if (o.tipo === 'segunda_unidad' && (o.porcentaje ?? 0) > 0) {
    const pares = Math.floor(unidades / 2);
    return money(lleno - pares * precioUnidad * Math.min(100, o.porcentaje!) / 100);
  }
  if (o.tipo === 'pack' && (o.lleva ?? 0) > 1 && (o.precioPack ?? 0) > 0) {
    const grupos = Math.floor(unidades / o.lleva!);
    /* Un pack más caro que las unidades sueltas no se aplica: nunca cobra de más. */
    return money(Math.min(lleno, grupos * o.precioPack! + (unidades - grupos * o.lleva!) * precioUnidad));
  }
  return money(lleno);
}
