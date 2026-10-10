/**
 * ¿CIERRA LA CUENTA? (0153) — el control que hace confiable a la lectura.
 * ============================================================================
 * Una factura se verifica sola. Si lo que transcribió la IA cierra en los
 * tres niveles, la transcripción está DEMOSTRADA; si algo no cierra, se
 * reintenta con el modelo fuerte y, si sigue sin cerrar, se marca en amarillo
 * qué renglón o qué total mirar:
 *
 *   1. cada renglón: cantidad × precio × (1 − descuentos) = importe;
 *   2. la suma de los renglones = el subtotal impreso (antes o después de la
 *      bonificación general: los papeles hacen las dos cosas);
 *   3. subtotal − bonificación + IVA + percepciones + impuestos = total.
 *   Y si el papel trajo QR, su total manda: el leído tiene que coincidir.
 *
 * OJO: controla PLATA, no CANTIDADES (`1 × $12.000` y `12 × $1.000` cierran
 * igual): eso lo cuida el alta comparando contra el costo histórico.
 */
import type { LecturaIa, RenglonIa } from './lectura';

const r2 = (n: number) => Math.round(n * 100) / 100;
/** Lo que queda de un precio después de descuentos sucesivos (10 + 5 → 0,855). */
export const factorDescuentos = (ds: number[]) => ds.reduce((f, d) => f * (1 - d / 100), 1);
/** Un solo % equivalente a los sucesivos (10 + 5 → 14,5). */
export const descuentoEquivalente = (ds: number[]) => r2((1 - factorDescuentos(ds)) * 100);

/** Tolerancias: precios impresos redondeados a 2 decimales en cantidades grandes. */
const tolRenglon = (importe: number) => Math.max(0.5, Math.abs(importe) * 0.005);
const tolTotal = (total: number) => Math.max(2, Math.abs(total) * 0.001);
const pesos = (n: number) => `$${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function renglonCierra(r: RenglonIa) {
  if (!(r.precioUnitario > 0) || !(r.cantidad > 0)) return true; // sin precio impreso (remito) no hay qué controlar
  return Math.abs(r.cantidad * r.precioUnitario * factorDescuentos(r.descuentos) - r.importe) <= tolRenglon(r.importe);
}

export function controlar(l: Pick<LecturaIa, 'renglones' | 'pie' | 'encabezado'>, totalQr = 0) {
  const problemas: string[] = [];
  const renglonesMal: number[] = [];
  l.renglones.forEach((r, i) => { if (!renglonCierra(r)) renglonesMal.push(i); });
  if (renglonesMal.length) {
    problemas.push(`${renglonesMal.length} ${renglonesMal.length === 1 ? 'renglón no da' : 'renglones no dan'} cantidad × precio = importe.`);
  }
  const p = l.pie;
  const suma = r2(l.renglones.reduce((a, r) => a + r.importe, 0));
  const bonif = p.bonificacionImporte > 0 ? p.bonificacionImporte : r2(suma * p.bonificacionPct / 100);
  const impuestos = r2(p.ivas.reduce((a, x) => a + x.importe, 0) + p.percepciones.reduce((a, x) => a + x.importe, 0) + p.impuestosInternos + p.otrosImpuestos);
  const esRemito = l.encabezado.tipo === 'remito';

  if (!l.renglones.length) problemas.push('No se leyó ningún renglón.');
  /* 2: la suma contra el subtotal impreso (con o sin la bonificación descontada). */
  if (p.subtotal > 0 && l.renglones.length) {
    const ok = Math.abs(suma - p.subtotal) <= tolTotal(p.subtotal) || Math.abs(suma - bonif - p.subtotal) <= tolTotal(p.subtotal);
    if (!ok) problemas.push(`La suma de los renglones (${pesos(suma)}) no da el subtotal impreso (${pesos(p.subtotal)}).`);
  }
  /* 3: el total armado contra el total impreso. */
  let totalCalculado: number | null = null;
  if (p.total > 0 && !esRemito) {
    const base = p.subtotal > 0 ? p.subtotal : suma;
    const opciones = [r2(base - bonif + impuestos), r2(base + impuestos)];
    totalCalculado = opciones.find((t) => Math.abs(t - p.total) <= tolTotal(p.total)) ?? opciones[0];
    if (Math.abs(totalCalculado - p.total) > tolTotal(p.total)) {
      problemas.push(`Subtotal − bonificación + impuestos da ${pesos(totalCalculado)} y el total impreso es ${pesos(p.total)}.`);
    }
  } else if (!esRemito) problemas.push('No se leyó el total.');
  /* El QR es exacto: si lo hay, el total leído tiene que ser ese. */
  if (totalQr > 0 && p.total > 0 && Math.abs(p.total - totalQr) > 1) {
    problemas.push(`El total leído (${pesos(p.total)}) no es el del QR de la factura (${pesos(totalQr)}).`);
  }
  return { cierra: problemas.length === 0, problemas, renglonesMal, suma, totalCalculado };
}
