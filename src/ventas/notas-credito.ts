/**
 * VENTAS › NOTAS DE CRÉDITO (19/11/2026, pedido del dueño: «todas las NC
 * creadas, bien detalladas»). Las notas de crédito fiscales (A, B, C) y las
 * devoluciones de ticket, cada una con lo que hizo:
 *
 *   · a qué venta ajusta (comprobante, fecha y total de la original);
 *   · por qué (el motivo es obligatorio al emitirla: primera línea de las
 *     observaciones; la segunda es la marca «[Nota de crédito de …]»);
 *   · qué pasó con la PLATA: se devolvió efectivo del cajón (la nota quedó
 *     atada a un turno y salió el egreso), se descontó de la cuenta corriente
 *     del cliente, o se devuelve por el mismo medio con que se cobró;
 *   · si VOLVIÓ LA MERCADERÍA: la nota con devolución reingresa el stock con
 *     un movimiento «devolución» que lleva su número en la descripción (ver
 *     `notaCredito` en ventas.module.ts); una nota por un error de precio no;
 *   · ante ARCA: con CAE, pendiente (ARCA caído) o interna (devolución de un
 *     ticket, o factura interna sin CAE).
 */
import { sql } from 'drizzle-orm';

export type FiltroNotas = {
  desde?: string; hasta?: string; sucursalId?: number;
  clase?: 'fiscal' | 'devolucion'; arca?: 'cae' | 'pendiente' | 'interna';
  plata?: 'efectivo' | 'ctacte' | 'medio'; q?: string; offset?: number; limit?: number;
};

/** Qué pasó con la plata de una nota. */
export function plataDeLaNota(n: { cajaSesionId: number | null; condicionPago: string }): 'efectivo' | 'ctacte' | 'medio' {
  if (n.cajaSesionId) return 'efectivo';
  if (n.condicionPago === 'cuenta_corriente') return 'ctacte';
  return 'medio';
}

/** La nota ante ARCA. */
export function arcaDeLaNota(n: { tipo: string; cae: string; facturarPendiente: boolean }): 'cae' | 'pendiente' | 'interna' {
  if (n.cae) return 'cae';
  if (n.facturarPendiente) return 'pendiente';
  return 'interna';
}

