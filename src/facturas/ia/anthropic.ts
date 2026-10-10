/**
 * LA LLAMADA A CLAUDE (API de Anthropic) — 0153, 9/10/2026.
 * ============================================================================
 * Un `fetch` y nada más (sin SDK): la misma forma que Mercado Pago o
 * CoffitCost. La clave vive SOLO en el servidor (`ANTHROPIC_API_KEY`, en
 * Dokploy); el navegador nunca la ve. Sin clave, la lectura con IA no corre y
 * la bandeja funciona como siempre (carga a mano).
 *
 * La respuesta se pide con FORMATO FIJO (`output_config.format` con un JSON
 * Schema): el modelo no puede devolver otra cosa que ese JSON.
 */

export const IA = {
  get clave() { return (process.env.ANTHROPIC_API_KEY || '').trim(); },
  get base() { return (process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com').trim().replace(/\/+$/, ''); },
  /** El modelo de todos los días (barato) y el de respaldo, si la cuenta no cierra. */
  get modeloRapido() { return (process.env.ANTHROPIC_MODELO_RAPIDO || 'claude-haiku-5-5').trim(); },
  get modeloFuerte() { return (process.env.ANTHROPIC_MODELO_FUERTE || 'claude-sonnet-5-5').trim(); },
  get configurado() { return !!this.clave; },
};

/** Tope de espera de una lectura: una factura de varias hojas puede tardar. */
const TIMEOUT_MS = 120_000;

export type Uso = { entrada: number; salida: number; cacheEscritura: number; cacheLectura: number };

export class ErrorIa extends Error {
  constructor(mensaje: string, readonly status = 0, readonly reintentable = false) { super(mensaje); }
}

/** El error de la API, dicho para el dueño. */
function explicar(status: number, cuerpo: any): ErrorIa {
  const msg = String(cuerpo?.error?.message ?? '');
  if (status === 401 || status === 403) return new ErrorIa('La clave de la IA no es válida o está dada de baja. Revisá ANTHROPIC_API_KEY en Dokploy.', status);
  if (/credit balance|billing/i.test(msg)) return new ErrorIa('La cuenta de Anthropic se quedó sin saldo: cargá crédito en la consola (platform.claude.com).', status);
  if (status === 429) return new ErrorIa('La IA está recibiendo demasiados pedidos: se reintenta en un rato.', status, true);
  if (status === 529 || status >= 500) return new ErrorIa('La IA está saturada o caída en este momento: se reintenta en un rato.', status, true);
  if (status === 413) return new ErrorIa('La factura es demasiado grande para mandarla de una vez.', status);
  return new ErrorIa(`La IA rechazó el pedido (${status}${msg ? `: ${msg.slice(0, 200)}` : ''}).`, status);
}

/**
 * Una llamada: `contenido` son los bloques del mensaje (páginas y texto) y
 * `esquema`, el JSON que tiene que volver. Devuelve el JSON ya parseado, el
 * uso de tokens y por qué cortó.
 */
export async function llamarIa(o: {
  modelo: string; sistema: string; contenido: any[]; esquema: object; maxTokens: number;
}): Promise<{ json: any; uso: Uso; corte: string }> {
  if (!IA.configurado) throw new ErrorIa('La lectura con IA no está configurada: falta ANTHROPIC_API_KEY en el servidor.');
  let res: Response;
  try {
    res = await fetch(`${IA.base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': IA.clave, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: o.modelo,
        max_tokens: o.maxTokens,
        system: o.sistema,
        messages: [{ role: 'user', content: o.contenido }],
        output_config: { format: { type: 'json_schema', schema: o.esquema } },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const t = /timeout|abort/i.test(String((e as Error)?.name) + String((e as Error)?.message));
    throw new ErrorIa(t ? 'La IA tardó demasiado en contestar: se reintenta en un rato.' : 'No se pudo conectar con la IA (¿sin internet en el servidor?).', 0, true);
  }
  const texto = await res.text();
  let cuerpo: any = null;
  try { cuerpo = JSON.parse(texto); } catch { /* cuerpo no JSON: se explica por el estado */ }
  if (!res.ok) throw explicar(res.status, cuerpo);

  const u = cuerpo?.usage ?? {};
  const uso: Uso = {
    entrada: Number(u.input_tokens) || 0,
    salida: Number(u.output_tokens) || 0,
    cacheEscritura: Number(u.cache_creation_input_tokens) || 0,
    cacheLectura: Number(u.cache_read_input_tokens) || 0,
  };
  const corte = String(cuerpo?.stop_reason ?? '');
  if (corte === 'refusal') throw Object.assign(new ErrorIa('La IA no quiso leer este archivo.'), { uso });
  const bloque = (cuerpo?.content ?? []).find((b: any) => b?.type === 'text');
  let json: any = null;
  try { json = JSON.parse(String(bloque?.text ?? '')); } catch {
    throw Object.assign(new ErrorIa(corte === 'max_tokens'
      ? 'La factura es tan larga que la respuesta no entró entera.'
      : 'La IA devolvió algo que no se pudo leer.'), { uso });
  }
  return { json, uso, corte };
}
