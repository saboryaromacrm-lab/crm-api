/**
 * EL HORARIO DE UN DÍA: hasta tres tramos «HH:MM-HH:MM» separados por coma;
 * vacío = cerrado. El ERP lo arma con relojes, pero un PUT a mano no: se
 * toman las horas de a pares (también «8 a 13 y 17 a 21») y lo que no es una
 * hora válida, o un tramo que termina antes de empezar, deja el día cerrado o
 * fuera ese tramo — nunca llega a Google un horario inventado.
 */
export const DIAS_SEMANA = ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'] as const;
export function horarioDelDia(v: string): string {
  const horas = [...String(v ?? '').matchAll(/(\d{1,2})(?:[:.h](\d{2}))?/g)]
    .map(([, h, m = '00']) => (Number(h) <= 24 && Number(m) < 60 ? `${h.padStart(2, '0')}:${m}` : ''));
  if (horas.some((h) => !h)) return '';
  const tramos: string[] = [];
  for (let i = 0; i + 1 < horas.length && tramos.length < 3; i += 2) {
    if (horas[i] < horas[i + 1]) tramos.push(`${horas[i]}-${horas[i + 1]}`);
  }
  return tramos.join(', ');
}
