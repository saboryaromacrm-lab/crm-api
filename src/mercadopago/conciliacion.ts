/**
 * VENTAS › CONCILIACIÓN MP — LAS REGLAS (18/11/2026, pedido del dueño)
 * ============================================================================
 * «Corroborar que ingresaron a mi cuenta» los cobros electrónicos. Hay UNA
 * cuenta de Mercado Pago: todo QR, Point y transferencia cae ahí. De un lado
 * está lo que el ERP dice que se cobró (renglones de pago de ventas y recibos
 * por QR, tarjeta o transferencia); del otro, lo que Mercado Pago dice que
 * entró. Acá están las funciones puras que los atan (con pruebas):
 *
 *  · `movimientoDe`: un pago de Mercado Pago → el renglón que se guarda. Del
 *    pagador solo el nombre (sirve para reconocer una transferencia).
 *  · `atarSolos`: lo que se ata sin preguntar. Primero el QR del ERP, por su
 *    número de pago. Después, por «familia» (QR, tarjeta, transferencia),
 *    mismo importe y dentro de la ventana de tiempo: si un grupo de candidatos
 *    tiene tantos cobros del ERP como pagos de Mercado Pago, se atan en orden
 *    de hora (dos tickets de $1.500 contra dos pagos de $1.500: da lo mismo
 *    cuál con cuál). Si no son tantos como tantos, nadie sabe cuál falta: no se
 *    ata y queda sugerido.
 *  · `sugerir`: para lo que quedó suelto, el candidato más probable, con por
 *    qué («varios posibles», «otro medio», «monto distinto»). Lo confirma una
 *    persona.
 */

export type Familia = 'qr' | 'tarjeta' | 'transferencia';

/** Los medios del ERP que pasan por Mercado Pago, y con qué se comparan. */
export const FAMILIA_DE_MEDIO: Record<string, Familia> = {
  qr: 'qr', tarjeta_debito: 'tarjeta', tarjeta_credito: 'tarjeta', transferencia: 'transferencia',
};
export const MEDIOS_ELECTRONICOS = Object.keys(FAMILIA_DE_MEDIO);

/** Los estados de un pago de Mercado Pago que se guardan: lo que entró, y lo que entró y después se devolvió o se reclamó. */
export const ESTADOS_GUARDADOS = ['approved', 'refunded', 'charged_back', 'in_mediation'];

const n = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const r2 = (x: number) => Math.round(x * 100) / 100;
const MIN = 60_000;
const DIA = 1_440 * MIN;

/** Point = tarjeta en el posnet; INSTORE (o una caja) = QR; lo demás (transferencias, links de pago) = transferencia. */
export function familiaMp(p: any): Familia {
  const origen = String(p?.point_of_interaction?.type ?? '');
  if (origen === 'POINT') return 'tarjeta';
  if (origen === 'INSTORE' || p?.pos_id != null) return 'qr';
  return 'transferencia';
}

/**
 * ¿Este pago es plata que ENTRÓ a la cuenta? Fuera: los rechazados y
 * pendientes, los movimientos entre las «reservas» de la misma cuenta
 * (`partition_transfer`) y lo que pagamos nosotros. Manda el COBRADOR: un
 * cobro del Point con tarjeta anónima trae a la propia cuenta como pagador
 * (18/11/2026, en producción se perdían así la mitad de las tarjetas). Solo si
 * Mercado Pago no dice quién cobró, se descarta lo que figura pagado por nosotros.
 */
export function seGuarda(p: any, cuentaId: number): boolean {
  if (!ESTADOS_GUARDADOS.includes(String(p?.status ?? ''))) return false;
  if (String(p?.operation_type ?? '') === 'partition_transfer') return false;
  const cobrador = p?.collector_id ?? p?.collector?.id;
  if (cobrador != null) return Number(cobrador) === cuentaId;
  return !(p?.payer?.id != null && Number(p.payer.id) === cuentaId);
}

/**
 * CON QUÉ SE COBRÓ DE VERDAD, en los medios del ERP: lo que dice Mercado Pago,
 * o null si no lo dice sin dudas (entonces no se corrige nada):
 *   · un QR del local es QR, aunque el cliente lo haya pagado con tarjeta;
 *   · una tarjeta (en el Point o en un link de pago): crédito es crédito;
 *     débito y prepaga, débito (el ERP no tiene prepaga);
 *   · fuera del local, dinero en cuenta o transferencia bancaria: transferencia.
 * Lo demás (el Point cobrando con dinero en cuenta, créditos de Mercado Pago…)
 * no tiene un medio claro en el ERP.
 */
export function medioReal(p: { familia: Familia; tipo: string }): string | null {
  if (p.familia === 'qr') return 'qr';
  if (p.tipo === 'credit_card') return 'tarjeta_credito';
  if (p.tipo === 'debit_card' || p.tipo === 'prepaid_card') return 'tarjeta_debito';
  if (p.familia === 'transferencia' && (p.tipo === 'account_money' || p.tipo === 'bank_transfer')) return 'transferencia';
  return null;
}

