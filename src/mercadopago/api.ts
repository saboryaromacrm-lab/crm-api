/**
 * MERCADO PAGO — LAS LLAMADAS (0126, 30/9/2026)
 * ============================================================================
 * `fetch` pelado contra la API de Mercado Pago, igual que ARCA: son pocas
 * llamadas conocidas y un SDK no aporta nada.
 *
 *   GET  /users/me                    quién es la cuenta (su user_id)
 *   POST /users/{user_id}/stores      alta de una sucursal
 *   POST /v2/pos                      alta de una caja (devuelve su QR fijo)
 *   POST /v1/orders                   el cobro: el monto va al QR de la caja
 *   GET  /v1/orders/{id}              cómo está el cobro (la verdad, siempre)
 *   POST /v1/orders/{id}/cancel       anular un cobro que nadie pagó
 *
 * Variables del servidor (Dokploy): `MP_ACCESS_TOKEN` (el de PRODUCCIÓN de la
 * aplicación) y `MP_WEBHOOK_SECRET` (la clave de los avisos). `MP_API_URL`
 * solo para pruebas (un Mercado Pago simulado). Nunca se muestran.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const MP = {
  get token(): string { return (process.env.MP_ACCESS_TOKEN || '').trim(); },
  get secreto(): string { return (process.env.MP_WEBHOOK_SECRET || '').trim(); },
  get base(): string { return (process.env.MP_API_URL || 'https://api.mercadopago.com').replace(/\/+$/, ''); },
  get configurado(): boolean { return !!this.token; },
};

/** Un error de Mercado Pago, con el estado HTTP y lo que contestó. */
export class ErrorMp extends Error {
  constructor(message: string, readonly status?: number, readonly datos?: unknown) {
    super(message);
    this.name = 'ErrorMp';
  }
}

/** Lo que dice Mercado Pago cuando algo sale mal, legible. */
function motivoDe(d: any): string {
  if (!d) return '';
  const errs = Array.isArray(d.errors) ? d.errors.map((e: any) => e?.message || e?.code).filter(Boolean) : [];
  const causas = Array.isArray(d.cause) ? d.cause.map((c: any) => c?.description || c?.code).filter(Boolean) : [];
  return [d.message, ...errs, ...causas].filter(Boolean).join(' · ') || d.error || '';
}

async function llamar<T = any>(metodo: string, ruta: string, cuerpo?: unknown, idempotencia?: string): Promise<T> {
  if (!MP.token) throw new ErrorMp('Mercado Pago no está configurado: falta MP_ACCESS_TOKEN en el servidor.');
  let res: Response;
  try {
    res = await fetch(`${MP.base}${ruta}`, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${MP.token}`,
        'Content-Type': 'application/json',
        ...(idempotencia ? { 'X-Idempotency-Key': idempotencia } : {}),
      },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new ErrorMp(`No se pudo contactar a Mercado Pago (${(e as Error).message}).`);
  }
  const texto = await res.text();
  let datos: any = null;
  try { datos = texto ? JSON.parse(texto) : null; } catch { datos = texto; }
  if (!res.ok) {
    throw new ErrorMp(`Mercado Pago respondió ${res.status}${motivoDe(datos) ? `: ${motivoDe(datos)}` : ''}.`, res.status, datos);
  }
  return datos as T;
}

export const mp = {
  yo: () => llamar<{ id: number; nickname?: string; site_id?: string }>('GET', '/users/me'),
  crearSucursal: (userId: number | string, cuerpo: unknown) => llamar('POST', `/users/${userId}/stores`, cuerpo),
  crearCaja: (cuerpo: unknown, idempotencia: string) => llamar('POST', '/v2/pos', cuerpo, idempotencia),
  crearOrden: (cuerpo: unknown, idempotencia: string) => llamar('POST', '/v1/orders', cuerpo, idempotencia),
  orden: (id: string) => llamar('GET', `/v1/orders/${encodeURIComponent(id)}`),
  cancelarOrden: (id: string, idempotencia: string) => llamar('POST', `/v1/orders/${encodeURIComponent(id)}/cancel`, undefined, idempotencia),
};

/** Importe como lo pide la API de Orders: texto con dos decimales ("1234.50"). */
export const importeMp = (n: number) => (Math.round(Number(n) * 100) / 100).toFixed(2);

/**
 * LA FIRMA DEL AVISO. Mercado Pago manda `x-signature: ts=…,v1=…` y
 * `x-request-id`; `v1` es un HMAC-SHA256 (hex) con la clave secreta sobre
 * `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` (lo que falte, no va).
 * El `data.id` alfanumérico va en minúsculas; se prueba también tal cual.
 *
 * No es lo único que protege: el ERP NUNCA cierra una venta por lo que dice el
 * aviso, sino por lo que devuelve `GET /v1/orders/{id}` con su propio token.
 */
export function firmaValida(firma: string | undefined, requestId: string | undefined, dataId: string | undefined): boolean {
  if (!MP.secreto || !firma) return false;
  const partes = Object.fromEntries(String(firma).split(',').map((p) => p.trim().split('=').map((x) => x.trim())));
  const ts = partes.ts; const v1 = partes.v1;
  if (!ts || !v1) return false;
  const candidatos = [...new Set([dataId, dataId?.toLowerCase()].filter((x) => x !== undefined))] as string[];
  if (!candidatos.length) candidatos.push('');
  return candidatos.some((id) => {
    const manifiesto = `${id ? `id:${id};` : ''}${requestId ? `request-id:${requestId};` : ''}ts:${ts};`;
    const esperado = createHmac('sha256', MP.secreto).update(manifiesto).digest('hex');
    const a = Buffer.from(esperado); const b = Buffer.from(String(v1));
    return a.length === b.length && timingSafeEqual(a, b);
  });
}
