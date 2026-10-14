/**
 * PROVEEDORES › MONTOS (14/10/2026, pedido del dueño)
 * ============================================================================
 * Cuánta plata en mercadería hay de cada proveedor, con la MISMA valuación que
 * Métricas › Stock (`valorizarStock`: costo de hoy, neto, en estados que siguen
 * siendo mercadería propia). Cada producto cuenta en el proveedor que FIJA SU
 * PRECIO (el formato que manda), igual que en Bajos en stock.
 *
 * Devuelve UNA FILA POR PRODUCTO con stock y los nombres para agruparla: el
 * agrupado y los filtros de tipo, categoría, marca y locales los hace la
 * pantalla al instante, sin volver a pedir. Solo la sucursal y el período de
 * ventas (la rotación) piden de nuevo.
 *
 * Lo de uso exclusivo de Coffit no entra: su costo ya se le cargó a ella.
 */
import { inArray } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { Database } from '../db/drizzle';
import { proveedores } from '../db/schema';
import { valorizarStock } from './stock';

const r4 = (n: number) => Math.round((Number(n) || 0) * 10000) / 10000;

export async function montosPorProveedor(db: Database, pool: Pool, q: { sucursalId: number | null; ventana: number }) {
  const { hoy, ventana, lista, nombreCat, nombreMarca } = await valorizarStock(db, pool, q);
  const propios = lista.filter((x) => !x.deCoffit);
  const ids = [...new Set(propios.map((x) => x.proveedorId).filter((id): id is number => id != null))];
  const provs = ids.length
    ? await db.select({ id: proveedores.id, nombre: proveedores.nombre, esLocal: proveedores.esLocal }).from(proveedores).where(inArray(proveedores.id, ids))
    : [];
  const usados = (campo: 'categoriaId' | 'marcaId', nombres: Map<number, string>) => [...new Set(propios.map((x) => x[campo]).filter((id): id is number => id != null))]
    .map((id) => ({ id, nombre: nombres.get(id) ?? `#${id}` }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  return {
    hoy, ventana, sucursalId: q.sucursalId,
    proveedores: provs,
    categorias: usados('categoriaId', nombreCat),
    marcas: usados('marcaId', nombreMarca),
    productos: propios.map((x) => ({
      id: x.productoId, nombre: x.nombre, proveedorId: x.proveedorId, tipo: x.tipo,
      categoriaId: x.categoriaId, marcaId: x.marcaId, stock: x.stock, valor: x.valor,
      /** Lo que se vende por día, a costo: con esto la pantalla saca los días de stock de cada proveedor. */
      costoDia: r4(x.promedioPorDia * x.costoUnitario),
      parado: x.estado === 'parado',
      sinCosto: !(x.costoUnitario > 0),
    })),
  };
}