/** Lo que Mercado Pago le descontó al comercio (`fee_payer` collector). */
const comisionDe = (p: any) => (Array.isArray(p?.fee_details) ? p.fee_details : [])
  .filter((f: any) => String(f?.fee_payer ?? 'collector') === 'collector')
  .reduce((a: number, f: any) => a + n(f?.amount), 0);

/** Un pago de Mercado Pago → el renglón de `mp_movimientos`. `sucursalDe` traduce caja o sucursal de Mercado Pago a la nuestra. */
export function movimientoDe(p: any, sucursalDe: (posId: string, storeId: string) => number | null) {
  const posId = p?.pos_id != null ? String(p.pos_id) : '';
  const storeId = p?.store_id != null ? String(p.store_id) : '';
  const banco = p?.point_of_interaction?.transaction_data?.bank_info?.payer?.long_name;
  const nombre = [p?.payer?.first_name, p?.payer?.last_name].filter(Boolean).join(' ');
  return {
    id: String(p.id),
    fecha: new Date(p.date_approved ?? p.date_created),
    estado: String(p.status ?? ''),
    familia: familiaMp(p),
    tipo: String(p.payment_type_id ?? ''),
    metodo: String(p.payment_method_id ?? ''),
    operacion: String(p.operation_type ?? ''),
    cuotas: Math.max(1, Math.round(n(p.installments) || 1)),
    bruto: r2(n(p.transaction_amount)),
    comision: r2(comisionDe(p)),
    neto: r2(n(p.transaction_details?.net_received_amount)),
    devuelto: r2(n(p.transaction_amount_refunded)),
    liberacion: p.money_release_date ? new Date(p.money_release_date) : null,
    posId,
    storeId,
    sucursalId: sucursalDe(posId, storeId),
    pagador: String(banco || nombre || '').trim().slice(0, 80),
    referencia: String(p.external_reference ?? '').slice(0, 80),
    actualizadoMp: new Date(p.date_last_updated ?? p.date_created),
  };
}

/** Un cobro del ERP (renglón de pago de una venta o de un recibo). `mpId`: el pago que ya trae anotado (QR del ERP). */
export type CobroErp = { clave: string; fecha: Date; importe: number; familia: Familia; sucursalId: number | null; mpId?: string | null };
/** Un pago de Mercado Pago que entró. */
export type PagoMp = { id: string; fecha: Date; bruto: number; familia: Familia; sucursalId: number | null };
export type Par = { clave: string; mpId: string };

/**
 * LA VENTANA: cuánto antes o después de la venta puede estar el pago. En el
 * local se cobra al momento (±20 min). Una transferencia de un pedido puede
 * llegar días ANTES de que se entregue y se haga la venta, o al otro día.
 */
const VENTANA: Record<Familia, [antes: number, despues: number]> = {
  qr: [20 * MIN, 20 * MIN],
  tarjeta: [20 * MIN, 20 * MIN],
  transferencia: [3 * DIA, 1 * DIA],
};

const dentro = (c: CobroErp, p: PagoMp, [antes, despues]: [number, number]) => {
  const dt = p.fecha.getTime() - c.fecha.getTime();
  return dt >= -antes && dt <= despues;
};
const mismaSucursal = (c: CobroErp, p: PagoMp) => c.sucursalId == null || p.sucursalId == null || c.sucursalId === p.sucursalId;
const centavos = (x: number) => Math.round(x * 100);

/** Los pagos por importe exacto (al centavo), para no comparar todos contra todos. */
function porImporte(pagos: PagoMp[]) {
  const m = new Map<number, PagoMp[]>();
  for (const p of pagos) {
    const k = centavos(p.bruto);
    const l = m.get(k);
    if (l) l.push(p); else m.set(k, [p]);
  }
  return m;
}

/** Candidatos seguros: misma familia, mismo importe, misma sucursal (si se sabe), dentro de la ventana. */
const esCandidato = (c: CobroErp, p: PagoMp) => c.familia === p.familia && mismaSucursal(c, p) && dentro(c, p, VENTANA[c.familia]);

