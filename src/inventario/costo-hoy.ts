import { BadRequestException } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { presentaciones, productoProveedores, productos } from '../db/schema';
import { costosFormato, escalaPaquete, formatoDeCosto } from './pricing';

/**
 * EL COSTO NETO DE HOY de cada renglón, el mismo que se congela en una venta
 * (formato de costo del proveedor que fija el precio): el paquete hereda el
 * del kilo por su tamaño y su merma. Lo usan los cambios de mercadería (0202)
 * y lo que llega de más sin estar en el papel (0248).
 */
export async function costosDeHoy(tx: any, items: { productoId: number; presentacionId?: number | null }[]) {
  const ids = [...new Set(items.map((it) => it.productoId))];
  const presIds = [...new Set(items.map((it) => it.presentacionId).filter((x): x is number => !!x))];
  const [prods, provs, pres] = await Promise.all([
    tx.select().from(productos).where(inArray(productos.id, ids)),
    tx.select().from(productoProveedores).where(inArray(productoProveedores.productoId, ids)),
    presIds.length ? tx.select().from(presentaciones).where(inArray(presentaciones.id, presIds)) : Promise.resolve([]),
  ]);
  return items.map((it) => {
    const prod = prods.find((p: any) => p.id === it.productoId);
    if (!prod) throw new BadRequestException('Uno de los productos ya no existe.');
    const p = it.presentacionId ? pres.find((x: any) => x.id === it.presentacionId && x.productoId === prod.id) : null;
    if (it.presentacionId && !p) throw new BadRequestException(`El envasado elegido no es de ${prod.nombre}.`);
    const cf = costosFormato(formatoDeCosto(prod, provs.filter((x: any) => x.productoId === prod.id)) as any, prod.iva);
    const costoUnitario = Math.round(cf.costoNetoUnitario * (p ? escalaPaquete(p.tamKg, prod.merma) : 1) * 1e4) / 1e4;
    return { prod, presentacionId: (p?.id as number | undefined) ?? null, costoUnitario };
  });
}
