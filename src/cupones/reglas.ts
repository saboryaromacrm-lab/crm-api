/**
 * CUPONES DE LA TIENDA MINORISTA: LAS REGLAS Y LA CUENTA (0190, 20/10/2026)
 * ============================================================================
 * Sin base de datos: qué cupón vale en este momento para este pedido, y cuánto
 * descuenta en cada renglón. La usan la cotización del checkout y el alta del
 * pedido: una sola cuenta, así lo que ve el cliente es lo que se le cobra.
 *
 * LA PLATA:
 *   · corre en los productos SIN oferta (una oferta ya tiene su beneficio y no
 *     se suman, como el descuento del barrio) y, si el cupón las tiene, de esas
 *     marcas o categorías;
 *   · se aplica DESPUÉS del descuento del barrio, sobre lo que queda: el renglón
 *     termina con 1 − (1 − barrio)(1 − cupón);
 *   · un monto fijo se reparte en proporción entre los renglones que entran;
 *   · nunca más del 95 % de lo que entra (`MAX_FRACCION`): un cupón no regala la
 *     mercadería, y la caja necesita poder separar lo que fue cupón.
 */

export const TIPOS_CUPON = ['porcentaje', 'monto', 'envio_gratis'] as const;
export type TipoCupon = (typeof TIPOS_CUPON)[number];
/** Los medios con los que se coordina el pago de la tienda: los únicos que un cupón puede pedir. */
export const MEDIOS_TIENDA = ['efectivo', 'transferencia'] as const;
export const ENTREGAS_CUPON = ['', 'retiro', 'envio'] as const;
export const MAX_FRACCION = 0.95;
const ZONA = 'America/Argentina/Buenos_Aires';

export interface Cupon {
  id?: number;
  codigo: string;
  activo: boolean;
  tipo: TipoCupon;
  valor: number;
  tope: number;
  montoMinimo: number;
  desde: Date | string | null;
  hasta: Date | string | null;
  dias: string;
  horaDesde: string;
  horaHasta: string;
  mediosPago: string;
  entrega: string;
  marcas: string;
  categorias: string;
  usosMax: number;
  usosPorCliente: number;
  soloPrimeraCompra: boolean;
}

/** Lo que hace falta saber del pedido para decidir si el cupón vale. */
export interface Contexto {
  ahora: Date;
  entrega: 'retiro' | 'envio';
  /** El medio que eligió el cliente (null = todavía no eligió). */
  medioPago: string | null;
  /** Lo que lleva en productos, final con IVA, después del descuento del barrio. */
  subtotal: number;
  /** Pedidos que ya usaron el cupón (sin los rechazados) y cuántos de ellos son de este cliente. */
  usos: number;
  usosCliente: number;
  /** Es su primera compra en la tienda. */
  primeraCompra: boolean;
}

/** Un renglón del pedido como lo arma la tienda (precio de lista NETO por unidad, % de descuento). */
export interface Renglon {
  productoId: number;
  marcaId: number | null;
  categoriaId: number | null;
  ofertaId: number | null;
  cantidad: number;
  precioLista: number;
  iva: number;
  descuento: number;
}

const c2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
/** El % del renglón a 6 decimales: sin el ruido binario de 1 − 0,9 (9,999999999999998). */
const pct6 = (n: number) => Math.round(n * 1e6) / 1e6;
const csv = (s: string) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const NOMBRES_DIA = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados', 'domingos'];
const pesos = (n: number) => `$${Math.round(n).toLocaleString('es-AR')}`;
const fechaAr = (d: Date) => d.toLocaleDateString('es-AR', { timeZone: ZONA, day: 'numeric', month: 'numeric', year: 'numeric' });
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Día (0 = lunes) y hora 'HH:MM' de un instante, en Argentina. */
export function momentoAr(d: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONA, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).map((x) => [x.type, x.value]));
  const dia = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday);
  return { dia, hora: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}

/** ¿La hora cae en la franja? Si `desde` > `hasta`, la franja cruza la medianoche (22:00 → 02:00). */
export function enFranja(hora: string, desde: string, hasta: string) {
  if (!desde && !hasta) return true;
  const d = desde || '00:00';
  const h = hasta || '23:59';
  return d <= h ? hora >= d && hora <= h : hora >= d || hora <= h;
}

/** «lunes, martes y viernes»: los días de la máscara, para el aviso. */
export function diasLegibles(mascara: string) {
  const ds = NOMBRES_DIA.filter((_, i) => mascara[i] === '1');
  return ds.length > 1 ? `${ds.slice(0, -1).join(', ')} y ${ds[ds.length - 1]}` : ds[0] ?? '';
}

