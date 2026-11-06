/**
 * ADELANTOS DE SUELDO PARA LA APP DE SUELDOS (6/11/2026, pedido del dueño:
 * «que mi otra app de sueldos tome ese adelanto, así no lo hago a mano»).
 *
 * Un adelanto es un EGRESO con un concepto de adelanto (hoy «Adelantos
 * sueldos»). Sale de dos lugares y los dos van en la respuesta:
 *   · `cashflow` — «Sacar plata» de la caja central (Gerencia › Cash Flow);
 *   · `caja`     — «Ingreso / egreso» de la caja de un local (Ventas › Caja).
 *
 * Qué conceptos son de adelanto: los de EGRESO cuyo nombre dice «adelanto»
 * (sin importar mayúsculas ni tildes). Así un concepto nuevo, por ejemplo
 * «Adelanto aguinaldo», entra solo; renombrarlo sin esa palabra lo saca.
 *
 * Los ANULADOS también vienen, con `anulado: true`: si la otra app ya importó
 * uno y después se anuló en el ERP, tiene que enterarse para darlo de baja.
 * `total` suma solo los vigentes.
 *
 * Funciones puras acá (con test); la consulta en `adelantos.module.ts`.
 */

export const esDia = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(new Date(`${v}T12:00:00Z`).getTime()) && new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v;

/**
 * El período pedido. Sin fechas: el mes en curso. Con una sola: ese día hasta
 * hoy (o desde el 1 de ese mes hasta ese día). Error si vienen mal o al revés.
 */
export function rangoPedido(q: { desde?: unknown; hasta?: unknown }, hoy: string): { desde: string; hasta: string } | { error: string } {
  const d = q.desde == null || q.desde === '' ? null : q.desde;
  const h = q.hasta == null || q.hasta === '' ? null : q.hasta;
  if (d != null && !esDia(d)) return { error: '«desde» tiene que ser una fecha AAAA-MM-DD.' };
  if (h != null && !esDia(h)) return { error: '«hasta» tiene que ser una fecha AAAA-MM-DD.' };
  const hasta = (h as string | null) ?? hoy;
  const desde = (d as string | null) ?? `${hasta.slice(0, 7)}-01`;
  if (desde > hasta) return { error: '«desde» no puede ser posterior a «hasta».' };
  return { desde, hasta };
}

/**
 * El detalle de un egreso de la caja de un local: allá se guarda junto con el
 * concepto en un solo texto («Adelantos sueldos · Juan Pérez»). Si el concepto
 * se renombró después, el texto viejo conserva el nombre de entonces: se corta
 * en el primer « · ».
 */
export function detalleDeMotivo(motivo: string | null | undefined, concepto: string | null | undefined): string {
  const m = String(motivo ?? '').trim();
  const c = String(concepto ?? '').trim();
  if (!m || m === c) return '';
  if (c && m.startsWith(`${c} · `)) return m.slice(c.length + 3).trim();
  const i = m.indexOf(' · ');
  return i >= 0 ? m.slice(i + 3).trim() : m;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export type Adelanto = {
  id: string; origen: 'cashflow' | 'caja'; movimientoId: number;
  fecha: string; dia: string; importe: number; detalle: string; concepto: string;
  lugar: string; sucursalId: number | null; turnoCajaId: number | null; cargadoPor: string;
  anulado: boolean; anuladoEn: string | null; anuladoMotivo: string | null;
  /** 0221: a quién se le dio (de la lista del personal). null = adelanto de antes, solo con el detalle. */
  empleado: { id: number; nombre: string; usuarioId: number | null } | null;
};

/** Ordena (más viejo primero, para importar en orden) y suma los vigentes. */
export function armarRespuesta(filas: Adelanto[], rango: { desde: string; hasta: string }, conceptos: { id: number; nombre: string }[], generado: string) {
  const adelantos = [...filas].sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.id < b.id ? -1 : 1));
  const vigentes = adelantos.filter((a) => !a.anulado);
  return {
    generado,
    desde: rango.desde,
    hasta: rango.hasta,
    conceptos,
    cantidad: vigentes.length,
    total: r2(vigentes.reduce((s, a) => s + a.importe, 0)),
    anulados: adelantos.length - vigentes.length,
    adelantos,
  };
}
