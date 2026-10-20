/**
 * MÉTRICAS › OFERTAS: LAS CUENTAS (0189, 20/10/2026), sin base de datos.
 *
 * La plata se mide como en el resto de Métricas: todo NETO (sin IVA) y la
 * ganancia solo sobre renglones con costo congelado (`costeado − costo`). Lo
 * que no tiene costo no se inventa: se avisa.
 */

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** Unidades separadas por cómo se cuentan: el granel suelto en kg, el resto en unidades. */
export type Cantidades = { u: number; kg: number };
export const sumar = (a: Cantidades, b: Cantidades): Cantidades => ({ u: a.u + b.u, kg: a.kg + b.kg });
export const CERO: Cantidades = { u: 0, kg: 0 };
export const enUnidad = (unidad: 'u' | 'kg', n: number): Cantidades => (unidad === 'kg' ? { u: 0, kg: n } : { u: n, kg: 0 });

export interface Vendido {
  neto: number;
  costeado: number;
  costo: number;
  /** Lo que la oferta descontó (neto); `descuentoCosteado`, solo en renglones con costo. */
  descuento: number;
  descuentoCosteado: number;
  renglones: number;
  sinCosto: number;
}

/** Ganancia, margen y lo que habría dejado el mismo volumen a precio normal. */
export function resultado(v: Vendido) {
  const ganancia = v.costeado - v.costo;
  return {
    ganancia: r2(ganancia),
    /** Sobre lo vendido con costo: de cada $100 vendidos, cuánto quedó. */
    margen: v.costeado > 0 ? r2((ganancia / v.costeado) * 100) : null,
    /** Sobre el costo: cuánto se ganó por cada $100 de mercadería. */
    sobreCosto: v.costo > 0 ? r2((ganancia / v.costo) * 100) : null,
    /** Mismas unidades sin la oferta (lo que costó la oferta se suma de vuelta). */
    gananciaNormal: r2(ganancia + v.descuentoCosteado),
  };
}

export type Veredicto = 'sin_ventas' | 'sin_costo' | 'pierde' | 'al_costo' | 'rentable';

/**
 * ¿La oferta deja plata? Con una tolerancia de $1 o el 1 % del costo —lo que
 * sea mayor— para no llamar «pierde» al redondeo de una oferta al costo.
 */
export function veredicto(v: Vendido): Veredicto {
  if (v.renglones === 0 && Math.abs(v.neto) < 0.005) return 'sin_ventas';
  if (v.costeado === 0) return 'sin_costo';
  const ganancia = v.costeado - v.costo;
  const tolerancia = Math.max(1, Math.abs(v.costo) * 0.01);
  if (ganancia < -tolerancia) return 'pierde';
  if (ganancia <= tolerancia) return 'al_costo';
  return 'rentable';
}

/** Lo de un tramo de días, por día. */
export function porDia(t: { cant: Cantidades; neto: number; ganancia: number }, dias: number) {
  const d = Math.max(1, dias);
  return { u: r2(t.cant.u / d), kg: r2(t.cant.kg / d), neto: r2(t.neto / d), ganancia: r2(t.ganancia / d) };
}

/** «Vendió 2,5 veces más rápido»: cuántas veces el ritmo de antes (null si antes no se vendía). */
export function vecesMas(antes: number, durante: number) {
  return antes > 0 ? Math.round((durante / antes) * 10) / 10 : null;
}

/** El % del stock inicial que se vendió con la oferta (solo si se cuenta en una sola unidad). */
export function vendidoDelStock(inicial: Cantidades, vendido: Cantidades) {
  if (inicial.u > 0 && inicial.kg === 0) return r2((vendido.u / inicial.u) * 100);
  if (inicial.kg > 0 && inicial.u === 0) return r2((vendido.kg / inicial.kg) * 100);
  return null;
}

/** Días entre dos fechas 'AAAA-MM-DD', inclusive. */
export function diasEntre(desde: string, hasta: string) {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000) + 1;
}