/** Una definición válida o el motivo por el que no lo es (para el formulario del ERP). */
export function errorDeCupon(c: Cupon): string | null {
  if (!/^[A-Z0-9_-]{3,30}$/.test(c.codigo)) return 'El código va de 3 a 30 letras, números, guiones o guiones bajos, sin espacios.';
  if (!TIPOS_CUPON.includes(c.tipo)) return 'Tipo de cupón inválido.';
  if (c.tipo === 'porcentaje' && !(c.valor >= 1 && c.valor <= MAX_FRACCION * 100)) return `El porcentaje va de 1 a ${MAX_FRACCION * 100} %.`;
  if (c.tipo === 'monto' && !(c.valor > 0)) return 'El monto del cupón tiene que ser mayor a cero.';
  if (c.tope < 0 || c.montoMinimo < 0) return 'El tope y el monto mínimo no pueden ser negativos.';
  if (c.tipo === 'monto' && c.montoMinimo > 0 && c.valor > c.montoMinimo) return 'Un cupón de monto no puede descontar más que la compra mínima que pide.';
  if (c.dias && !/^[01]{7}$/.test(c.dias)) return 'Los días van como máscara de 7 (lunes a domingo).';
  if (c.dias === '0000000') return 'El cupón no vale ningún día.';
  if ((c.horaDesde && !HORA.test(c.horaDesde)) || (c.horaHasta && !HORA.test(c.horaHasta))) return 'Las horas van como 09:30.';
  if (csv(c.mediosPago).some((m) => !(MEDIOS_TIENDA as readonly string[]).includes(m))) return 'En la tienda se paga en efectivo o transferencia.';
  if (!(ENTREGAS_CUPON as readonly string[]).includes(c.entrega)) return 'Entrega inválida.';
  if (c.tipo === 'envio_gratis' && c.entrega === 'retiro') return 'Un cupón de envío gratis no puede ser solo para retirar.';
  if (!Number.isInteger(c.usosMax) || c.usosMax < 0 || !Number.isInteger(c.usosPorCliente) || c.usosPorCliente < 0) return 'Los usos son números enteros (0 = sin tope).';
  if (c.desde && c.hasta && new Date(c.desde) > new Date(c.hasta)) return 'La vigencia termina antes de empezar.';
  return null;
}

/** ¿El renglón entra en el cupón? Sin oferta y, si el cupón las tiene, de sus marcas o categorías. */
export function entra(c: Pick<Cupon, 'marcas' | 'categorias'>, r: Renglon) {
  if (r.ofertaId) return false;
  const marcas = csv(c.marcas).map(Number);
  const cats = csv(c.categorias).map(Number);
  if (marcas.length && !(r.marcaId && marcas.includes(r.marcaId))) return false;
  if (cats.length && !(r.categoriaId && cats.includes(r.categoriaId))) return false;
  return true;
}

/** Lo que el renglón cuesta al cliente, final con IVA. */
export const finalDe = (r: Renglon) => r.cantidad * r.precioLista * (1 - r.descuento / 100) * (1 + r.iva / 100);

/**
 * Por qué el cupón NO vale ahora para este pedido (en palabras para el
 * cliente), o null si vale. Lo de los productos se mira en `aplicar`.
 */
export function motivoNoVale(c: Cupon, x: Contexto): string | null {
  if (!c.activo) return 'Ese cupón no existe o ya no está activo.';
  if (c.desde && x.ahora < new Date(c.desde)) return `Este cupón vale desde el ${fechaAr(new Date(c.desde))}.`;
  if (c.hasta && x.ahora > new Date(c.hasta)) return `Este cupón venció el ${fechaAr(new Date(c.hasta))}.`;
  const { dia, hora } = momentoAr(x.ahora);
  if (c.dias && c.dias[dia] !== '1') return `Este cupón vale solo los ${diasLegibles(c.dias)}.`;
  if (!enFranja(hora, c.horaDesde, c.horaHasta)) return `Este cupón vale de ${c.horaDesde || '00:00'} a ${c.horaHasta || '23:59'} h.`;
  if (c.entrega === 'envio' && x.entrega !== 'envio') return 'Este cupón vale solo con envío a domicilio.';
  if (c.entrega === 'retiro' && x.entrega !== 'retiro') return 'Este cupón vale solo retirando en el local.';
  if (c.tipo === 'envio_gratis' && x.entrega !== 'envio') return 'Es un cupón de envío gratis: elegí envío a domicilio.';
  const medios = csv(c.mediosPago);
  if (medios.length && x.medioPago && !medios.includes(x.medioPago)) return `Este cupón vale pagando con ${medios.join(' o ')}.`;
  if (c.soloPrimeraCompra && !x.primeraCompra) return 'Este cupón es solo para tu primera compra.';
  if (c.usosMax > 0 && x.usos >= c.usosMax) return 'Se agotaron los usos de este cupón.';
  if (c.usosPorCliente > 0 && x.usosCliente >= c.usosPorCliente) {
    return c.usosPorCliente === 1 ? 'Ya usaste este cupón.' : `Ya usaste este cupón las ${c.usosPorCliente} veces que permite.`;
  }
  if (c.montoMinimo > 0 && x.subtotal + 0.005 < c.montoMinimo) {
    return `Este cupón vale con compras desde ${pesos(c.montoMinimo)}: te faltan ${pesos(c.montoMinimo - x.subtotal)}.`;
  }
  return null;
}

