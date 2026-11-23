/**
 * EL CUADRE SEMANAL DEL FRACCIONADO (23/11/2026, pedido del dueño)
 * ============================================================================
 * El hueco que más stock rompía: paquetes que se ARMAN y no se registran. El
 * paquete se vende o se manda a un local sin haber entrado al sistema (queda
 * en negativo) y la bolsa grande nunca descuenta esos kilos (queda con kilos
 * que ya no están). Este cuadre lo muestra semana a semana, en la sucursal que
 * se elija, paquete por paquete y sumado en kilos por producto:
 *
 *   había al empezar + se armó + se recibió − se vendió − se envió − bajas ± ajustes = queda
 *
 * y, sobre todo, «SALIÓ SIN ESTAR ARMADO»: lo que se vendió, se mandó o se dio
 * de baja cuando el sistema ya no tenía ese paquete. Si se vendió, existía:
 * se armó (o llegó) sin registrarse. Un fraccionado cargado tarde, dentro de
 * la misma semana, lo salda; un control de stock no (el control confirma que
 * el paquete estaba, no lo registra como armado).
 *
 * El stock que cuenta es el que se puede vender o mandar —disponible,
 * comprometido, retenido y en tránsito—: pasar de uno a otro no es entrar ni
 * salir. Lo vencido y defectuoso ya salió (es una baja).
 *
 * Acá, solo la cuenta (sin base de datos), para poder probarla.
 */
import type { Delta } from './kardex';

/** Los estados que siguen siendo mercadería para vender o mandar. */
export const ESTADOS_EN_STOCK = new Set(['disponible', 'comprometido', 'retenido', 'en_transito']);

/** Cuántas semanas para atrás se puede mirar (cada una se arma desde el stock de hoy). */
export const SEMANAS_ATRAS = 26;

const DIA_MS = 86_400_000;
/** Argentina es UTC−3 todo el año. */
const AR_MS = 3 * 3_600_000;
const r3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;
const EPS = 1e-9;

/** La semana (lunes a domingo, hora argentina) que contiene el día `iso` ('AAAA-MM-DD'). */
export function semanaDe(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  const dia = Date.UTC(y, m - 1, d);
  const lunes = dia - ((new Date(dia).getUTCDay() + 6) % 7) * DIA_MS;
  return {
    lunes: new Date(lunes).toISOString().slice(0, 10),
    domingo: new Date(lunes + 6 * DIA_MS).toISOString().slice(0, 10),
    desde: new Date(lunes + AR_MS),
    hasta: new Date(lunes + 7 * DIA_MS + AR_MS),
  };
}

export type Columna = 'armado' | 'recibido' | 'vendido' | 'enviado' | 'bajas' | 'ajustes';

/** En qué columna cae lo que un movimiento sumó o restó a un paquete. */
export function columnaDe(tipo: string, delta: number): Columna {
  if (tipo === 'fraccionamiento') return 'armado';
  if (tipo === 'ajuste') return 'ajustes';
  if (tipo === 'transferencia') return delta < 0 ? 'enviado' : 'recibido';
  /* La devolución de un cliente vuelve a lo vendido: lo vendido queda neto. */
  if (tipo === 'venta_fraccionada' || tipo === 'venta_granel' || tipo === 'devolucion') return 'vendido';
  return delta < 0 ? 'bajas' : 'recibido';
}

/** Lo que un movimiento movió en cada paquete de la sucursal (presentación → unidades), sumando los estados en stock. */
export function netoEnStock(deltas: Delta[], sucursalId: number) {
  const out = new Map<number, number>();
  for (const d of deltas) {
    if (d.sucursalId !== sucursalId || !ESTADOS_EN_STOCK.has(d.estado)) continue;
    out.set(d.presentacionId, (out.get(d.presentacionId) ?? 0) + d.delta);
  }
  for (const [k, v] of out) if (Math.abs(v) < EPS) out.delete(k);
  return out;
}

export interface MovSemana { fecha: Date | string; tipo: string; netos: Map<number, number> }

export interface CuadrePaquete {
  presentacionId: number;
  inicio: number;
  armado: number; recibido: number; vendido: number; enviado: number; bajas: number; ajustes: number;
  fin: number;
  /** Unidades que salieron cuando el sistema ya no tenía (ver arriba). */
  sinArmar: number;
}

/**
 * El cuadre de cada artículo (presentación; 0 = la bolsa grande) en la semana.
 * `movs`: TODOS los movimientos de la sucursal desde `desde` hasta hoy, en el
 * orden en que pasaron (fecha, id); `hoy`: el stock en estados de stock por
 * artículo. Se reconstruye hacia atrás: lo de después de la semana se le
 * descuenta a hoy para saber cómo terminó; lo de la semana, para cómo empezó.
 */
export function cuadreSemana(movs: MovSemana[], hoy: Map<number, number>, desde: Date, hasta: Date) {
  const semana = movs.filter((m) => { const t = new Date(m.fecha).getTime(); return t >= desde.getTime() && t < hasta.getTime(); });
  const despues = movs.filter((m) => new Date(m.fecha).getTime() >= hasta.getTime());
  const fin = new Map(hoy);
  for (const m of despues) for (const [p, d] of m.netos) fin.set(p, (fin.get(p) ?? 0) - d);
  const inicio = new Map(fin);
  for (const m of semana) for (const [p, d] of m.netos) inicio.set(p, (inicio.get(p) ?? 0) - d);

  const out = new Map<number, CuadrePaquete>();
  const de = (p: number) => {
    let c = out.get(p);
    if (!c) {
      c = { presentacionId: p, inicio: r3(inicio.get(p) ?? 0), armado: 0, recibido: 0, vendido: 0, enviado: 0, bajas: 0, ajustes: 0, fin: r3(fin.get(p) ?? 0), sinArmar: 0 };
      out.set(p, c);
    }
    return c;
  };
  /* Lo que salió sin respaldo: con el saldo de cada momento. Lo que entra
   * después (un fraccionado cargado tarde) salda primero esa deuda; un ajuste
   * mueve el saldo pero no la salda. */
  const saldo = new Map<number, number>();
  const deuda = new Map<number, number>();
  for (const m of semana) {
    for (const [p, d] of m.netos) {
      const c = de(p);
      const col = columnaDe(m.tipo, d);
      c[col] += d;
      const antes = saldo.has(p) ? saldo.get(p)! : c.inicio;
      if (col !== 'ajustes') {
        if (d < 0) {
          const falta = Math.max(0, -d - Math.max(0, antes));
          if (falta > EPS) deuda.set(p, (deuda.get(p) ?? 0) + falta);
        } else {
          deuda.set(p, Math.max(0, (deuda.get(p) ?? 0) - d));
        }
      }
      saldo.set(p, antes + d);
    }
  }
  for (const c of out.values()) {
    c.sinArmar = r3(deuda.get(c.presentacionId) ?? 0);
    for (const k of ['armado', 'recibido', 'vendido', 'enviado', 'bajas', 'ajustes'] as const) c[k] = r3(c[k]);
  }
  return out;
}
