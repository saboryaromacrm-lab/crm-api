/**
 * LAS FECHAS QUE SE LE MANDAN A ARCA — la trampa que rompe en producción
 * ============================================================================
 * Es la §9.1 de la guía, y es la que más deploys se llevó puestos: **compila y
 * anda perfecto en la máquina de desarrollo**, y falla en el servidor con
 * "generationTime posee formato o dato inválido".
 *
 * LA CAUSA: la máquina donde se programa está en hora argentina y el servidor,
 * casi siempre, en UTC. Si la marca de tiempo se arma con los getters del
 * sistema (`getHours()`) y sin declarar el huso, ARCA la lee en el suyo y ve
 * una hora tres horas en el futuro — y la rechaza.
 *
 * DOS CANDADOS, y hacen falta los dos:
 *
 *  1. Las partes de la fecha salen de `Intl` con la zona horaria ESCRITA
 *     ('America/Argentina/Buenos_Aires'), nunca de los getters del proceso.
 *     Así da igual en qué huso corra el contenedor.
 *  2. El offset viaja EXPLÍCITO en el texto (`-03:00`). No es decorativo: es
 *     lo que le dice a ARCA cómo interpretar lo que le mandamos.
 *
 * El Dockerfile ya fija `TZ=America/Argentina/Buenos_Aires`, pero este módulo
 * NO se apoya en eso a propósito: si alguien cambia esa variable, o corre la
 * API fuera del contenedor, esto tiene que seguir dando lo mismo.
 */

const ZONA = 'America/Argentina/Buenos_Aires';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});

export interface PartesFecha {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
}

/** La fecha y hora EN ARGENTINA, sin importar el huso del proceso. */
export function partesArgentina(d: Date): PartesFecha {
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(d)) if (x.type !== 'literal') p[x.type] = x.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    // 'en-CA' con hour12:false devuelve 24 para la medianoche; ARCA quiere 00.
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

const dd = (n: number) => String(n).padStart(2, '0');

/**
 * El offset argentino de ESE instante, calculado del propio reloj.
 *
 * Podría ser `-03:00` fijo —Argentina no tiene horario de verano desde 2009—
 * pero derivarlo cuesta cuatro líneas y significa que, si alguna vez vuelve,
 * esto lo sigue solo en vez de mentir media parte del año.
 */
function offsetArgentina(d: Date): string {
  const p = partesArgentina(d);
  const comoSiFueraUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const instante = Math.floor(d.getTime() / 1000) * 1000;
  const minutos = Math.round((comoSiFueraUtc - instante) / 60_000);
  const signo = minutos < 0 ? '-' : '+';
  const abs = Math.abs(minutos);
  return `${signo}${dd(Math.floor(abs / 60))}:${dd(abs % 60)}`;
}

/**
 * Sello de tiempo para el ticket de acceso (WSAA): ISO 8601 con el offset
 * explícito. Ej: `2026-08-19T21:40:07-03:00`.
 */
export function selloWsaa(d: Date): string {
  const p = partesArgentina(d);
  return `${p.year}-${dd(p.month)}-${dd(p.day)}`
    + `T${dd(p.hour)}:${dd(p.minute)}:${dd(p.second)}${offsetArgentina(d)}`;
}

/**
 * Fecha del comprobante para el WSFE: `AAAAMMDD`, en hora ARGENTINA.
 *
 * Que sea la argentina y no la del servidor importa de verdad: entre las 21 y
 * las 24 de acá, en UTC ya es el día siguiente. Un comprobante fechado mañana
 * lo rechaza ARCA (para Concepto 1 la fecha tiene que caer dentro de ±5 días
 * de hoy), y si lo acepta queda con la fecha equivocada en el libro de IVA.
 */
export function fechaComprobante(d: Date): string {
  const p = partesArgentina(d);
  return `${p.year}${dd(p.month)}${dd(p.day)}`;
}

/** `AAAA-MM-DD` en hora argentina — el formato que pide el QR de la RG 4892. */
export function fechaQr(d: Date): string {
  const p = partesArgentina(d);
  return `${p.year}-${dd(p.month)}-${dd(p.day)}`;
}

/**
 * El vencimiento del CAE viene como `AAAAMMDD` y hay que guardarlo como fecha.
 * Se arma al MEDIODÍA argentino a propósito: un `new Date('2026-08-29')` se
 * parsea como medianoche UTC y, leído desde acá, retrocede al día anterior —
 * la misma trampa que ya nos comimos con los `<input type="date">`.
 */
export function parsearFechaArca(s: string): Date | null {
  const t = String(s ?? '').trim();
  if (!/^\d{8}$/.test(t)) return null;
  return new Date(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T12:00:00-03:00`);
}
