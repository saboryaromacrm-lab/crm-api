/**
 * QUÉ FERIADOS TIENE FORMOSA CAPITAL EN UN AÑO (19/10/2026, pedido del dueño).
 * ============================================================================
 * Regla pura (sin base) para «Traer feriados de AAAA»:
 *   · los NACIONALES, de ArgentinaDatos (api.argentinadatos.com, que sigue los
 *     decretos de cada año): inamovibles y trasladables son FERIADO; los
 *     puentes turísticos, DÍA NO LABORABLE;
 *   · el JUEVES SANTO, día no laborable nacional (Ley 27.399): el día antes del
 *     Viernes Santo de esa misma lista;
 *   · los de FORMOSA que caen siempre el mismo día (calendario del Poder
 *     Judicial de Formosa, «Días no laborables - Feriados provinciales»).
 * Los nombres son los mismos que cargó la migración 0182 para 2025 y 2026: así
 * volver a traer un año no duplica nada (único por fecha + nombre).
 */
export const TIPOS_FERIADO = ['feriado', 'no_laborable'] as const;
export const ALCANCES_FERIADO = ['nacional', 'provincial', 'municipal'] as const;
export type TipoFeriado = (typeof TIPOS_FERIADO)[number];
export type AlcanceFeriado = (typeof ALCANCES_FERIADO)[number];
export interface FeriadoNuevo { fecha: string; nombre: string; tipo: TipoFeriado; alcance: AlcanceFeriado }
/** Una fila de `GET https://api.argentinadatos.com/v1/feriados/{año}`. */
export interface FeriadoArgentinaDatos { fecha: string; tipo: string; nombre: string }

/** El aviso de toda la app: los que caen de hoy a 10 días. */
export const DIAS_AVISO = 10;

export const FIJOS_FORMOSA: { mes: number; dia: number; nombre: string }[] = [
  { mes: 4, dia: 8, nombre: 'Aniversario de la fundación de Formosa (1879)' },
  { mes: 6, dia: 28, nombre: 'Provincialización de Formosa (1955)' },
  { mes: 7, dia: 16, nombre: 'Nuestra Señora del Carmen, patrona de la provincia de Formosa' },
];
export const JUEVES_SANTO = 'Jueves Santo';

const dosCifras = (n: number) => String(n).padStart(2, '0');
/** El día anterior de un 'AAAA-MM-DD' (a mediodía UTC: sin saltos de horario). */
const diaAnterior = (fecha: string) => new Date(Date.parse(`${fecha}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

export function feriadosDelAnio(anio: number, nacionales: FeriadoArgentinaDatos[]): FeriadoNuevo[] {
  const delAnio = nacionales.filter((f) => typeof f?.fecha === 'string' && f.fecha.startsWith(`${anio}-`) && String(f.nombre ?? '').trim());
  const lista: FeriadoNuevo[] = delAnio.map((f) => ({
    fecha: f.fecha, nombre: f.nombre.trim(), tipo: f.tipo === 'puente' ? 'no_laborable' : 'feriado', alcance: 'nacional',
  }));
  const viernesSanto = delAnio.find((f) => /viernes santo/i.test(f.nombre));
  if (viernesSanto) lista.push({ fecha: diaAnterior(viernesSanto.fecha), nombre: JUEVES_SANTO, tipo: 'no_laborable', alcance: 'nacional' });
  for (const f of FIJOS_FORMOSA) {
    lista.push({ fecha: `${anio}-${dosCifras(f.mes)}-${dosCifras(f.dia)}`, nombre: f.nombre, tipo: 'no_laborable', alcance: 'provincial' });
  }
  return lista.sort((a, b) => a.fecha.localeCompare(b.fecha));
}
