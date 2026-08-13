/**
 * LAS ALÍCUOTAS DE IVA QUE EXISTEN EN ARGENTINA
 * ============================================================================
 * Una sola lista para todo el sistema. Estaba escrita solo en `productos`, así
 * que el alta de un COMPROBANTE aceptaba cualquier número: un `iva: 300` en el
 * renglón entraba tal cual, inflaba el total y ensuciaba el libro de IVA
 * compras — el mismo campo, validado en un lado y no en el otro.
 *
 * No es una lista de configuración: son las alícuotas de la ley. Si alguna vez
 * cambia, cambia acá y en ningún otro lugar.
 */
export const ALICUOTAS_IVA = [0, 2.5, 5, 10.5, 21, 27] as const;

/** Para los mensajes de error: "0, 2.5, 5, 10.5, 21, 27%". */
export const ALICUOTAS_TEXTO = ALICUOTAS_IVA.join(', ');

export const esAlicuotaValida = (n: unknown): boolean =>
  ALICUOTAS_IVA.includes(Number(n) as (typeof ALICUOTAS_IVA)[number]);