/** El motivo que se escribió al emitirla, sin la marca de la venta original. */
export const motivoDeLaNota = (obs: string) => String(obs ?? '').split('\n').filter((l) => !/^\[(Nota de crédito|Devolución) de /.test(l)).join(' ').trim();

const desdeDia = (s?: string) => (s ? new Date(`${s}T00:00:00`) : null);
const hastaDia = (s?: string) => (s ? new Date(`${s}T23:59:59.999`) : null);

export async function listarNotasCredito(db: any, f: FiltroNotas) {
  const conds: any[] = [sql`v.tipo::text like 'nota_credito%'`, sql`v.estado <> 'borrador'`];
  const d = desdeDia(f.desde); if (d) conds.push(sql`v.fecha >= ${d}`);
  const h = hastaDia(f.hasta); if (h) conds.push(sql`v.fecha <= ${h}`);
  if (f.sucursalId) conds.push(sql`v.sucursal_id = ${f.sucursalId}`);
  if (f.clase === 'fiscal') conds.push(sql`v.tipo <> 'nota_credito_ticket'`);
  if (f.clase === 'devolucion') conds.push(sql`v.tipo = 'nota_credito_ticket'`);
  if (f.arca === 'cae') conds.push(sql`v.cae <> ''`);
  if (f.arca === 'pendiente') conds.push(sql`v.cae = '' and v.facturar_pendiente`);
  if (f.arca === 'interna') conds.push(sql`v.cae = '' and not v.facturar_pendiente`);
  if (f.plata === 'efectivo') conds.push(sql`v.caja_sesion_id is not null`);
  if (f.plata === 'ctacte') conds.push(sql`v.caja_sesion_id is null and v.condicion_pago = 'cuenta_corriente'`);
  if (f.plata === 'medio') conds.push(sql`v.caja_sesion_id is null and v.condicion_pago <> 'cuenta_corriente'`);
  const t = (f.q ?? '').trim();
  if (t) {
    /* Cliente, motivo, o el número de la nota o de la venta original. */
    const digitos = t.replace(/\D/g, '');
    conds.push(sql`(c.nombre ilike ${`%${t}%`} or v.observaciones ilike ${`%${t}%`}
      ${digitos ? sql`or v.numero = ${Number(digitos)} or o.numero = ${Number(digitos)}` : sql``})`);
  }
  const donde = sql.join(conds, sql` and `);
  const desdeFrom = sql`from ventas v
      left join ventas o on o.id = v.ref_venta_id
      left join clientes c on c.id = v.cliente_id`;
  const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 200);
  const offset = Math.max(Number(f.offset) || 0, 0);

  const [filas, tot]: any[] = await Promise.all([
    db.execute(sql`
      select v.id, v.tipo::text as tipo, v.punto_venta as "puntoVenta", v.numero, v.fecha, v.estado::text as estado,
        v.condicion_pago::text as "condicionPago", v.caja_sesion_id as "cajaSesionId",
        v.subtotal_neto as neto, v.iva_total as iva, v.total, v.cae, v.facturar_pendiente as "facturarPendiente",
        v.facturar_motivo as "facturarMotivo", v.observaciones,
        c.nombre as cliente, s.nombre as sucursal, u.nombre as usuario,
        o.id as "origId", o.tipo::text as "origTipo", o.punto_venta as "origPuntoVenta", o.numero as "origNumero",
        o.fecha as "origFecha", o.total as "origTotal",
        (select string_agg(distinct vp.medio::text, ',') from venta_pagos vp where vp.venta_id = o.id) as "origMedios",
        (select count(*)::int from venta_items i where i.venta_id = v.id) as renglones,
        (select string_agg(coalesce(p.nombre, '#' || i.producto_id) || ' × ' || trim(to_char(i.cantidad, 'FM999999990.###')), ' · ' order by i.id)
           from (select * from venta_items i2 where i2.venta_id = v.id order by i2.id limit 6) i
           left join productos p on p.id = i.producto_id) as articulos,
        exists (
          select 1 from movimientos mv
          where mv.tipo = 'devolucion' and mv.sucursal_id = v.sucursal_id
            and mv.fecha between v.fecha - interval '1 minute' and v.fecha + interval '10 minutes'
            and mv.descripcion like (case when v.tipo = 'nota_credito_ticket' then 'Devolución ' else 'NC ' end)
              || v.punto_venta || '-' || lpad(v.numero::text, 8, '0') || ' de %'
        ) as "volvioMercaderia"
      ${desdeFrom}
        left join sucursales s on s.id = v.sucursal_id
        left join usuarios u on u.id = v.usuario_id
      where ${donde}
      order by v.fecha desc, v.id desc
      limit ${limit} offset ${offset}`),
    db.execute(sql`
      select count(*)::int as cantidad,
        coalesce(sum(v.total) filter (where v.estado <> 'anulada'), 0)::float8 as total,
        coalesce(sum(v.total) filter (where v.estado <> 'anulada' and v.caja_sesion_id is not null), 0)::float8 as efectivo,
        coalesce(sum(v.total) filter (where v.estado <> 'anulada' and v.caja_sesion_id is null and v.condicion_pago = 'cuenta_corriente'), 0)::float8 as ctacte,
        coalesce(sum(v.total) filter (where v.estado <> 'anulada' and v.caja_sesion_id is null and v.condicion_pago <> 'cuenta_corriente'), 0)::float8 as medio,
        count(*) filter (where v.cae = '' and v.facturar_pendiente and v.estado <> 'anulada')::int as pendientes,
        count(*) filter (where v.tipo = 'nota_credito_ticket')::int as devoluciones
      ${desdeFrom}
      where ${donde}`),
  ]);
  const r2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
  return {
    filas: (filas.rows as any[]).map((x) => ({
      id: x.id, tipo: x.tipo, puntoVenta: x.puntoVenta, numero: x.numero, fecha: x.fecha, estado: x.estado,
      cliente: x.cliente ?? '', sucursal: x.sucursal ?? '', usuario: x.usuario ?? '',
      neto: r2(x.neto), iva: r2(x.iva), total: r2(x.total),
      motivo: motivoDeLaNota(x.observaciones),
      plata: plataDeLaNota(x), arca: arcaDeLaNota(x), cae: x.cae, facturarMotivo: x.facturarMotivo ?? '',
      volvioMercaderia: !!x.volvioMercaderia,
      renglones: Number(x.renglones) || 0, articulos: x.articulos ?? '',
      original: x.origId ? {
        id: x.origId, tipo: x.origTipo, puntoVenta: x.origPuntoVenta, numero: x.origNumero, fecha: x.origFecha, total: r2(x.origTotal),
        medios: x.origMedios ? String(x.origMedios).split(',') : [],
      } : null,
    })),
    totales: (() => {
      const y = (tot.rows as any[])[0] ?? {};
      return {
        cantidad: Number(y.cantidad) || 0, total: r2(y.total), efectivo: r2(y.efectivo), ctacte: r2(y.ctacte), medio: r2(y.medio),
        pendientes: Number(y.pendientes) || 0, devoluciones: Number(y.devoluciones) || 0,
      };
    })(),
    offset, limit,
  };
}
