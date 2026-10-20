/**
 * LAS REGLAS DEL ENVÍO POR BARRIO (0185), sin base de datos: en qué barrio cae
 * un punto, qué promo rige hoy y cuánto sale el envío. Las usan la cotización
 * del checkout y el alta del pedido (el servidor decide, nunca el navegador),
 * y los avisos de la portada.
 */

export interface Punto { lat: number; lng: number }
/** El contorno: [[lat, lng], …]. */
export type Poligono = [number, number][];

export interface Barrio { id: number; nombre: string; poligono: Poligono; costoEnvio: number | null }

export const TIPOS_PROMO = ['envio_gratis', 'envio_fijo', 'descuento'] as const;
export type TipoPromo = (typeof TIPOS_PROMO)[number];
export interface PromoBarrio {
  id: number; barrioIds: number[]; tipo: TipoPromo; valor: number;
  /** 0 = domingo; vacío = todos los días. */
  dias: number[]; desde: string | null; hasta: string | null; minimo: number; activa: boolean;
}

/** Topes del contorno: un triángulo como mínimo; 400 puntos sobran para el barrio más enrevesado. */
export const MIN_PUNTOS = 3;
export const MAX_PUNTOS = 400;

const enRango = (n: unknown, max: number) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= max;

/** Un punto del mapa válido, o null. */
export function puntoValido(raw: any): Punto | null {
  return raw && enRango(raw.lat, 90) && enRango(raw.lng, 180) ? { lat: raw.lat, lng: raw.lng } : null;
}

/** El contorno limpio, o null si no es un polígono usable. */
export function poligonoValido(raw: unknown): Poligono | null {
  if (!Array.isArray(raw) || raw.length < MIN_PUNTOS || raw.length > MAX_PUNTOS) return null;
  const pol = raw.map((p) => (Array.isArray(p) && enRango(p[0], 90) && enRango(p[1], 180) ? [p[0], p[1]] as [number, number] : null));
  return pol.every(Boolean) ? (pol as Poligono) : null;
}

/** ¿El punto cae adentro del contorno? (rayo hacia el este: cuenta los bordes que cruza). */
export function dentro(pol: Poligono, p: Punto): boolean {
  let adentro = false;
  for (let i = 0, j = pol.length - 1; i < pol.length; j = i++) {
    const [latI, lngI] = pol[i];
    const [latJ, lngJ] = pol[j];
    if ((latI > p.lat) !== (latJ > p.lat) && p.lng < ((lngJ - lngI) * (p.lat - latI)) / (latJ - latI) + lngI) adentro = !adentro;
  }
  return adentro;
}

/** El barrio del punto: el primero que lo contiene (en el ERP se ven los otros al dibujar, para no superponerlos). */
export function barrioDe<B extends Barrio>(barrios: B[], p: Punto | null): B | null {
  return p ? barrios.find((b) => dentro(b.poligono, p)) ?? null : null;
}

/** Día de la semana de una fecha 'AAAA-MM-DD' (0 = domingo), sin depender del huso del proceso. */
export const diaDeSemana = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay();

/** ¿La promo rige el día `hoy` ('AAAA-MM-DD', en Argentina)? */
export function vigente(p: PromoBarrio, hoy: string): boolean {
  if (!p.activa) return false;
  if (p.desde && hoy < p.desde) return false;
  if (p.hasta && hoy > p.hasta) return false;
  return !p.dias.length || p.dias.includes(diaDeSemana(hoy));
}

const pesos = (n: number) => `$${Math.round(n).toLocaleString('es-AR')}`;
/** «Independencia», «Independencia y San Miguel», «A, B y C». */
const enumerar = (nombres: string[]) => (nombres.length < 2 ? nombres.join('') : `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}`);

/** Lo que la promo da, en palabras del cliente: «Envío gratis a Independencia en compras desde $20.000». */
export function describirPromo(p: PromoBarrio, nombreDe: Map<number, string>): string {
  const donde = enumerar(p.barrioIds.map((id) => nombreDe.get(id)).filter((n): n is string => !!n));
  const que = p.tipo === 'envio_gratis' ? `Envío gratis a ${donde}`
    : p.tipo === 'envio_fijo' ? `Envío a ${pesos(p.valor)} a ${donde}`
      : `${p.valor}% de descuento en ${donde}`;
  return p.minimo > 0 ? `${que} en compras desde ${pesos(p.minimo)}` : que;
}

