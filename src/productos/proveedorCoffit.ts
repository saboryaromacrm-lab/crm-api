/**
 * LO QUE ELABORA COFFIT QUEDA CON PROVEEDOR «COFFIT» (10/10/2026, pedido del dueño).
 * ============================================================================
 * Para VERLO Y FILTRARLO como de COFFIT (Compras › Productos, listas y reportes
 * por proveedor), con un formato de compra a su nombre. NO para comprarlo: lo
 * que elabora Coffit sigue entrando por los envíos de Coffit y con el costo que
 * ella declara (`formatoDeCosto` lo prefiere al formato), y una factura de compra
 * no lo acepta (`productosComprables` en comprobantes).
 *
 * El proveedor se reconoce por el NOMBRE («COFFIT», sin importar mayúsculas):
 * lo crea el dueño en Proveedores. Si todavía no existe no pasa nada, y el día
 * que se crea se enganchan todos de una vez (ProveedoresService).
 *
 * Una sola regla para las tres puertas: alta del producto, cambio de la marca
 * «lo elabora Coffit» y alta (o cambio de nombre) del proveedor.
 */
import { and, eq, inArray, notExists, sql } from 'drizzle-orm';
import { productoProveedores, productos, proveedores } from '../db/schema';

/** ¿Este nombre es el del proveedor de Coffit? */
export const esNombreCoffit = (nombre: unknown) => String(nombre ?? '').trim().toLowerCase() === 'coffit';

/**
 * Deja el proveedor COFFIT a tono con la marca: lo que la tiene (de `ids`, o
 * TODOS si no se pasan) gana el formato de COFFIT si le falta; lo que dejó de
 * tenerla (solo de `ids`: un cambio explícito) lo pierde. Devuelve cuántos vinculó.
 */
export async function sincronizarProveedorCoffit(db: any, ids?: number[]): Promise<number> {
  if (ids && !ids.length) return 0;
  const [coffit] = await db.select({ id: proveedores.id }).from(proveedores)
    .where(sql`lower(trim(${proveedores.nombre})) = 'coffit'`).limit(1);
  if (!coffit) return 0;
  const deLaLista = ids ? inArray(productos.id, ids) : undefined;

  /* Sin otro formato, el de COFFIT es el que fija el precio (la regla de siempre: el primero
   * manda). Igual no define el costo: el de Coffit declarado gana en `formatoDeCosto`. */
  const nuevos = await db.select({
    id: productos.id,
    solo: sql<boolean>`not exists (select 1 from ${productoProveedores} x where x.producto_id = ${productos.id})`,
  }).from(productos).where(and(
    eq(productos.origenCafeteria, true), deLaLista,
    notExists(db.select({ u: sql`1` }).from(productoProveedores).where(and(
      eq(productoProveedores.productoId, productos.id), eq(productoProveedores.proveedorId, coffit.id),
    ))),
  ));
  if (nuevos.length) {
    await db.insert(productoProveedores).values(nuevos.map((p: any) => ({
      productoId: p.id, proveedorId: coffit.id, cantidad: 1, costo: 0, usarParaPrecio: !!p.solo,
    })));
  }

  if (ids) {
    const yaNo = await db.select({ id: productos.id }).from(productos)
      .where(and(inArray(productos.id, ids), eq(productos.origenCafeteria, false)));
    if (yaNo.length) {
      await db.delete(productoProveedores).where(and(
        eq(productoProveedores.proveedorId, coffit.id), inArray(productoProveedores.productoId, yaNo.map((p: any) => p.id)),
      ));
    }
  }
  return nuevos.length;
}
