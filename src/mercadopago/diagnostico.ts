/**
 * MERCADO PAGO — DIAGNÓSTICO DE LA CUENTA (13/11/2026, pedido del dueño)
 * ============================================================================
 * Antes de armar «Mi Mercado Pago» (una caja como el Cash Flow, pero que se
 * llena sola desde la cuenta) hay que VER qué devuelve la API para esta cuenta:
 * si aparecen las transferencias recibidas, cómo vienen los QR, si el posnet
 * deja rastro, qué trae el reporte de liberaciones. Esto lo resume sin guardar
 * nada: son funciones puras sobre lo que contestó Mercado Pago.
 *
 * Del pagador NO se toma nada (ni nombre, ni mail, ni documento): para decidir
 * el diseño alcanza con el tipo, el medio, los importes y las fechas.
 */

const n = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Una caja nuestra de Mercado Pago, para nombrar el `pos_id` de cada pago. */
export type CajaMp = { mpPosId: string; nombre: string; sucursal: string };

type Grupo = { clave: string; tipo: string; operacion: string; origen: string; estado: string; n: number; bruto: number; comision: number; impuestos: number; neto: number };

/** Lo que cobró Mercado Pago (lo que paga el que cobra: `fee_payer` collector). */
const comisionDe = (p: any) => (Array.isArray(p?.fee_details) ? p.fee_details : [])
  .filter((f: any) => String(f?.fee_payer ?? 'collector') === 'collector')
  .reduce((a: number, f: any) => a + n(f?.amount), 0);

/** Un pago, sin datos del pagador: solo lo que sirve para entender la cuenta. */
function ejemplo(p: any, cajas: Map<string, CajaMp>) {
  const pos = p?.pos_id != null ? String(p.pos_id) : '';
  return {
    id: String(p?.id ?? ''),
    fecha: p?.date_approved ?? p?.date_created ?? null,
    estado: String(p?.status ?? ''),
    detalleEstado: String(p?.status_detail ?? ''),
    tipo: String(p?.payment_type_id ?? ''),
    metodo: String(p?.payment_method_id ?? ''),
    operacion: String(p?.operation_type ?? ''),
    origen: String(p?.point_of_interaction?.type ?? ''),
    cuotas: Math.max(1, Math.round(n(p?.installments) || 1)),
    bruto: r2(n(p?.transaction_amount)),
    comision: r2(comisionDe(p)),
    impuestos: r2(n(p?.taxes_amount)),
    neto: r2(n(p?.transaction_details?.net_received_amount)),
    liberacion: p?.money_release_date ?? null,
    liberado: String(p?.money_release_status ?? ''),
    caja: pos ? (cajas.get(pos)?.nombre ?? `Otra caja (pos ${pos})`) : '',
    sucursal: pos ? (cajas.get(pos)?.sucursal ?? '') : '',
    deErp: /^SYA-V\d+-C\d+$/.test(String(p?.external_reference ?? '')),
    descripcion: String(p?.description ?? '').slice(0, 80),
  };
}

/**
 * Agrupa los pagos de la búsqueda por tipo de medio, operación, origen y
 * estado; suma bruto, comisión, impuestos y neto; arma «lo que falta liberar»
 * por día y cuánto entró por cada caja. `ahora` se pasa para poder probarlo.
 */
