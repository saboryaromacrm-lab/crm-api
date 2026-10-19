/**
 * LO DE USO EXCLUSIVO DE COFFIT NO EXISTE PARA SABOR Y AROMA (19/10/2026, pedido del dueño).
 * ============================================================================
 * `productos.solo_cafeteria` (0089) es la mercadería que la Distribuidora compra
 * y guarda solo para mandarle a Coffit. Hasta ahora era «stock normal que no se
 * vende»; desde hoy no aparece en NINGUNA operación de Sabor y Aroma: ni la
 * caja, ni presupuestos, ni el pedido entre sucursales, ni el fraccionamiento,
 * ni la tienda online, ni el catálogo para apps externas.
 *
 * Quedan, por decisión del dueño: la COMPRA (es como entra; la factura ya se la
 * imputa a Coffit), el ENVÍO a Coffit, su control de stock DENTRO de Almacén ›
 * Coffit, y la orden de pedido al proveedor con Bajos en stock (para reponerlo).
 *
 * Las pantallas lo esconden; este candado es el de verdad, para que ningún
 * camino viejo (una pantalla abierta desde antes, un borrador guardado, una
 * llamada directa) lo meta igual.
 */
import { BadRequestException } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { productos } from '../db/schema';

/**
 * Rechaza si alguno de `ids` es de uso exclusivo de Coffit. `para` completa la
 * frase: «no se puede {para}» (p. ej. «vender», «pedir entre sucursales»).
 */
export async function exigirNoExclusivoCoffit(db: any, ids: number[], para: string): Promise<void> {
  const limpios = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!limpios.length) return;
  const [p] = await db.select({ nombre: productos.nombre }).from(productos)
    .where(and(inArray(productos.id, limpios), eq(productos.soloCafeteria, true))).limit(1);
  if (p) {
    throw new BadRequestException(
      `${p.nombre} es de uso exclusivo de Coffit: no se puede ${para}. Lo suyo está en Almacén › Coffit. `
      + 'Si tiene que volver a usarse en Sabor y Aroma, destildá la marca en su ficha (Compras › Productos).',
    );
  }
}
