/**
 * EL PLAZO PARA CERRAR LA CAJA (0212 y 0214, pedido del dueño)
 * ============================================================================
 * Cada sucursal elige los DÍAS DE LA SEMANA en que se cierra la caja
 * (`sucursales.diasCierre`, 1 = lunes … 7 = domingo). Los siete = todos los
 * días, como siempre. El ejemplo del dueño: un local cierra lunes y miércoles,
 * y él pasa a buscar el sobre el martes y el jueves (lo de ese día ya va en la
 * caja siguiente).
 *
 * Al abrir, el turno guarda su último día para cerrar (`cajaSesiones.cerrarHasta`):
 * el próximo día de cierre desde la apertura, contando el de hoy. Cambiar los
 * días con la caja abierta rige desde la próxima apertura. Vacío = local de
 * todos los días: su último día es el de la apertura.
 *   en_plazo  · todavía no es el último día.
 *   vence_hoy · hoy es el último día para cerrarla.
 *   vencida   · el último día ya pasó.
 *
 * Una caja con días de cierre vencida no vende ni cobra hasta que se cierre
 * (la pantalla lleva directo al cierre). La de todos los días sigue como
 * siempre: se avisa, pero no se frena.
 */
import { sql, type SQL } from 'drizzle-orm';
import { ZONA_AR, hoyAr, sumarDias } from '../cafeteria/cuenta';

export const TODOS_LOS_DIAS = [1, 2, 3, 4, 5, 6, 7];
/** En plural, como se dice: «los lunes», «los sábados». */
const NOMBRES = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados', 'domingos'];

export type EstadoPlazo = 'en_plazo' | 'vence_hoy' | 'vencida';

/** El día de la apertura en hora argentina ('AAAA-MM-DD'). */
const diaDeApertura = (apertura: Date | string) => new Date(apertura).toLocaleDateString('sv-SE', { timeZone: ZONA_AR });

/** Día de la semana de 'AAAA-MM-DD': 1 = lunes … 7 = domingo. */
const diaSemana = (dia: string) => new Date(`${dia}T12:00:00Z`).getUTCDay() || 7;

/** Sin repetidos, en orden, solo 1 a 7. */
export const ordenarDias = (dias: readonly number[]) => [...new Set(dias)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);

/** Los siete días (o nada cargado): el local cierra todos los días. */
export const esTodosLosDias = (dias: readonly number[] | null | undefined) => !dias?.length || ordenarDias(dias).length === 7;

/**
 * El último día para cerrar una caja que se abre `desde` (hoy): el próximo día
 * de cierre, contando ese mismo. `null` si el local cierra todos los días.
 */
export function cerrarHastaDe(dias: readonly number[] | null | undefined, desde = hoyAr()): string | null {
  if (esTodosLosDias(dias)) return null;
  for (let i = 0; i < 7; i++) {
    const d = sumarDias(desde, i);
    if (dias!.includes(diaSemana(d))) return d;
  }
  return null;
}

export function plazoDelTurno(t: { apertura: Date | string; cerrarHasta?: string | null }, hoy = hoyAr()) {
  const programada = !!t.cerrarHasta;
  const cerrarHasta = t.cerrarHasta || diaDeApertura(t.apertura);
  const estado: EstadoPlazo = hoy < cerrarHasta ? 'en_plazo' : hoy === cerrarHasta ? 'vence_hoy' : 'vencida';
  return {
    /** El local tiene días de cierre (no cierra todos los días). */
    programada,
    cerrarHasta,
    estado,
    /** Una caja con días de cierre que pasó su último día: no vende hasta cerrarla. */
    bloquea: estado === 'vencida' && programada,
  };
}

/** El último día para cerrar de un turno, en SQL (`alias` es la tabla caja_sesiones). */
export const cerrarHastaSql = (alias: string): SQL =>
  sql.raw(`coalesce(${alias}.cerrar_hasta, (${alias}.apertura at time zone '${ZONA_AR}')::date)`);

/** El último día en palabras: «miércoles 29/10». */
export function diaEnPalabras(dia: string) {
  const d = new Date(`${dia}T12:00:00`);
  return `${d.toLocaleDateString('es-AR', { weekday: 'long' })} ${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
}

/** «Todos los días», «Los lunes» o «Los lunes y miércoles». */
export function textoDiasCierre(dias: readonly number[] | null | undefined) {
  if (esTodosLosDias(dias)) return 'Todos los días';
  const n = ordenarDias(dias!).map((d) => NOMBRES[d]);
  return `Los ${n.length > 1 ? `${n.slice(0, -1).join(', ')} y ${n.at(-1)}` : n[0]}`;
}
