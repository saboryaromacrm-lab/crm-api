/**
 * SEGÚN MERCADO PAGO (19/11/2026, pedido del dueño: «distinguir bien si
 * pagaron por el QR del mostrador o por el QR del posnet»). Cada renglón de
 * pago de una venta, con lo que Mercado Pago dijo de ese cobro:
 *
 *   · si está atado en Ventas › Conciliación MP: el o los pagos de Mercado
 *     Pago (de dónde vino —el QR de una caja, el Point, fuera del local—, con
 *     qué pagó el cliente y el número de operación), o que se marcó «No entró»;
 *   · si todavía no está atado pero se cobró con el botón QR del ERP: ese cobro
 *     es SIEMPRE el QR de una caja del mostrador, y se sabe de cuál.
 *
 * Sin comisión ni nombre de quien pagó: el detalle de la venta lo ve el cajero.
 */

export type MpPagoDelRenglon = {
  id: string;
  estado: string;
  /** 'qr' = QR de una caja del local · 'tarjeta' = el Point (posnet) · 'transferencia' = fuera del local. */
  familia: string;
  tipo: string;
  metodo: string;
  cuotas: number;
  bruto: number;
  devuelto: number;
  caja: string | null;
};

export type MpDelRenglon = {
  /** null = no está atado en la Conciliación (lo que se sabe sale del cobro con QR del ERP). */
  atado: 'auto' | 'manual' | 'sin_mp' | null;
  motivo: string;
  /** El medio que tenía el renglón antes de que la Conciliación lo corrigiera; null = no se corrigió. */
  medioAnterior: string | null;
  pagos: MpPagoDelRenglon[];
};

/** Una fila de la consulta de atados (un renglón × un pago de MP; sin pago si se marcó «No entró»). */
export type FilaAtado = {
  ventaPagoId: number; atado: string; motivo: string | null; medioAnterior: string | null;
  id: string | null; estado: string | null; familia: string | null; tipo: string | null; metodo: string | null;
  cuotas: number | null; bruto: number | null; devuelto: number | null; caja: string | null;
};
/** Un cobro con el QR del ERP (mp_cobros pagado). */
export type CobroQr = { paymentId: string; orderId: string | null; info: any; caja: string | null; monto: number };

const num = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0);

export function mpDeLosRenglones(
  pagos: { id: number; medio: string; referencia: string; importe: number }[],
  atados: FilaAtado[],
  cobrosQr: CobroQr[],
): Map<number, MpDelRenglon> {
  const res = new Map<number, MpDelRenglon>();
  for (const f of atados) {
    const r = res.get(f.ventaPagoId) ?? {
      atado: (['auto', 'manual', 'sin_mp'].includes(f.atado) ? f.atado : 'manual') as MpDelRenglon['atado'],
      motivo: f.motivo ?? '',
      medioAnterior: f.medioAnterior ?? null,
      pagos: [],
    };
    if (f.id && !r.pagos.some((p) => p.id === f.id)) {
      r.pagos.push({
        id: String(f.id), estado: f.estado ?? '', familia: f.familia ?? '', tipo: f.tipo ?? '', metodo: f.metodo ?? '',
        cuotas: Math.max(1, num(f.cuotas) || 1), bruto: num(f.bruto), devuelto: num(f.devuelto), caja: f.caja ?? null,
      });
    }
    res.set(f.ventaPagoId, r);
  }
  /* El QR del ERP sin atar todavía: la referencia del renglón dice qué cobro fue. */
  for (const p of pagos) {
    if (res.has(p.id) || p.medio !== 'qr' || !String(p.referencia ?? '').startsWith('MP ')) continue;
    const c = cobrosQr.find((x) => p.referencia === `MP ${x.paymentId}` || (x.orderId && p.referencia === `MP orden ${x.orderId}`));
    if (!c) continue;
    res.set(p.id, {
      atado: null, motivo: '', medioAnterior: null,
      pagos: [{
        id: c.paymentId || '', estado: 'approved', familia: 'qr', tipo: String(c.info?.tipo ?? ''), metodo: String(c.info?.metodo ?? ''),
        cuotas: Math.max(1, num(c.info?.cuotas) || 1), bruto: num(c.monto) || num(p.importe), devuelto: 0, caja: c.caja ?? null,
      }],
    });
  }
  return res;
}
