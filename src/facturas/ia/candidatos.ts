/**
 * ¿QUÉ PRODUCTO ES "AVENA INSTANT FWP CUM10x400g"? (0153)
 * ============================================================================
 * Puntaje por tokens del NOMBRE DEL PRODUCTO (que está limpio) buscados en la
 * descripción del papel (que viene rota: "AJ O GRANULADO"). Se compara con
 * `clave()` —sin espacios— porque los espacios del papel no son confiables. Un
 * token cuenta si aparece entero o por su prefijo (INSTANTANEA en INSTANT).
 *
 * Sirve para dos cosas: proponer el producto cuando hay UNO claro (puntaje
 * ≥ 0,6 y sin empate: mejor un renglón sin producto que uno equivocado) y
 * armar los CANDIDATOS de un renglón desconocido, que se muestran para el
 * mapeo a mano y se le pasan a la IA si se le pide que elija.
 */
import { clave } from '../comun';

export type Producto = { id: number; nombre: string };

/** Los tokens de un nombre (de 3 letras o más), ya en clave. Se arman una vez por catálogo. */
export const tokensDe = (nombre: string) => String(nombre).split(/\s+/).map(clave).filter((t) => t.length >= 3);

export function puntaje(desc: string, tokens: string[]) {
  if (!desc || !tokens.length) return 0;
  let hits = 0;
  for (const t of tokens) if (desc.includes(t) || (t.length > 4 && desc.includes(t.slice(0, 4)))) hits++;
  return hits / tokens.length;
}

/** Los `n` productos más parecidos a la descripción, con su puntaje (los que no comparten nada, afuera). */
export function candidatos<P extends Producto>(descripcion: string, catalogo: (P & { tokens?: string[] })[], n = 5) {
  const desc = clave(descripcion);
  return catalogo
    .map((p) => ({ p, score: puntaje(desc, p.tokens ?? tokensDe(p.nombre)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.nombre.length - b.p.nombre.length)
    .slice(0, n);
}

/** El producto, si hay UNO claro: puntaje ≥ 0,6 y sin empate con otro. */
export function elegido<P extends Producto>(lista: { p: P; score: number }[]) {
  const [a, b] = lista;
  if (!a || a.score < 0.6 || (b && b.score === a.score)) return null;
  return { ...a.p, confianza: Math.round(a.score * 100) / 100 };
}
