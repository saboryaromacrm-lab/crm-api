/**
 * LOS ECHEQS Y LO QUE CUBREN, una sola vez (0204, 0205). Los usan la cartera,
 * el alta y la anulación de la factura y el puente de pagos: si cada uno
 * escribiera su lista o su cuenta, el día que una se olvide del 'pendiente' el
 * sistema vuelve a contar como hecho un echeq que nadie hizo.
 */
import { BadRequestException } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { proveedorCompromisos, proveedorEcheqs } from '../db/schema';

type EstadoEcheq = 'pendiente' | 'emitido' | 'entregado' | 'cobrado' | 'anulado';

/** Hechos y esperando al banco: lo único que «se va a debitar». */
export const ECHEQ_EN_CARTERA: EstadoEcheq[] = ['emitido', 'entregado'];
/** Todavía vivos: los de la cartera más el pendiente de confirmar. */
export const ECHEQ_VIVOS: EstadoEcheq[] = ['pendiente', ...ECHEQ_EN_CARTERA];

const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const EPS = 0.009;

/**
 * LO QUE DE VERDAD FALTA DE UN COMPROMISO (27/10/2026, pedido del dueño). El
 * compromiso guarda la promesa («$4.380.000 el 13/10»), pero si la factura ya
 * se pagó en parte —cuenta libre, una NC— no puede pedir más de lo que la
 * factura todavía debe (total + ND − NC − pagado, la cuenta de
 * `documentosPendientes`). Lo pagado cubre primero las cuotas que vencen antes,
 * así que lo que falta es de las últimas: cada cuota pendiente debe lo que la
 * factura debe menos lo que suman las que vencen después de ella. El manual, sin
 * factura, es su importe. De acá salen «Comprometido», el proyectado, lo que
 * paga «Pagar» y lo que cubre un echeq; una cuota que quedó en cero está
 * cubierta y no se cobra.
 *
 * Las columnas van escritas con su tabla y no como `${columna}`: en el SELECT
 * de una consulta sin join Drizzle las escribe sin tabla, y dentro de la
 * subconsulta de las cuotas se leían las de ADENTRO (las posteriores no restaban).
 */
export const faltaCompromiso = sql<number>`case when proveedor_compromisos.comprobante_id is null then proveedor_compromisos.importe
  else greatest(0, least(proveedor_compromisos.importe,
    (select c.total - c.pagado + coalesce((select sum(case when n.tipo = 'nota_debito' then n.total else -n.total end)
        from comprobantes n where n.ref_comprobante_id = c.id and n.estado = 'confirmado'
        and n.tipo in ('nota_credito', 'nota_debito')), 0)
      from comprobantes c where c.id = proveedor_compromisos.comprobante_id)
    - coalesce((select sum(k2.importe) from proveedor_compromisos k2
        where k2.comprobante_id = proveedor_compromisos.comprobante_id and not k2.pagado
        and (k2.fecha_venc, k2.id) > (proveedor_compromisos.fecha_venc, proveedor_compromisos.id)), 0)))
  end`;

/**
 * Lo que el echeq todavía no cubre de ninguna factura (0205): al cobrarse va a
 * cuenta del proveedor. Sumado a lo que falta de sus compromisos da su importe.
 */
export const sinFacturaEcheq = sql<number>`greatest(0, proveedor_echeqs.importe - coalesce((select sum(${faltaCompromiso})
  from proveedor_compromisos where proveedor_compromisos.echeq_id = proveedor_echeqs.id and not proveedor_compromisos.pagado), 0))`;

/**
 * EL ECHEQ SE CAE, LA DEUDA NO. Cuando un echeq no se hizo, se anula o se
 * borra, lo que cubría de sus facturas vuelve a Cuentas corrientes como deuda
 * común. Sin esto quedaba en el limbo: fuera de Cuentas corrientes (que no
 * lista echeqs) y sin echeq en la cartera.
 */
export async function deudaACuentaCorriente(tx: any, echeqId: number) {
  await tx.update(proveedorCompromisos).set({ echeqId: null })
    .where(and(eq(proveedorCompromisos.echeqId, echeqId), eq(proveedorCompromisos.pagado, false)));
}

/**
 * IMPUTAR UN ECHEQ A UNA FACTURA (0205): su compromiso con esa factura, por
 * `importe` y con la fecha de cobro del echeq. El echeq tiene que estar hecho
 * (en cartera), ser del proveedor y alcanzarle: lo que ya cubre de las OTRAS
 * facturas más esto no pasa de su importe. La fila del echeq se bloquea: dos
 * imputaciones a la vez no se reparten la misma plata.
 */
