/**
 * ¿PARA CUÁNDO EL ENVÍO? (23/10/2026, pedido del dueño). Al final del checkout
 * minorista, con envío a domicilio, el cliente elige:
 *
 *   · Lo antes posible: llega entre 20 y 40 minutos. Solo con el local abierto
 *     y con tiempo antes de cerrar.
 *   · Un horario: franjas de 20 minutos dentro del horario del local, desde
 *     que termina «lo antes posible»; hoy y los próximos días con horario.
 *   · Lo coordina por WhatsApp.
 *
 * El horario es el del local elegido en Tienda online › Configuración ›
 * Tienda minorista (cargado en General › Locales), y un feriado de la sucursal
 * que despacha manda sobre él (Sistema › Feriados: cerrado, u otro horario).
 * Sin horario cargado no se puede saber si está abierto: se ofrece «lo antes
 * posible» y WhatsApp, sin franjas. Todo en hora argentina, sin importar el huso
 * del servidor. Reglas puras: el checkout las pide y el alta del pedido las
 * vuelve a mirar (lo elegido puede haber dejado de valer).
 */
import { partesArgentina } from '../arca/fecha';
import { horarioDelDia } from '../common/horario';

export const FRANJA_MIN = 20;
export const PRONTO_MIN = { desde: 20, hasta: 40 } as const;
/** Cuántos días con franjas se ofrecen, y hasta cuántos días adelante se buscan. */
export const DIAS_AGENDA = 3;
export const DIAS_BUSQUEDA = 10;

/** Por `getUTCDay()`: 0 = domingo. Las claves son las de los locales (DIAS_SEMANA). */
const CLAVE_DIA = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'] as const;
const MINUTO = 60_000;

export interface Franja { desde: string; hasta: string }
export interface AgendaEnvios {
  /** Hay horario cargado: sin él, no hay franjas ni se sabe si está abierto. */
  conHorario: boolean;
  /** «Lo antes posible», o null si ahora no se puede (cerrado o por cerrar). */
  pronto: Franja | null;
  dias: { fecha: string; franjas: Franja[] }[];
}
export type CuandoEnvio = { tipo: 'pronto' | 'horario'; desde: string; hasta: string } | { tipo: 'whatsapp' };

/** «08:00-13:00, 17:00-21:00» → [[480, 780], [1020, 1260]] (minutos del día). */
export const tramosDe = (texto: string | undefined): [number, number][] => horarioDelDia(texto ?? '')
  .split(', ').filter(Boolean)
  .map((t) => t.split('-').map((h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5))) as [number, number]);

const dd = (n: number) => String(n).padStart(2, '0');
const sumarDias = (fecha: string, n: number) => new Date(Date.parse(`${fecha}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** El instante de un minuto del día en Argentina (sin horario de verano desde 2009). */
const instante = (fecha: string, min: number) => new Date(`${fecha}T${dd(Math.floor(min / 60))}:${dd(min % 60)}:00-03:00`).toISOString();

/** El local de los envíos: el elegido por nombre, o el primero con horario. Sin ninguno, null. */
export function localDeEnvios<T extends Record<string, any>>(locales: T[], nombre: string): T | null {
  const elegido = nombre.trim().toLowerCase();
  if (elegido) return locales.find((l) => String(l.nombre ?? '').trim().toLowerCase() === elegido) ?? null;
  return locales.find((l) => CLAVE_DIA.some((d) => tramosDe(l[d]).length > 0)) ?? null;
}

/**
 * Qué cambia un feriado para la sucursal que despacha: no abre → cerrado
 * (null); abre con horario → ese; abre sin horario → el de siempre (no entra).
 */
export function excepcionesDe(feriados: { fecha: string; abre: boolean; horario: string }[]): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const f of feriados) {
    const h = horarioDelDia(f.horario);
    if (!f.abre) m.set(f.fecha, null);
    else if (h && m.get(f.fecha) !== null) m.set(f.fecha, h);
  }
  return m;
}

export function agendaEnvios(semana: Partial<Record<string, string>>, excepciones: Map<string, string | null>, ahora: Date): AgendaEnvios {
  const prontoDesde = (): Franja => ({
    desde: new Date(ahora.getTime() + PRONTO_MIN.desde * MINUTO).toISOString(),
    hasta: new Date(ahora.getTime() + PRONTO_MIN.hasta * MINUTO).toISOString(),
  });
  const conHorario = CLAVE_DIA.some((d) => tramosDe(semana[d]).length > 0);
  if (!conHorario) return { conHorario, pronto: prontoDesde(), dias: [] };

  const p = partesArgentina(ahora);
  const hoy = `${p.year}-${dd(p.month)}-${dd(p.day)}`;
  const ya = p.hour * 60 + p.minute;
  const tramosEl = (fecha: string) => {
    const ex = excepciones.get(fecha);
    if (ex === null) return [];
    return tramosDe(ex ?? semana[CLAVE_DIA[new Date(`${fecha}T12:00:00Z`).getUTCDay()]]);
  };

  const pronto = tramosEl(hoy).some(([a, b]) => a <= ya && ya + PRONTO_MIN.hasta <= b) ? prontoDesde() : null;
  const dias: AgendaEnvios['dias'] = [];
  for (let i = 0; i < DIAS_BUSQUEDA && dias.length < DIAS_AGENDA; i++) {
    const fecha = sumarDias(hoy, i);
    /* Hoy, después de lo que tarda «lo antes posible»; las franjas, en punto, y 20 y 40. */
    const piso = i === 0 ? ya + PRONTO_MIN.hasta : 0;
    const franjas: Franja[] = [];
    for (const [a, b] of tramosEl(fecha)) {
      for (let m = Math.ceil(Math.max(a, piso) / FRANJA_MIN) * FRANJA_MIN; m + FRANJA_MIN <= b; m += FRANJA_MIN) {
        franjas.push({ desde: instante(fecha, m), hasta: instante(fecha, m + FRANJA_MIN) });
      }
    }
    if (franjas.length) dias.push({ fecha, franjas });
  }
  return { conHorario, pronto, dias };
}

/** Lo que eligió el cliente, contra la agenda de AHORA: lo que queda guardado en el pedido, o por qué no vale. */
export function cuandoDe(dto: any, agenda: AgendaEnvios): { cuando: CuandoEnvio } | { error: string } {
  const tipo = String(dto?.tipo ?? '');
  if (tipo === 'whatsapp') return { cuando: { tipo } };
  if (tipo === 'pronto') {
    return agenda.pronto
      ? { cuando: { tipo, ...agenda.pronto } }
      : { error: 'Ahora el local está cerrado o por cerrar: elegí un horario o coordinalo por WhatsApp.' };
  }
  if (tipo === 'horario') {
    const t = Date.parse(String(dto?.desde ?? ''));
    const f = agenda.dias.flatMap((d) => d.franjas).find((x) => Date.parse(x.desde) === t);
    return f ? { cuando: { tipo, ...f } } : { error: 'Ese horario ya no está disponible: elegí otro.' };
  }
  return { error: '¿Para cuándo querés tu envío? Elegí una de las opciones.' };
}