export function resumirPagos(pagos: any[], cajasLista: CajaMp[], ahora = new Date()) {
  const cajas = new Map(cajasLista.filter((c) => c.mpPosId).map((c) => [String(c.mpPosId), c]));
  const grupos = new Map<string, Grupo>();
  const aLiberar = new Map<string, { dia: string; n: number; neto: number }>();
  const porCaja = new Map<string, { caja: string; sucursal: string; n: number; bruto: number }>();
  const ejemplos = new Map<string, ReturnType<typeof ejemplo>[]>();
  let aprobados = 0;
  for (const p of pagos) {
    const e = ejemplo(p, cajas);
    const clave = [e.tipo || '—', e.operacion || '—', e.origen || '—', e.estado || '—'].join(' | ');
    const g = grupos.get(clave) ?? { clave, tipo: e.tipo, operacion: e.operacion, origen: e.origen, estado: e.estado, n: 0, bruto: 0, comision: 0, impuestos: 0, neto: 0 };
    g.n++; g.bruto += e.bruto; g.comision += e.comision; g.impuestos += e.impuestos; g.neto += e.neto;
    grupos.set(clave, g);
    const lista = ejemplos.get(clave) ?? [];
    if (lista.length < 3) { lista.push(e); ejemplos.set(clave, lista); }
    if (e.estado !== 'approved') continue;
    aprobados++;
    const k = e.caja || 'Sin caja (no vino por un QR del ERP ni por un pos)';
    const c = porCaja.get(k) ?? { caja: k, sucursal: e.sucursal, n: 0, bruto: 0 };
    c.n++; c.bruto += e.bruto; porCaja.set(k, c);
    /* Lo aprobado que todavía no se liberó: la plata que va a entrar, por día. */
    const lib = e.liberacion ? new Date(e.liberacion) : null;
    if (lib && !Number.isNaN(lib.getTime()) && lib > ahora && e.liberado !== 'released') {
      const dia = lib.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }); // el día en Argentina, no en UTC
      const d = aLiberar.get(dia) ?? { dia, n: 0, neto: 0 };
      d.n++; d.neto += e.neto || e.bruto - e.comision;
      aLiberar.set(dia, d);
    }
  }
  const redondear = <T extends Record<string, any>>(o: T): T => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v])) as T;
  return {
    total: pagos.length,
    aprobados,
    grupos: [...grupos.values()].sort((a, b) => b.bruto - a.bruto).map((g) => ({ ...redondear(g), ejemplos: ejemplos.get(g.clave) ?? [] })),
    aLiberar: [...aLiberar.values()].sort((a, b) => a.dia.localeCompare(b.dia)).map(redondear),
    porCaja: [...porCaja.values()].sort((a, b) => b.bruto - a.bruto).map(redondear),
  };
}

/** Separa un renglón de CSV respetando comillas. */
function celdas(linea: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let comillas = false;
  for (let i = 0; i < linea.length; i++) {
    const ch = linea[i];
    if (ch === '"') {
      if (comillas && linea[i + 1] === '"') { cur += '"'; i++; } else comillas = !comillas;
    } else if (ch === sep && !comillas) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/**
 * EL REPORTE DE LIBERACIONES, RESUMIDO: qué columnas trae, cuántos renglones,
 * y —si están las columnas de siempre— cuánto entró y salió por cada tipo de
 * movimiento. Es para saber si sirve de libro (retiros, transferencias que se
 * mandan, devoluciones, rendimientos), no para usarlo todavía.
 */
export function resumirReporte(texto: string) {
  const lineas = String(texto ?? '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lineas.length) return { columnas: [], renglones: 0, porTipo: [], primeros: [] };
  const sep = (lineas[0].match(/;/g)?.length ?? 0) > (lineas[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const columnas = celdas(lineas[0], sep);
  const filas = lineas.slice(1).map((l) => celdas(l, sep));
  /* Por orden de preferencia: DESCRIPTION distingue cobro, retiro, transferencia; RECORD_TYPE es más grueso. */
  const col = (...nombres: string[]) => nombres.map((x) => columnas.findIndex((c) => c.toUpperCase() === x)).find((i) => i >= 0) ?? -1;
  const iTipo = col('DESCRIPTION', 'RECORD_TYPE', 'DESCRIPCIÓN', 'DESCRIPCION', 'TIPO DE REGISTRO');
  const iCredito = col('NET_CREDIT_AMOUNT', 'IMPORTE NETO DE CRÉDITO', 'IMPORTE NETO ACREDITADO');
  const iDebito = col('NET_DEBIT_AMOUNT', 'IMPORTE NETO DE DÉBITO', 'IMPORTE NETO DEBITADO');
  const num = (v: string | undefined) => n(String(v ?? '').replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  const tipos = new Map<string, { tipo: string; n: number; credito: number; debito: number }>();
  if (iTipo >= 0) {
    for (const f of filas) {
      const k = f[iTipo] || '—';
      const t = tipos.get(k) ?? { tipo: k, n: 0, credito: 0, debito: 0 };
      t.n++;
      if (iCredito >= 0) t.credito += num(f[iCredito]);
      if (iDebito >= 0) t.debito += num(f[iDebito]);
      tipos.set(k, t);
    }
  }
  return {
    columnas,
    renglones: filas.length,
    porTipo: [...tipos.values()].map((t) => ({ ...t, credito: r2(t.credito), debito: r2(t.debito) })).sort((a, b) => b.n - a.n),
    primeros: filas.slice(0, 5).map((f) => Object.fromEntries(columnas.map((c, i) => [c, f[i] ?? '']))),
  };
}
