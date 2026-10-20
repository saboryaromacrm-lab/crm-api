/**
 * ALCANCE Y VIGENCIA DE UNA OFERTA, LADO SERVIDOR
 * ============================================================================
 * Las MISMAS reglas que el motor del POS aplica en la caja
 * (dashboard/modules/ventas/domain/ofertas.js). Viven acá para que todo lo que
 * se resuelve en el servidor —el cruce con Vencimientos, la foto del stock al
 * empezar la oferta (0189), Métricas— opine igual que la caja: si el motor
 * dice que la oferta alcanza al producto, acá también.
 */
import { inArray } from 'drizzle-orm';
import type { Database } from '../db/drizzle';
import { productoEtiquetas, productos } from '../db/schema';

/** Lo que hace falta de un producto para resolver los alcances. */
export interface ProductoAlcance { id: number; marcaId: number | null; categoriaId: number | null; etiquetas: number[] }

/**
 * ¿El alcance de la oferta llega a ESTE artículo? Varias filas = unión.
 *
 * `presId` distingue el paquete fraccionado de su madre (0054): los cuatro
 * alcances de siempre se resuelven con datos de la madre y el paquete los
 * heredaría todos, así que al paquete solo lo alcanzan si la oferta tiene el
 * tilde `incluyeFraccionados`. El alcance `presentacion` es al revés: apunta a
 * un paquete y NO alcanza al granel suelto.
 */
export function alcanzaProducto(o: any, p: ProductoAlcance, presId: number | null = null) {
  // El de ticket alcanza al total del ticket, no a productos.
  if (o.tipo === 'ticket') return false;
  // El del combo son sus componentes (no usa filas de alcance).
  if (o.tipo === 'combo') return (o.componentes ?? []).some((c: any) => c.productoId === p.id);
  return (o.alcances ?? []).some((a: any) => {
    if (a.tipo === 'presentacion') return presId != null && a.refId === presId;
    if (presId != null && !o.incluyeFraccionados) return false;
    switch (a.tipo) {
      case 'producto': return a.refId === p.id;
      case 'marca': return a.refId === p.marcaId;
      case 'categoria': return a.refId === p.categoriaId;
      case 'etiqueta': return p.etiquetas.includes(a.refId);
      default: return false;
    }
  });
}

/** '' = todas las sucursales; si no, la lista CSV manda. */
export function cubreSucursal(o: any, sucursalId: number) {
  const ids = String(o.sucursales || '').split(',').map((x) => x.trim()).filter(Boolean);
  return !ids.length || ids.includes(String(sucursalId));
}

/** Estado calculado, igual que el panel de Ventas: por qué (no) está corriendo. */
export function estadoOferta(o: any, ahora: Date) {
  if (!o.activa) return 'inactiva';
  if (o.desde && ahora < new Date(o.desde)) return 'programada';
  if (o.hasta && ahora > new Date(o.hasta)) return 'vencida';
  return 'vigente';
}

/**
 * Cuándo empezó a correr de verdad: no antes de existir (una con «desde»
 * pasado arrancó al crearse). Las anteriores a la 0187 no saben cuándo se
 * crearon: vale su «desde», y sin él no se sabe (`null`).
 */
export function inicioOferta(o: { desde: Date | string | null; creadoEn: Date | string | null }): Date | null {
  const desde = o.desde ? new Date(o.desde) : null;
  if (!o.creadoEn) return desde;
  const creada = new Date(o.creadoEn);
  return desde && desde > creada ? desde : creada;
}

/** Una foto del stock tomada hasta 15 minutos después de que arrancó la oferta cuenta como «al empezar» (0189). */
export const MARGEN_AL_EMPEZAR_MS = 15 * 60_000;

/** Productos con lo necesario para resolver los alcances (todos, o solo esos ids). */
export async function productosParaAlcance(db: Database, ids?: number[]) {
  const base = db.select({
    id: productos.id, nombre: productos.nombre, estado: productos.estado, tipo: productos.tipo,
    marcaId: productos.marcaId, categoriaId: productos.categoriaId,
  }).from(productos);
  const filas = ids ? (ids.length ? await base.where(inArray(productos.id, ids)) : []) : await base;
  if (!filas.length) return [];
  const etqs = await db.select().from(productoEtiquetas)
    .where(inArray(productoEtiquetas.productoId, filas.map((p) => p.id)));
  const porProd = new Map<number, number[]>();
  for (const e of etqs) porProd.set(e.productoId, [...(porProd.get(e.productoId) ?? []), e.etiquetaId]);
  return filas.map((p) => ({ ...p, etiquetas: porProd.get(p.id) ?? [] }));
}
