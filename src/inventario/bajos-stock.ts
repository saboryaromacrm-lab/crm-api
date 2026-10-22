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
 *   · a qué proveedores YA SE LES PIDIÓ (22/10/2026, pedido del dueño): la
 *     tarjeta de Proveedores › Pedidos en «Pedido», o en «Solicitado» con el
 *     pedido ya mandado. Cuando llega (Recibido), vuelve a contar.
 *
 * Una consulta agregada por el índice de fecha de ventas: no pesa.
 *
 * EL DE COFFIT (22/10/2026, pedido del dueño): lo de uso exclusivo de Coffit
 * no se vende en la caja, se le MANDA. Su «venta» es lo que salió en los
 * envíos a Coffit (sentido salida, no anulados) en la misma ventana, en la
 * misma unidad del stock; y su depósito es el de todas las sucursales.
 */
import { sql } from 'drizzle-orm';
import { Database } from '../db/drizzle';

/** La ventana de venta con que se calcula el promedio diario. */
export const DIAS_VENTA = 30;
const entre = (n: unknown, min: number, max: number, def: number) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
};

export async function datosBajosStock(db: Database, cfgVentas: any, sucursalId: number | null, coffit = false) {
  const suc = sucursalId != null ? sql`AND v.sucursal_id = ${sucursalId}` : sql``;
  const desde = new Date(Date.now() - DIAS_VENTA * 86_400_000);
  const [ventas, controlados, pedidos]: any[] = await Promise.all([
    coffit ? db.execute(sql`
      SELECT i.producto_id AS "productoId",
             SUM(i.cantidad * CASE WHEN p.tipo = 'granel' AND i.modo = 'paquete' THEN i.tam_kg ELSE 1 END)::float8 AS cantidad
        FROM envio_cafeteria_items i
        JOIN envios_cafeteria e ON e.id = i.envio_id
        JOIN productos p ON p.id = i.producto_id
       WHERE e.sentido = 'salida' AND e.estado = 'enviado' AND e.fecha >= ${desde} AND p.solo_cafeteria
       GROUP BY i.producto_id`) : db.execute(sql`
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
    db.execute(sql`
      SELECT proveedor_id AS "proveedorId", MAX(COALESCE(fecha_pedido, fecha_alta)) AS fecha
        FROM pedidos_proveedor
       WHERE estado = 'pedido' OR (estado = 'solicitado' AND pedido_enviado)
       GROUP BY proveedor_id`),
  ]);
  const filas = (r: any) => (r.rows ?? r) as any[];
  return {
    /** De quién es la lista: el ERP filtra los productos con esto (`ALCANCE_BAJOS`). */
    alcance: coffit ? 'coffit' : 'saborYAroma',
    sucursalId,
    diasVenta: DIAS_VENTA,
    diasCobertura: entre(cfgVentas?.bajosDiasCobertura, 1, 90, 7),
    umbralRojo: entre(cfgVentas?.bajosUmbralRojo, 5, 100, 50),
    /** [productoId, cantidad vendida en la ventana] — compacto: pueden ser miles. */
    ventas: filas(ventas).filter((x) => Number(x.cantidad) > 0).map((x) => [x.productoId, Math.round(Number(x.cantidad) * 1000) / 1000]),
    controlados: filas(controlados).map((x) => x.productoId),
    /** [proveedorId, desde cuándo está pedido] de los pedidos en curso. */
    pedidos: filas(pedidos).map((x) => [x.proveedorId, new Date(x.fecha).toISOString()]),
  };
}
