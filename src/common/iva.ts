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

/**
 * DE QUÉ IMPUESTO ES UNA PERCEPCIÓN (0132, Resultados IVA): la marcada manda;
 * sin marcar, se deduce del nombre como figura en la factura. «IVA» o las
 * resoluciones de percepción de IVA (RG 2408 / 3337 / 5329) → iva; «IIBB»,
 * «Ingresos Brutos», «DGR» → iibb; lo demás → otro.
 * La misma regla está escrita en SQL en `metricas/iva.ts` (TIPO_PERCEPCION_SQL).
 */
export const TIPOS_PERCEPCION = ['iva', 'iibb', 'otro'] as const;
export type TipoPercepcion = (typeof TIPOS_PERCEPCION)[number];
export function tipoPercepcion(tipo: unknown, nombre: unknown): TipoPercepcion {
  const t = String(tipo ?? '').trim().toLowerCase();
  if ((TIPOS_PERCEPCION as readonly string[]).includes(t)) return t as TipoPercepcion;
  const n = String(nombre ?? '').toLowerCase();
  if (/(^|[^a-z])iva([^a-z]|$)|rg\s*(2408|3337|5329)/.test(n)) return 'iva';
  if (/iibb|ingresos\s*brutos|(^|[^a-z])dgr([^a-z]|$)|(^|[^a-z])ib([^a-z]|$)/.test(n)) return 'iibb';
  return 'otro';
}
