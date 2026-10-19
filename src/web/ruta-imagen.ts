/**
 * LAS IMÁGENES SUBIDAS (tabla `web_imagenes`): su dirección y la foto de cada
 * producto. Una sola regla para la tienda, el ERP (Compras › Productos) y la
 * respuesta de la subida.
 */
import { and, eq } from 'drizzle-orm';
import { webImagenes } from '../db/schema';

/** Relativa a la API: la sirve `GET /tienda/imagenes/:tipo/:refId`; `?v=` (la última subida) rompe el caché al reemplazarla. */
export const rutaImagen = (tipo: string, refId: number, actualizadoEn: Date | string | number) =>
  `tienda/imagenes/${tipo}/${refId}?v=${new Date(actualizadoEn).getTime()}`;

/** Las fotos subidas de los productos (o de uno): id → dirección. Solo el id y la fecha, nunca la foto en sí (base64, pesa). */
export async function fotosDeProductos(db: any, id?: number): Promise<Map<number, string>> {
  const deProducto = eq(webImagenes.tipo, 'producto');
  const filas = await db.select({ refId: webImagenes.refId, actualizadoEn: webImagenes.actualizadoEn }).from(webImagenes)
    .where(id == null ? deProducto : and(deProducto, eq(webImagenes.refId, id)));
  return new Map(filas.map((f: any) => [f.refId, rutaImagen('producto', f.refId, f.actualizadoEn)]));
}

/** La foto que ve el cliente: la subida manda y la URL externa (la importación vieja) es el plan B. '' = sin foto. */
export const fotoDeProducto = (p: { id: number; imagenUrl?: string | null }, fotos: Map<number, string>) =>
  fotos.get(p.id) || p.imagenUrl || '';
