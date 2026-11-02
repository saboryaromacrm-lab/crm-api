/**
 * EL PLAZO PARA CERRAR LA CAJA (0212, 2/11/2026, pedido del dueño)
 * ============================================================================
 * Cada sucursal cierra la caja cada 1 a 7 días (`sucursales.cierreCadaDias`).
 * El turno copia ese número al abrir (`cajaSesiones.plazoDias`), así que un
 * cambio de la sucursal con la caja abierta rige desde la próxima apertura.
 *
 * Una sola regla, en días corridos de calendario argentino y contando el de la
 * apertura: cada 3 días, se abre el lunes y se cierra a más tardar el miércoles.
 *   en_plazo  · todavía no es el último día.
 *   vence_hoy · hoy es el último día para cerrarla.
 *   vencida   · el último día ya pasó.
 *
 * Una caja de VARIOS días vencida no vende ni cobra hasta que se cierre (la
 * pantalla lleva directo al cierre). La de todos los días sigue como siempre:
 * se avisa, pero no se frena.
 */
import { sql, type SQL } from 'drizzle-orm';
import { ZONA_AR, hoyAr, sumarDias } from '../cafeteria/cuenta';

export const PLAZO_MAX_DIAS = 7;

export type EstadoPlazo = 'en_plazo' | 'vence_hoy' | 'vencida';

/** El día de la apertura en hora argentina ('AAAA-MM-DD'). */
const diaDeApertura = (apertura: Date | string) => new Date(apertura).toLocaleDateString('sv-SE', { timeZone: ZONA_AR });

export function plazoDelTurno(t: { apertura: Date | string; plazoDias?: number | null }, hoy = hoyAr()) {
  const plazoDias = Math.min(PLAZO_MAX_DIAS, Math.max(1, Number(t.plazoDias) || 1));
  const cerrarHasta = sumarDias(diaDeApertura(t.apertura), plazoDias - 1);
  const estado: EstadoPlazo = hoy < cerrarHasta ? 'en_plazo' : hoy === cerrarHasta ? 'vence_hoy' : 'vencida';
  return {
    plazoDias,
    cerrarHasta,
    estado,
    /** Una caja de varios días que pasó su último día: no vende hasta cerrarla. */
    bloquea: estado === 'vencida' && plazoDias > 1,
  };
}

/** El último día para cerrar de un turno, en SQL (`alias` es la tabla caja_sesiones). */
export const cerrarHastaSql = (alias: string): SQL =>
  sql.raw(`((${alias}.apertura at time zone '${ZONA_AR}')::date + ${alias}.plazo_dias - 1)`);

/** El último día en palabras: «miércoles 29/10». */
export function diaEnPalabras(dia: string) {
  const d = new Date(`${dia}T12:00:00`);
  return `${d.toLocaleDateString('es-AR', { weekday: 'long' })} ${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
}