export async function imputarEcheqTx(
  tx: any, x: { echeqId: number; proveedorId: number; comprobanteId: number; importe: number },
) {
  const [e] = await tx.select().from(proveedorEcheqs)
    .where(eq(proveedorEcheqs.id, x.echeqId)).limit(1).for('update');
  if (!e || e.proveedorId !== x.proveedorId) throw new BadRequestException('Ese echeq no es de este proveedor.');
  if (!ECHEQ_EN_CARTERA.includes(e.estado)) {
    throw new BadRequestException(`El echeq N° ${e.numero} ya no está en la cartera: no se le imputan facturas.`);
  }
  const [r] = await tx.select({ t: sql<number>`coalesce(sum(${faltaCompromiso}), 0)` }).from(proveedorCompromisos).where(and(
    eq(proveedorCompromisos.echeqId, e.id),
    eq(proveedorCompromisos.pagado, false),
    ne(proveedorCompromisos.comprobanteId, x.comprobanteId),
  ));
  const libre = money(e.importe - (Number(r?.t) || 0));
  if (x.importe - libre > EPS) {
    throw new BadRequestException(
      `El echeq N° ${e.numero} es de $ ${money(e.importe).toFixed(2)} y ya cubre otras facturas: le quedan $ ${Math.max(0, libre).toFixed(2)}.`,
    );
  }
  const [ya] = await tx.select({ id: proveedorCompromisos.id }).from(proveedorCompromisos).where(and(
    eq(proveedorCompromisos.echeqId, e.id),
    eq(proveedorCompromisos.comprobanteId, x.comprobanteId),
    eq(proveedorCompromisos.pagado, false),
  )).limit(1);
  if (ya) {
    await tx.update(proveedorCompromisos).set({ importe: money(x.importe), fechaVenc: e.fechaVenc })
      .where(eq(proveedorCompromisos.id, ya.id));
    return;
  }
  await tx.insert(proveedorCompromisos).values({
    proveedorId: e.proveedorId,
    comprobanteId: x.comprobanteId,
    importe: money(x.importe),
    fechaEmision: e.fechaEmision,
    fechaVenc: e.fechaVenc,
    origen: 'factura',
    echeqId: e.id,
  });
}

/**
 * EL PENDIENTE DICE LO QUE FALTA (7/11/2026, pedido del dueño: «hay proveedor
 * que le pago por echeq a dos días, no llego a generarlo y le transfiero»). El
 * echeq automático sin hacer es la promesa de pagar lo que su factura todavía
 * debe: si se pagó en parte por otro medio, baja a lo que falta; si ya no falta
 * nada, se da de baja y su parte queda como deuda común (si ese pago se anula,
 * vuelve a Cuentas corrientes, no a un echeq que nadie hizo). Si se anula el
 * pago parcial, vuelve a subir hasta lo que la factura debe de nuevo. Lo corre
 * el puente de pagos con la factura todavía con saldo; saldada, el puente ya lo
 * da de baja.
 */
export async function ajustarPendientesTx(tx: any, comprobanteId: number) {
  const ks = await tx.select({
    id: proveedorCompromisos.id,
    echeqId: proveedorCompromisos.echeqId,
    importe: proveedorEcheqs.importe,
    falta: faltaCompromiso,
  }).from(proveedorCompromisos)
    .innerJoin(proveedorEcheqs, eq(proveedorEcheqs.id, proveedorCompromisos.echeqId))
    .where(and(
      eq(proveedorCompromisos.comprobanteId, comprobanteId),
      eq(proveedorCompromisos.pagado, false),
      eq(proveedorEcheqs.estado, 'pendiente'),
    ));
  const porEcheq = new Map<number, { importe: number; falta: number; ks: number[] }>();
  for (const k of ks) {
    const e = porEcheq.get(k.echeqId) ?? { importe: Number(k.importe), falta: 0, ks: [] };
    e.falta = money(e.falta + Number(k.falta));
    e.ks.push(k.id);
    porEcheq.set(k.echeqId, e);
  }
  for (const [echeqId, e] of porEcheq) {
    if (e.falta <= EPS) {
      await tx.update(proveedorEcheqs).set({ estado: 'anulado', obs: 'No se hizo: la factura se pagó por otro medio.' })
        .where(and(eq(proveedorEcheqs.id, echeqId), eq(proveedorEcheqs.estado, 'pendiente')));
      await deudaACuentaCorriente(tx, echeqId);
    } else if (Math.abs(e.falta - e.importe) > EPS) {
      await tx.update(proveedorEcheqs).set({ importe: e.falta })
        .where(and(eq(proveedorEcheqs.id, echeqId), eq(proveedorEcheqs.estado, 'pendiente')));
    }
  }
}