/** De lunes a domingo, como se lee una semana (0 = domingo). */
const SEMANA = [1, 2, 3, 4, 5, 6, 0];
const NOMBRE_DIA = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados'];
const fechaCorta = (iso: string) => iso.split('-').reverse().slice(0, 2).join('/');

/** Cuándo rige, en palabras: «Todos los días», «Los martes y jueves · del 01/11 al 07/11». */
export function describirCuando(p: PromoBarrio): string {
  const nombres = SEMANA.filter((d) => p.dias.includes(d)).map((d) => NOMBRE_DIA[d]);
  const dias = nombres.length ? `Los ${enumerar(nombres)}` : 'Todos los días';
  const rango = p.desde && p.hasta ? `del ${fechaCorta(p.desde)} al ${fechaCorta(p.hasta)}`
    : p.desde ? `desde el ${fechaCorta(p.desde)}` : p.hasta ? `hasta el ${fechaCorta(p.hasta)}` : '';
  return rango ? `${dias} · ${rango}` : dias;
}

/** Lo que paga el cliente por recibir en ese barrio, hoy, con ese subtotal. */
export interface Condiciones {
  /** Costo del envío; 0 = gratis; null = sin costo definido (se coordina por WhatsApp). */
  envio: number | null;
  /** % sobre los renglones SIN oferta (un renglón en oferta ya tiene su beneficio: no se suman). */
  descuentoPct: number;
  /** Las promos que se están usando, para mostrarlas. */
  aplicadas: PromoBarrio[];
  /** La promo de hoy del barrio más cerca de alcanzarse por monto, y cuánto falta. */
  proxima: { promo: PromoBarrio; faltan: number } | null;
}

/**
 * LA CUENTA. Candidatos al costo del envío: el del barrio, el «gratis desde»
 * general y las promos de envío de hoy que se alcanzan; GANA EL MÁS BARATO.
 * El descuento: el mayor de las promos de descuento que se alcanzan (nunca se
 * suman, como los descuentos de la caja). Los mínimos se miden contra el
 * subtotal de los productos, antes del descuento.
 */
export function condiciones(
  barrio: Barrio | null, promos: PromoBarrio[], subtotal: number, gratisDesde: number, hoy: string,
): Condiciones {
  const deHoy = barrio ? promos.filter((p) => p.barrioIds.includes(barrio.id) && vigente(p, hoy)) : [];
  const alcanzadas = deHoy.filter((p) => subtotal >= p.minimo);
  const costoDe = (p: PromoBarrio) => (p.tipo === 'envio_gratis' ? 0 : p.valor);
  const deEnvio = alcanzadas.filter((p) => p.tipo !== 'descuento');

  const costos = deEnvio.map(costoDe);
  if (barrio?.costoEnvio != null) costos.push(barrio.costoEnvio);
  if (gratisDesde > 0 && subtotal >= gratisDesde) costos.push(0);
  const envio = costos.length ? Math.min(...costos) : null;
  const descuentoPct = Math.max(0, ...alcanzadas.filter((p) => p.tipo === 'descuento').map((p) => p.valor));

  /* Se muestran las que dan el resultado: la de envío que fija el costo (si es menor que el del barrio) y la de descuento ganadora. */
  const aplicadas = [
    ...deEnvio.filter((p) => costoDe(p) === envio && (barrio?.costoEnvio == null || costoDe(p) < barrio.costoEnvio)).slice(0, 1),
    ...alcanzadas.filter((p) => p.tipo === 'descuento' && p.valor === descuentoPct).slice(0, 1),
  ];
  const proxima = deHoy
    .filter((p) => subtotal < p.minimo && (p.tipo === 'descuento' ? p.valor > descuentoPct : envio == null || costoDe(p) < envio))
    .map((promo) => ({ promo, faltan: promo.minimo - subtotal }))
    .sort((a, b) => a.faltan - b.faltan)[0] ?? null;
  return { envio, descuentoPct, aplicadas, proxima };
}
