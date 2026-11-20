/**
 * EL CAMBIO: DEVUELVE Y SE LLEVA OTRA COSA (0236, 19/11/2026).
 *
 * Pedido del dueño con un caso real de Express 3: el cliente devolvió un
 * aceite ($18.480) y se llevó otras cosas ($18.765). No había cómo decirlo:
 * la nota figuraba «devuelta por el mismo medio» (nadie devolvió nada) y la
 * venta nueva, cobrada con un QR de $18.480 que nunca entró a Mercado Pago.
 * La conciliación y la caja del día quedaban descuadradas.
 *
 * Ahora, al emitir la nota de una venta al contado, se elige cómo se devuelve:
 *   · `efectivo`: egreso del turno (con el tope de siempre: del cajón sale lo
 *     que entró en efectivo);
 *   · `medio`: por el mismo medio con que se cobró (devolución en la app de
 *     Mercado Pago, anulación en el posnet…), fuera de la caja: queda anotado;
 *   · `cambio`: la nota queda como crédito PARA ESE MOMENTO Y ESE LOCAL. La
 *     venta que se arma la usa como medio de pago `nota_credito`, y si se
 *     lleva menos, el sobrante se devuelve en el acto (efectivo o mismo medio).
 *     Un cambio sin resolver no deja cerrar la caja del local.
 *
 * Lo que le queda a un cambio NO se guarda: se suma (total − lo usado por
 * ventas vivas − lo devuelto). Si la venta del cambio se anula, la nota vuelve
 * a tener saldo sola y hay que resolverla de nuevo.
 */
import { BadRequestException } from '@nestjs/common';
import { sql } from 'drizzle-orm';

/** Cómo se le devuelve la plata al cliente en una nota de crédito al contado. */
export const DEVOLUCIONES = ['efectivo', 'medio', 'cambio'] as const;
export type Devolucion = (typeof DEVOLUCIONES)[number];

/** Cómo se devuelve lo que sobra de un cambio (o todo, si al final no se llevó nada). */
export const COMO_DEVOLVER = ['efectivo', 'medio'] as const;
export type ComoDevolver = (typeof COMO_DEVOLVER)[number];

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * ¿La venta se cobró TODA en efectivo? Entonces no hay «otro medio» por donde
 * devolver: dar billetes anotándolo «por el mismo medio» los sacaría del cajón
 * sin egreso y la caja no cerraría. Se devuelve en efectivo (o es un cambio).
 */
export const soloEfectivo = (medios: readonly string[]) => medios.length > 0 && medios.every((m) => m === 'efectivo');

/** Lo que le queda a un cambio: el total, menos lo que usaron las ventas vivas, menos lo ya devuelto. */
export const saldoDelCambio = (c: { total: number; usado: number; cambioEfectivo: number; cambioMedio: number }) =>
  Math.max(0, r2(c.total - c.usado - c.cambioEfectivo - c.cambioMedio));

export type CambioConSaldo = {
  id: number; tipo: string; puntoVenta: string; numero: number; fecha: string; sucursalId: number;
  refVentaId: number; total: number; usado: number; cambioEfectivo: number; cambioMedio: number; saldo: number;
  /** La venta original se cobró (en parte) con algo que no es efectivo: se puede devolver «por el mismo medio». */
  otroMedio: boolean;
};

/**
 * Los cambios que todavía tienen saldo: los de una sucursal, o uno solo.
 * `db` puede ser la transacción que ya tomó la nota con candado.
 */
export async function cambiosConSaldo(db: any, f: { sucursalId?: number; ncId?: number }): Promise<CambioConSaldo[]> {
  const conds = [sql`v.cambio`, sql`v.estado = 'confirmada'`];
  if (f.sucursalId) conds.push(sql`v.sucursal_id = ${f.sucursalId}`);
  if (f.ncId) conds.push(sql`v.id = ${f.ncId}`);
  const r = await db.execute(sql`
    select v.id, v.tipo::text as tipo, v.punto_venta as "puntoVenta", v.numero, v.fecha, v.sucursal_id as "sucursalId",
      v.ref_venta_id as "refVentaId", v.total, v.cambio_efectivo as "cambioEfectivo", v.cambio_medio as "cambioMedio",
      coalesce((select sum(vp.importe) from venta_pagos vp join ventas u on u.id = vp.venta_id
        where vp.nc_venta_id = v.id and u.estado <> 'anulada'), 0)::float8 as usado,
      exists (select 1 from venta_pagos o where o.venta_id = v.ref_venta_id and o.medio <> 'efectivo') as "otroMedio"
    from ventas v
    where ${sql.join(conds, sql` and `)}
    order by v.id`);
  return (r.rows as any[])
    .map((x) => {
      const c = {
        ...x, total: Number(x.total) || 0, usado: Number(x.usado) || 0,
        cambioEfectivo: Number(x.cambioEfectivo) || 0, cambioMedio: Number(x.cambioMedio) || 0,
      };
      return { ...c, saldo: saldoDelCambio(c) };
    })
    .filter((c) => c.saldo > 0.009);
}

/**
 * NO SE CIERRA UN TURNO CON UN CAMBIO A MEDIAS: el crédito es para ese momento,
 * y si quedara abierto nadie sabría al otro día si el cliente se llevó algo o
 * se fue con la plata. Se resuelve desde el punto de venta (usarlo en el ticket
 * o devolverlo).
 */
export async function sinCambiosPendientes(tx: any, sucursalId: number) {
  const pendientes = await cambiosConSaldo(tx, { sucursalId });
  if (pendientes.length) {
    const uno = pendientes.length === 1;
    throw new BadRequestException(uno
      ? 'Hay un cambio sin terminar en este local (una nota de crédito marcada «se lleva otra mercadería» que no se usó en ninguna venta). '
        + 'Resolvelo desde el punto de venta: usala en el ticket o devolvé la plata. Después cerrá la caja.'
      : `Hay ${pendientes.length} cambios sin terminar en este local (notas de crédito marcadas «se lleva otra mercadería» que no se usaron en ninguna venta). `
        + 'Resolvelos desde el punto de venta: usalas en un ticket o devolvé la plata. Después cerrá la caja.');
  }
}
