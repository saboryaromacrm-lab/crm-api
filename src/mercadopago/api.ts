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
  const detalles = Array.isArray(d.errors) ? d.errors.flatMap((e: any) => (Array.isArray(e?.details) ? e.details : [])).filter((x: any) => typeof x === 'string') : [];
  const base = [d.message, ...errs, ...causas, ...detalles].filter(Boolean).join(' · ') || d.error || '';
  // Si Mercado Pago solo dice "error validating payload", mostramos lo que contestó para poder corregirlo.
  if (typeof d === 'object' && /validating payload/i.test(base) && !detalles.length) return `${base} [${JSON.stringify(d).slice(0, 400)}]`;
  return base;
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
  /*
   * LA SEGUNDA VÍA (3/10/2026): los PAGOS de la cuenta, no la orden. Si la
   * orden no dice que se pagó (o no se puede consultar), se busca el pago por
   * su referencia; y la caja puede buscar los pagos aprobados por el monto.
   *   GET /v1/payments/search   ?external_reference / range+begin_date (NOW-xHOURS)
   *   GET /v1/payments/{id}     un pago, para verificarlo antes de usarlo
   */
  buscarPagos: (filtros: Record<string, string>) => llamar<{ results?: any[] }>('GET', `/v1/payments/search?${new URLSearchParams(filtros).toString()}`),
  pago: (id: string) => llamar('GET', `/v1/payments/${encodeURIComponent(id)}`),
};

/**
 * ¿LA ORDEN ESTÁ PAGA? `processed` es lo que documenta Mercado Pago para un QR
 * pagado; además se acepta `status_detail: accredited` o pagos acreditados que
 * cubran el monto (por si el estado de arriba tarda o cambia de nombre).
 * Devuelve el id del pago, o null si no está paga.
 */
export function pagoDeOrden(orden: any, monto: number): { pagado: boolean; paymentId: string } {
  const estado = String(orden?.status ?? '').toLowerCase();
  const detalle = String(orden?.status_detail ?? '').toLowerCase();
  const pagos: any[] = Array.isArray(orden?.transactions?.payments) ? orden.transactions.payments : [];
  const acreditados = pagos.filter((p) => /processed|approved|accredited/i.test(`${p?.status ?? ''} ${p?.status_detail ?? ''}`)
    && !/refund/i.test(`${p?.status ?? ''} ${p?.status_detail ?? ''}`));
  const sumaAcreditada = acreditados.reduce((a, p) => a + (Number(p?.paid_amount ?? p?.amount) || 0), 0);
  const pago = acreditados[0] ?? pagos[0];
  const pagado = !/refund|cancel|expired|failed/.test(estado)
    && (estado === 'processed' || detalle === 'accredited' || (acreditados.length > 0 && sumaAcreditada + 0.01 >= monto));
  return { pagado, paymentId: String(pago?.id ?? '') };
}

/**
 * CON QUÉ PAGÓ EL CLIENTE (3/10/2026, pedido del dueño): el resumen de un
 * cobro para el listado de ventas. Sale del pago "clásico" (`GET
 * /v1/payments/{id}`, el que trae comisiones y neto) y, si no se pudo leer,
 * de lo que dice el pago dentro de la orden (tipo y cuotas, sin comisiones).
 *
 *   tipo            account_money | debit_card | credit_card | prepaid_card | …
 *   cuotas          1 = un pago
 *   comision        lo que Mercado Pago le descontó AL COMERCIO (fee_payer
 *                   collector): comisión y, si hay, el costo de las cuotas sin interés
 *   interesCliente  lo que pagó de más el cliente por las cuotas (fee_payer payer)
 *   neto            lo que le quedó al comercio
 */
export function resumenPago(clasico: any, deOrden: any, monto: number) {
  const n = (x: any) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  if (clasico) {
    const fees: any[] = Array.isArray(clasico.fee_details) ? clasico.fee_details : [];
    const del = (quien: string) => fees.filter((f) => String(f?.fee_payer ?? 'collector') === quien).reduce((a, f) => a + n(f?.amount), 0);
    const comision = r2(del('collector'));
    const td = clasico.transaction_details ?? {};
    const total = r2(n(td.total_paid_amount) || n(clasico.transaction_amount) || monto);
    const interes = r2(Math.max(del('payer'), total - (n(clasico.transaction_amount) || monto)));
    return {
      tipo: String(clasico.payment_type_id ?? ''),
      metodo: String(clasico.payment_method_id ?? ''),
      cuotas: Math.max(1, Math.round(n(clasico.installments) || 1)),
      comision,
      interesCliente: interes > 0.009 ? interes : 0,
      neto: r2(n(td.net_received_amount) || ((n(clasico.transaction_amount) || monto) - comision)),
      total,
      completo: true,
    };
  }
  if (deOrden) {
    const pm = deOrden.payment_method ?? {};
    return {
      tipo: String(pm.type ?? ''),
      metodo: String(pm.id ?? ''),
      cuotas: Math.max(1, Math.round(n(pm.installments) || 1)),
      comision: null as number | null,
      interesCliente: 0,
      neto: null as number | null,
      total: r2(n(deOrden.paid_amount) || n(deOrden.amount) || monto),
      completo: false,
    };
  }
  return null;
}

/** Un pago de la búsqueda, ¿sirve para un cobro de `monto`? Aprobado, por ese monto y sin devolver. */
export function pagoSirve(p: any, monto: number): boolean {
  return String(p?.status ?? '') === 'approved'
    && Math.abs((Number(p?.transaction_amount) || 0) - monto) <= 0.01
    && !(Number(p?.transaction_amount_refunded) > 0);
}

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
