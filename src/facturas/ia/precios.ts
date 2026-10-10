/**
 * LO QUE CUESTA CADA LLAMADA (0153). Precios oficiales de Anthropic al
 * 9/10/2026, en dólares por millón de tokens (platform.claude.com › Pricing).
 * Si Anthropic los cambia, se cambian acá: el consumo guardado de antes queda
 * con el precio de su día.
 */
import type { Uso } from './anthropic';

type Precio = { entrada: number; salida: number; cacheEscritura: number; cacheLectura: number };

const PRECIOS: Record<string, Precio> = {
  /* Haiku 5.5 hasta 100.000 tokens por pedido (una factura no llega ni cerca). */
  'claude-haiku-5-5': { entrada: 0.10, salida: 0.50, cacheEscritura: 0.125, cacheLectura: 0.01 },
  'claude-sonnet-5-5': { entrada: 2, salida: 10, cacheEscritura: 2.5, cacheLectura: 0.10 },
  'claude-opus-5-5': { entrada: 4, salida: 20, cacheEscritura: 5, cacheLectura: 0.20 },
  'claude-haiku-4-5': { entrada: 1, salida: 5, cacheEscritura: 1.25, cacheLectura: 0.10 },
};
/** Un modelo que no está en la tabla se cuenta al precio del más caro de arriba: mejor sobrestimar el tope que pasarlo. */
const DESCONOCIDO: Precio = PRECIOS['claude-opus-5-5'];

export const precioDe = (modelo: string): Precio => PRECIOS[modelo] ?? PRECIOS[modelo.replace(/-\d{8}$/, '')] ?? DESCONOCIDO;

/** USD de una llamada (con 6 decimales: una lectura con Haiku cuesta décimas de centavo). */
export function costoUsd(modelo: string, u: Uso): number {
  const p = precioDe(modelo);
  const usd = (u.entrada * p.entrada + u.salida * p.salida + u.cacheEscritura * p.cacheEscritura + u.cacheLectura * p.cacheLectura) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