/** Lo que se ata solo. Devuelve los pares; lo demás queda suelto. */
export function atarSolos(cobros: CobroErp[], pagos: PagoMp[]): Par[] {
  const pares: Par[] = [];
  const ids = new Set(pagos.map((p) => p.id));
  const usados = new Set<string>();
  /* 1. El QR del ERP trae el número de pago: es ese y ningún otro. */
  for (const c of cobros) {
    if (c.mpId && ids.has(c.mpId) && !usados.has(c.mpId)) { pares.push({ clave: c.clave, mpId: c.mpId }); usados.add(c.mpId); }
  }
  /* Un cobro que trae número de pago y no se encontró ESE pago (todavía no
   * bajó, se devolvió, se deshizo) no se ata a otro que se le parezca. */
  const sueltosErp = cobros.filter((c) => !c.mpId);
  const sueltosMp = pagos.filter((p) => !usados.has(p.id));

  /* 2. Grupos de candidatos (componentes conexos): tantos como tantos → en orden de hora. */
  const padre = new Map<string, string>();
  const raiz = (x: string): string => { let r = x; while (padre.get(r) !== r) r = padre.get(r)!; padre.set(x, r); return r; };
  const unir = (a: string, b: string) => { padre.set(raiz(a), raiz(b)); };
  const indice = porImporte(sueltosMp);
  const aristas = new Set<string>();
  for (const c of sueltosErp) {
    for (const p of indice.get(centavos(c.importe)) ?? []) {
      if (!esCandidato(c, p)) continue;
      for (const k of [`e${c.clave}`, `m${p.id}`]) if (!padre.has(k)) padre.set(k, k);
      unir(`e${c.clave}`, `m${p.id}`);
      aristas.add(`${c.clave}|${p.id}`);
    }
  }
  const grupos = new Map<string, { erp: CobroErp[]; mp: PagoMp[] }>();
  const grupo = (k: string) => { const r = raiz(k); let g = grupos.get(r); if (!g) { g = { erp: [], mp: [] }; grupos.set(r, g); } return g; };
  for (const c of sueltosErp) if (padre.has(`e${c.clave}`)) grupo(`e${c.clave}`).erp.push(c);
  for (const p of sueltosMp) if (padre.has(`m${p.id}`)) grupo(`m${p.id}`).mp.push(p);
  const porHora = (a: { fecha: Date }, b: { fecha: Date }) => a.fecha.getTime() - b.fecha.getTime();
  for (const g of grupos.values()) {
    if (g.erp.length !== g.mp.length) continue;
    /* Una transferencia solo se ata sola si es la única candidata de cada lado:
     * entre dos de igual importe en días distintos, el orden de hora no dice cuál es de quién. */
    if (g.erp[0].familia === 'transferencia' && g.erp.length > 1) continue;
    g.erp.sort(porHora); g.mp.sort(porHora);
    /* Cada par en orden de hora tiene que ser candidato él mismo; si no, el grupo se deja para una persona. */
    if (!g.erp.every((c, i) => aristas.has(`${c.clave}|${g.mp[i].id}`))) continue;
    g.erp.forEach((c, i) => pares.push({ clave: c.clave, mpId: g.mp[i].id }));
  }
  return pares;
}

export type Motivo = 'varios' | 'otro_medio' | 'monto_distinto';
export type Sugerencia = Par & { motivo: Motivo };

/**
 * PARA CONFIRMAR: el candidato más probable de cada cobro suelto, cada pago
 * sugerido una sola vez. En orden de confianza:
 *   · varios posibles: candidato seguro, pero el grupo no cerraba tantos como tantos;
 *   · otro medio: mismo importe, otra familia (se marcó tarjeta y pagó con QR), ±30 min;
 *   · monto distinto: misma familia, ±3 min (el monto se tipeó mal en el Point).
 * Una transferencia mira su ventana de días también en «otro medio».
 */
export function sugerir(cobros: CobroErp[], pagos: PagoMp[]): Sugerencia[] {
  const PRIORIDAD: Record<Motivo, number> = { varios: 0, otro_medio: 1, monto_distinto: 2 };
  const cerca: [number, number] = [30 * MIN, 30 * MIN];
  const opciones: (Sugerencia & { orden: number })[] = [];
  for (const c of cobros) {
    for (const p of pagos) {
      if (!mismaSucursal(c, p)) continue;
      const igual = Math.abs(c.importe - p.bruto) <= 0.01;
      let motivo: Motivo | null = null;
      if (igual && esCandidato(c, p)) motivo = 'varios';
      else if (igual && c.familia !== p.familia
        && dentro(c, p, c.familia === 'transferencia' || p.familia === 'transferencia' ? VENTANA.transferencia : cerca)) motivo = 'otro_medio';
      else if (!igual && c.familia === p.familia && dentro(c, p, [3 * MIN, 3 * MIN])) motivo = 'monto_distinto';
      if (!motivo) continue;
      opciones.push({ clave: c.clave, mpId: p.id, motivo, orden: PRIORIDAD[motivo] * 1e13 + Math.abs(p.fecha.getTime() - c.fecha.getTime()) });
    }
  }
  opciones.sort((a, b) => a.orden - b.orden);
  const conCobro = new Set<string>();
  const conPago = new Set<string>();
  const out: Sugerencia[] = [];
  for (const o of opciones) {
    if (conCobro.has(o.clave) || conPago.has(o.mpId)) continue;
    conCobro.add(o.clave); conPago.add(o.mpId);
    out.push({ clave: o.clave, mpId: o.mpId, motivo: o.motivo });
  }
  return out;
}
