/**
 * LO QUE NACIÓ EN EL CASH FLOW SE DESHACE DESDE EL CASH FLOW (5/10/2026, auditoría).
 *
 * Un pago a proveedor o un gasto cargado desde Gerencia › Cash Flow tiene un
 * EGRESO en el libro de la caja del dueño. Si alguien lo anulaba desde Gastos o
 * desde Proveedores, el egreso seguía vivo: la caja decía que la plata salió y
 * el proveedor que no se le pagó (y el egreso quedaba trabado para siempre).
 * Este chequeo vive aparte para que pagos y gastos lo usen sin importar el
 * módulo del Cash Flow (que ya los importa a ellos).
 */
import { BadRequestException } from '@nestjs/common';
import { sql } from 'drizzle-orm';

/** Opción de los servicios de pagos y gastos: el Cash Flow pasa `true` cuando deshace lo suyo. */
export type OpcionesCashflow = { desdeCashflow?: boolean };

export async function exigirFueraDeCashflow(
  db: any, ref: { pagoId?: number | null; gastoId?: number | null }, que: string, opts?: OpcionesCashflow,
) {
  if (opts?.desdeCashflow || (!ref.pagoId && !ref.gastoId)) return;
  const r = await db.execute(sql`select 1 from cashflow_movimientos
    where anulado_en is null and (pago_id = ${ref.pagoId ?? -1} or gasto_id = ${ref.gastoId ?? -1}) limit 1`);
  if (r.rows.length) {
    throw new BadRequestException(
      `${que} se registró desde Gerencia › Cash Flow: anulalo desde ahí (Movimientos › Anular), así el efectivo de la caja se recalcula junto.`,
    );
  }
}
