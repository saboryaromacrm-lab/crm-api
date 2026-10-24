/**
 * EXPORTAR PRODUCTOS PARA OTRO ERP (24/10/2026, pedido del dueño: «exportar
 * con los filtros activos, para importarlo en el ERP Maxi»).
 * ============================================================================
 * Un solo archivo JSON con los productos elegidos COMPLETOS, listos para dar
 * de alta en otra instalación del sistema:
 *
 *   · la ficha (códigos, clasificación, tipo, IVA, cartel de góndola…) con sus
 *     etiquetas y sus paquetes fraccionados;
 *   · los formatos de compra (proveedor, bulto, costo, descuentos, flete,
 *     comisión) y los proveedores que nombran;
 *   · las filas de las listas de precios (del producto y de cada paquete) y las
 *     listas y modalidades que usan;
 *   · la foto, si se pide (es lo que más pesa).
 *
 * Las referencias van por el id de ESTA base (`marcaId`, `proveedorId`,
 * `listaId`, `presentacionId`…) y cada catálogo viaja con su nombre: quien
 * importa resuelve por nombre y no depende de que los ids coincidan. Viajan
 * solo los catálogos que los productos usan. El stock no viaja: es de este
 * negocio, no del producto.
 */
import { BadRequestException } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/drizzle';
import {
  categorias, etiquetas, listasVenta, marcas, modalidadesVenta, presentaciones, productoEtiquetas, productoListas,
  productoProveedores, productos, proveedores, subcategorias, webImagenes,
} from '../db/schema';

/** Lo que identifica al archivo: quien importa lo mira antes de leer nada. */
export const FORMATO_EXPORTACION = 'saboryaroma.productos';
export const VERSION_EXPORTACION = 1;
/** El catálogo entero entra holgado; más es un pedido mal armado. */
const MAX_PRODUCTOS = 5000;

/** Los ids pedidos, sin repetir y solo enteros positivos. */
const idsDe = (crudos: unknown) => [...new Set((Array.isArray(crudos) ? crudos : [])
  .map(Number).filter((n) => Number.isInteger(n) && n > 0))];
const unicos = (xs: Array<number | null>) => [...new Set(xs.filter((x): x is number => x != null))];
/** Las filas de una tabla hija, agrupadas por producto. */
function porProducto<T extends { productoId: number }>(filas: T[]) {
  const m = new Map<number, Array<Omit<T, 'productoId'>>>();
  for (const { productoId, ...resto } of filas) {
    const arr = m.get(productoId);
    if (arr) arr.push(resto); else m.set(productoId, [resto]);
  }
  return m;
}

export async function exportarProductos(db: Database, idsPedidos: unknown, conFotos: boolean) {
  const ids = idsDe(idsPedidos);
  if (!ids.length) throw new BadRequestException('Elegí al menos un producto para exportar.');
  if (ids.length > MAX_PRODUCTOS) throw new BadRequestException(`Se exportan hasta ${MAX_PRODUCTOS} productos por archivo.`);

  const [prods, press, formatos, filasListas, etiq, fotos] = await Promise.all([
    db.select().from(productos).where(inArray(productos.id, ids)).orderBy(productos.nombre),
    db.select().from(presentaciones).where(inArray(presentaciones.productoId, ids)).orderBy(presentaciones.tamKg),
    db.select().from(productoProveedores).where(inArray(productoProveedores.productoId, ids)),
    db.select().from(productoListas).where(inArray(productoListas.productoId, ids)),
    db.select().from(productoEtiquetas).where(inArray(productoEtiquetas.productoId, ids)),
    conFotos
      ? db.select({ refId: webImagenes.refId, mime: webImagenes.mime, data: webImagenes.data }).from(webImagenes)
        .where(and(eq(webImagenes.tipo, 'producto'), inArray(webImagenes.refId, ids)))
      : Promise.resolve([] as Array<{ refId: number; mime: string; data: string }>),
  ]);
  if (!prods.length) throw new BadRequestException('Ninguno de los productos elegidos existe.');

  const provIds = unicos(formatos.map((f) => f.proveedorId));
  const listaIds = unicos(filasListas.map((f) => f.listaId));
  const marcaIds = unicos(prods.map((p) => p.marcaId));
  const categoriaIds = unicos(prods.map((p) => p.categoriaId));
  const subcategoriaIds = unicos(prods.map((p) => p.subcategoriaId));
  const etiquetaIds = unicos(etiq.map((e) => e.etiquetaId));
  const [provs, listas, ms, cs, ss, es] = await Promise.all([
    provIds.length ? db.select().from(proveedores).where(inArray(proveedores.id, provIds)).orderBy(proveedores.nombre) : [],
    listaIds.length ? db.select().from(listasVenta).where(inArray(listasVenta.id, listaIds)) : [],
    marcaIds.length ? db.select({ id: marcas.id, nombre: marcas.nombre }).from(marcas).where(inArray(marcas.id, marcaIds)) : [],
    categoriaIds.length ? db.select({ id: categorias.id, nombre: categorias.nombre }).from(categorias).where(inArray(categorias.id, categoriaIds)) : [],
    subcategoriaIds.length
      ? db.select({ id: subcategorias.id, nombre: subcategorias.nombre, categoriaId: subcategorias.categoriaId }).from(subcategorias)
        .where(inArray(subcategorias.id, subcategoriaIds))
      : [],
    etiquetaIds.length ? db.select({ id: etiquetas.id, nombre: etiquetas.nombre }).from(etiquetas).where(inArray(etiquetas.id, etiquetaIds)) : [],
  ]);
  const modalidadIds = unicos(listas.map((l) => l.modalidadId));
  const modalidades = modalidadIds.length
    ? await db.select().from(modalidadesVenta).where(inArray(modalidadesVenta.id, modalidadIds))
    : [];

  const pressDe = porProducto(press);
  const formatosDe = porProducto(formatos);
  const listasDe = porProducto(filasListas);
  const etiquetasDe = porProducto(etiq);
  const fotoDe = new Map(fotos.map((f) => [f.refId, { mime: f.mime, data: f.data }]));

  return {
    formato: FORMATO_EXPORTACION,
    version: VERSION_EXPORTACION,
    exportadoEn: new Date().toISOString(),
    conFotos,
    marcas: ms,
    categorias: cs,
    subcategorias: ss,
    etiquetas: es,
    /* La conciliación es la historia de la cuenta con ESTE negocio: no viaja. */
    proveedores: provs.map(({ conciliadoHasta, conciliadoPor, conciliadoAt, ...p }) => p),
    modalidades,
    listas,
    productos: prods.map((p) => ({
      ...p,
      etiquetaIds: (etiquetasDe.get(p.id) ?? []).map((e) => e.etiquetaId),
      presentaciones: pressDe.get(p.id) ?? [],
      formatosCompra: formatosDe.get(p.id) ?? [],
      listas: listasDe.get(p.id) ?? [],
      foto: fotoDe.get(p.id) ?? null,
    })),
  };
}