export type Aplicado =
  | { vale: false; motivo: string }
  | {
    vale: true;
    /** La fracción que el cupón saca de cada renglón que entra. */
    fraccion: number;
    /** Lo que descuenta en la mercadería, final con IVA. */
    descuento: number;
    /** Envío gratis: el envío pasa a 0. */
    envioGratis: boolean;
    /** Medios que pide (vacío = cualquiera): el checkout pregunta si hace falta. */
    medios: string[];
    /** Los renglones con su nuevo descuento y la parte del cupón (`cuponPct`). */
    renglones: (Renglon & { cuponPct: number })[];
  };

/** El cupón sobre el pedido: si vale, cuánto descuenta y cómo queda cada renglón. */
export function aplicar(c: Cupon, renglones: Renglon[], x: Contexto): Aplicado {
  const motivo = motivoNoVale(c, x);
  if (motivo) return { vale: false, motivo };
  const medios = csv(c.mediosPago);
  const sinCambio = renglones.map((r) => ({ ...r, cuponPct: 0 }));
  if (c.tipo === 'envio_gratis') return { vale: true, fraccion: 0, descuento: 0, envioGratis: true, medios, renglones: sinCambio };

  const base = renglones.filter((r) => entra(c, r)).reduce((s, r) => s + finalDe(r), 0);
  if (!(base > 0)) {
    return { vale: false, motivo: 'Ninguno de los productos del carrito entra en este cupón (los que ya están en oferta no suman).' };
  }
  let fraccion = c.tipo === 'porcentaje' ? c.valor / 100 : c.valor / base;
  if (c.tipo === 'porcentaje' && c.tope > 0 && base * fraccion > c.tope) fraccion = c.tope / base;
  fraccion = Math.min(fraccion, MAX_FRACCION);
  return {
    vale: true,
    fraccion,
    descuento: c2(base * fraccion),
    envioGratis: false,
    medios,
    renglones: renglones.map((r) => (entra(c, r)
      ? { ...r, descuento: pct6(100 * (1 - (1 - r.descuento / 100) * (1 - fraccion))), cuponPct: fraccion }
      : { ...r, cuponPct: 0 })),
  };
}

type Valido = Extract<Aplicado, { vale: true }>;

/**
 * LOS AUTOMÁTICOS (0199): de los que se evaluaron sin medio elegido, el mejor
 * para cada medio de pago (uno sin medios vale con cualquiera) y el mejor de
 * los que valen con cualquiera (`todos`: el que corre antes de elegir). Gana
 * el que más descuenta; a igual descuento, el que regala el envío.
 */
export function mejorPorMedio<T extends { resultado: Aplicado }>(evaluados: T[]) {
  type V = T & { resultado: Valido };
  const validos = evaluados.filter((e): e is V => e.resultado.vale);
  const puntaje = (e: V) => e.resultado.descuento + (e.resultado.envioGratis ? 0.001 : 0);
  const mejor = (lista: V[]) => lista.reduce<V | null>((a, e) => (!a || puntaje(e) > puntaje(a) ? e : a), null);
  const conCualquiera = validos.filter((e) => !e.resultado.medios.length);
  return {
    todos: mejor(conCualquiera),
    porMedio: Object.fromEntries(MEDIOS_TIENDA.map((m) => [m, mejor(validos.filter((e) => !e.resultado.medios.length || e.resultado.medios.includes(m)))])) as
      Record<(typeof MEDIOS_TIENDA)[number], V | null>,
  };
}

/**
 * Lo que el cupón descontó en un renglón de VENTA, neto: `bonificado` es lo
 * que quedó después de todos los % (cantidad × precio × (1 − descuento)), y el
 * cupón fue la última capa, así que antes de él había bonificado / (1 − f).
 */
export const descuentoCuponNeto = (bonificado: number, fraccion: number) => (
  fraccion > 0 && fraccion < 1 ? (bonificado * fraccion) / (1 - fraccion) : 0
);
