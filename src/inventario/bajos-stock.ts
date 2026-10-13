/**
 * ALMACÉN › BAJOS EN STOCK (12/10/2026, pedido del dueño)
 * ============================================================================
 * Solo lectura. El ERP ya tiene en memoria productos, stock y proveedores; lo
 * que le falta para decidir qué está bajo es CUÁNTO SE VENDE. Esto devuelve:
 *
 *   · la venta de los últimos 30 días de cada producto en la sucursal (o en
 *     todas), en la unidad del stock: unidades, o kg en el granel (los
 *     paquetes vendidos se pasan a kg). Las devoluciones (notas de crédito)
 *     restan; las notas de débito no cuentan: no mueven mercadería.
 *   · qué productos ya pasaron por un control o un ajuste en esa sucursal
 *     (`stock_controlado`, 0159), para el filtro «solo controlados».
 *   · la regla: días de venta a cubrir y el % de productos en falta que pone
 *     rojo a un proveedor (Almacén › Configuración).
 *
 * Una consulta agregada por el índice de fecha de ventas: no pesa.
 */
import { sql } from 'drizzle-orm';
import { Database } from '../db/drizzle';

/** La ventana de venta con que se calcula el promedio diario. */
export const DIAS_VENTA = 30;
const entre = (n: unknown, min: number, max: number, def: number) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
};

export async function datosBajosStock(db: Database, cfgVentas: any, sucursalId: number | null) {
  const suc = sucursalId != null ? sql`AND v.sucursal_id = ${sucursalId}` : sql``;
  const desde = new Date(Date.now() - DIAS_VENTA * 86_400_000);
  const [ventas, controlados]: any[] = await Promise.all([
    db.execute(sql`
      SELECT vi.producto_id AS "productoId",
             SUM(CASE WHEN v.tipo::text LIKE 'nota_credito%' THEN -1 ELSE 1 END
                 * vi.cantidad
                 * CASE WHEN p.tipo = 'granel' AND vi.presentacion_id IS NOT NULL THEN COALESCE(pr.tam_kg, 0) ELSE 1 END)::float8 AS cantidad
        FROM venta_items vi
        JOIN ventas v ON v.id = vi.venta_id
        JOIN productos p ON p.id = vi.producto_id
        LEFT JOIN presentaciones pr ON pr.id = vi.presentacion_id
       WHERE v.estado IN ('confirmada', 'pendiente_cae') AND v.fecha >= ${desde}
         AND v.tipo::text NOT LIKE 'nota_debito%' ${suc}
       GROUP BY vi.producto_id`),
    db.execute(sql`
      SELECT DISTINCT producto_id AS "productoId" FROM stock_controlado
       ${sucursalId != null ? sql`WHERE sucursal_id = ${sucursalId}` : sql``}`),
  ]);
  const filas = (r: any) => (r.rows ?? r) as any[];
  return {
    sucursalId,
    diasVenta: DIAS_VENTA,
    diasCobertura: entre(cfgVentas?.bajosDiasCobertura, 1, 90, 7),
    umbralRojo: entre(cfgVentas?.bajosUmbralRojo, 5, 100, 50),
    /** [productoId, cantidad vendida en la ventana] — compacto: pueden ser miles. */
    ventas: filas(ventas).filter((x) => Number(x.cantidad) > 0).map((x) => [x.productoId, Math.round(Number(x.cantidad) * 1000) / 1000]),
    controlados: filas(controlados).map((x) => x.productoId),
  };
}
