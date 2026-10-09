/**
 * LOS HECHOS DEL ESTADO DE RESULTADOS (0152) — lo que se lee de la base.
 * ============================================================================
 * Corre por el pool propio de Métricas (solo lectura, con tope de tiempo):
 * la caja nunca espera a un reporte. Todo agrupado por MES argentino y por
 * local; la cuenta la hacen `reglas.ts` y el servicio.
 *
 * DE DÓNDE SALE CADA NÚMERO (todo NETO, sin IVA):
 *   ventas     renglones de ventas confirmadas (y pendientes de CAE): precio de
 *              lista, neto cobrado y costo congelado; las NC restan aparte.
 *              Cargos extra: envíos y otros (venta) y el recargo por cuotas
 *              (resultado financiero).
 *   facturado  el neto de lo facturado (y lo pendiente de CAE): la base de
 *              Ingresos Brutos y de la tasa municipal.
 *   tarjetas   lo cobrado con débito y crédito (ventas y recibos): la base de
 *              la comisión del posnet. Mercado Pago, su comisión REAL.
 *   stock      mermas, vencidos y defectuosos (pérdida) y ajustes/controles (±),
 *              al costo congelado en cada movimiento.
 *   gastos     por el mes al que corresponden (`periodo`, o el de la fecha),
 *              netos: sin el IVA de la factura A ni las percepciones (son pago
 *              a cuenta). Sin anulados y sin los de Coffit (va aparte).
 */
import type { PoolClient } from 'pg';
import { CLASE_VENTA, TIPO_PERCEPCION_SQL } from '../metricas/iva';

const ZONA = 'America/Argentina/Buenos_Aires';
/** $1 = primer día del primer mes, $2 = primer día del mes SIGUIENTE al último (exclusivo). */
const RANGO = (col: string) =>
  `${col} >= ($1::date::timestamp at time zone '${ZONA}') and ${col} < ($2::date::timestamp at time zone '${ZONA}')`;
const MES = (col: string) => `to_char(${col} at time zone '${ZONA}', 'YYYY-MM')`;
const VALIDA = `v.estado in ('confirmada','pendiente_cae')`;
const NOTA = `(v.tipo::text like 'nota_credito%')`;
const SIGNO = `case when ${NOTA} then -1 else 1 end`;
const SUC = `coalesce(v.sucursal_id, 0)`;
/** El mes del gasto: al que corresponde, o el de su fecha. */
const MES_GASTO = `coalesce(g.periodo, (g.fecha at time zone '${ZONA}')::date)`;

const N = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export async function leerHechos(c: PoolClient, inicio: string, finExclusivo: string) {
  const p = [inicio, finExclusivo];
  const [items, extras, fiscal, tarjetas, mp, stock, gastos, percIibb, retiros] = await Promise.all([
    c.query(`
      select ${MES('v.fecha')} as mes, ${SUC} as suc, ${NOTA} as nota,
        coalesce(sum(vi.cantidad * coalesce(nullif(vi.precio_lista, 0), vi.precio_unitario)), 0) as lista,
        coalesce(sum(vi.subtotal), 0) as neto,
        coalesce(sum(vi.cantidad * vi.costo_unitario) filter (where vi.costo_unitario is not null), 0) as costo,
        count(*) filter (where vi.costo_unitario is null)::int as sin_costo,
        coalesce(sum(vi.subtotal) filter (where vi.costo_unitario is null), 0) as venta_sin_costo
      from venta_items vi join ventas v on v.id = vi.venta_id
      where ${VALIDA} and ${RANGO('v.fecha')}
      group by 1, 2, 3`, p),
    c.query(`
      select ${MES('v.fecha')} as mes, ${SUC} as suc,
        coalesce(sum(ve.importe * ${SIGNO}) filter (where ve.concepto !~ '^Recargo [0-9]+ cuotas? \\('), 0) as cargos,
        coalesce(sum(ve.importe * ${SIGNO}) filter (where ve.concepto ~ '^Recargo [0-9]+ cuotas? \\('), 0) as recargos
      from venta_extras ve join ventas v on v.id = ve.venta_id
      where ${VALIDA} and ${RANGO('v.fecha')}
      group by 1, 2`, p),
    c.query(`
      select ${MES('v.fecha')} as mes, ${SUC} as suc,
        coalesce(sum(v.subtotal_neto * ${SIGNO}) filter (where (${CLASE_VENTA}) in ('facturado','pendiente')), 0) as facturado,
        coalesce(sum(v.iva_total * ${SIGNO}) filter (where (${CLASE_VENTA}) = 'liquidado'), 0) as iva_sin_factura
      from ventas v
      where ${VALIDA} and ${RANGO('v.fecha')}
      group by 1, 2`, p),
    c.query(`
      select mes, suc, medio, coalesce(sum(importe), 0) as importe from (
        select ${MES('v.fecha')} as mes, ${SUC} as suc, vp.medio::text as medio, vp.importe * ${SIGNO} as importe
        from venta_pagos vp join ventas v on v.id = vp.venta_id
        where ${VALIDA} and ${RANGO('v.fecha')} and vp.medio in ('tarjeta_debito','tarjeta_credito')
        union all
        select ${MES('cb.fecha')}, coalesce(cb.sucursal_id, 0), cp.medio::text, cp.importe
        from cobranza_pagos cp join cobranzas cb on cb.id = cp.cobranza_id
        where cb.estado = 'confirmada' and ${RANGO('cb.fecha')} and cp.medio in ('tarjeta_debito','tarjeta_credito')
      ) x group by 1, 2, 3`, p),
    c.query(`
      select ${MES('v.fecha')} as mes, ${SUC} as suc,
        coalesce(sum(nullif(m.pago_info->>'comision', '')::numeric), 0) as comision,
        count(*) filter (where nullif(m.pago_info->>'comision', '') is null)::int as sin_dato
      from mp_cobros m join ventas v on v.id = m.venta_id
      where m.estado = 'pagado' and ${VALIDA} and ${RANGO('v.fecha')}
      group by 1, 2`, p),
    c.query(`
      select ${MES('m.fecha')} as mes, coalesce(m.sucursal_id, 0) as suc,
        coalesce(sum(m.cantidad * m.costo_unitario) filter (where m.tipo in ('merma','vencido','defectuoso') and m.signo < 0), 0) as perdidas,
        coalesce(sum(m.signo * m.cantidad * m.costo_unitario) filter (where m.tipo = 'ajuste'), 0) as ajustes
      from movimientos m
      where ${RANGO('m.fecha')} and m.tipo in ('merma','vencido','defectuoso','ajuste') and m.costo_unitario > 0
      group by 1, 2`, p),
    c.query(`
      select to_char(${MES_GASTO}, 'YYYY-MM') as mes, g.sucursal_id as suc, g.categoria_id as rubro,
        coalesce(sum(g.total - case when g.letra = 'A' then g.iva else 0 end - g.perc_dgi - g.perc_dgr), 0) as importe,
        count(*)::int as cantidad
      from gastos g
      where g.estado <> 'anulado' and g.negocio <> 'cafeteria'
        and ${MES_GASTO} >= $1::date and ${MES_GASTO} < $2::date
      group by 1, 2, 3`, p),
    /* Percepciones de IIBB sufridas (compras y gastos): pago a cuenta del impuesto. */
    c.query(`
      select mes, coalesce(sum(importe), 0) as importe from (
        select ${MES('c.fecha')} as mes, cp.importe * case when c.tipo = 'nota_credito' then -1 else 1 end as importe
        from comprobante_percepciones cp join comprobantes c on c.id = cp.comprobante_id
        where c.estado = 'confirmado' and c.tipo in ('factura','nota_credito','nota_debito') and c.letra <> 'X'
          and (${TIPO_PERCEPCION_SQL('cp.tipo', 'cp.nombre')}) = 'iibb' and ${RANGO('c.fecha')}
        union all
        select ${MES('g.fecha')}, g.perc_dgr from gastos g
        where g.estado <> 'anulado' and g.perc_dgr <> 0 and ${RANGO('g.fecha')}
      ) x group by 1`, p),
    c.query(`
      select ${MES('r.fecha')} as mes, coalesce(r.sucursal_id, 0) as suc, coalesce(sum(r.costo_total), 0) as costo
      from retiros r where r.anulado_en is null and ${RANGO('r.fecha')}
      group by 1, 2`, p),
  ]);
  const num = (rows: any[]) => rows.map((x) => {
    const o: any = { ...x };
    for (const k of Object.keys(o)) if (k !== 'mes' && k !== 'medio' && k !== 'nota' && o[k] != null) o[k] = N(o[k]);
    return o;
  });
  return {
    items: num(items.rows), extras: num(extras.rows), fiscal: num(fiscal.rows), tarjetas: num(tarjetas.rows),
    mp: num(mp.rows), stock: num(stock.rows), gastos: num(gastos.rows), percIibb: num(percIibb.rows), retiros: num(retiros.rows),
  };
}

/** La configuración y los catálogos que usa la cuenta (todo chico). */
export async function leerCatalogos(c: PoolClient, anioDesde: number) {
  const [rubros, sucs, emps, sueldos, bienes, tasas, escalas, config] = await Promise.all([
    c.query(`select id, nombre, tipo::text as tipo, resultado, reparte, activa, orden from gasto_categorias order by orden, nombre`),
    c.query(`select id, nombre, activa from sucursales order by id`),
    c.query(`select id, nombre, cuil, sucursal_id, to_char(alta, 'YYYY-MM-DD') as alta, to_char(baja, 'YYYY-MM-DD') as baja, observaciones
             from empleados order by nombre`),
    c.query(`select id, empleado_id, to_char(desde, 'YYYY-MM') as desde, bruto, cargas from empleado_sueldos order by empleado_id, desde`),
    c.query(`select id, nombre, sucursal_id, valor, to_char(alta, 'YYYY-MM-DD') as alta, vida_meses, to_char(baja, 'YYYY-MM-DD') as baja, observaciones
             from bienes_uso order by alta, nombre`),
    c.query(`select id, concepto, sucursal_id, medio, porcentaje, minimo, to_char(desde, 'YYYY-MM') as desde from resultados_tasas order by concepto, desde`),
    c.query(`select anio, tramos, deducciones from ganancias_escalas where anio >= $1 - 5 order by anio`, [anioDesde]),
    c.query(`select valor from resultados_config where id = 1`),
  ]);
  const sueldosDe = new Map<number, any[]>();
  for (const s of sueldos.rows) {
    const l = sueldosDe.get(s.empleado_id) ?? [];
    l.push({ id: s.id, desde: s.desde, bruto: N(s.bruto), cargas: N(s.cargas) });
    sueldosDe.set(s.empleado_id, l);
  }
  const cfg: any = config.rows[0]?.valor ?? {};
  return {
    rubros: rubros.rows.map((r: any) => ({ ...r, reparte: !!r.reparte, activa: !!r.activa })),
    sucursales: sucs.rows.map((s: any) => ({ id: s.id, nombre: s.nombre, activa: !!s.activa })),
    empleados: emps.rows.map((e: any) => ({
      id: e.id, nombre: e.nombre, cuil: e.cuil, sucursalId: e.sucursal_id, alta: e.alta, baja: e.baja,
      observaciones: e.observaciones, sueldos: sueldosDe.get(e.id) ?? [],
    })),
    bienes: bienes.rows.map((b: any) => ({
      id: b.id, nombre: b.nombre, sucursalId: b.sucursal_id, valor: N(b.valor), alta: b.alta,
      vidaMeses: N(b.vida_meses), baja: b.baja, observaciones: b.observaciones,
    })),
    tasas: tasas.rows.map((t: any) => ({
      id: t.id, concepto: t.concepto, sucursalId: t.sucursal_id, medio: t.medio,
      porcentaje: N(t.porcentaje), minimo: N(t.minimo), desde: t.desde,
    })),
    escalas: escalas.rows.map((e: any) => ({ anio: N(e.anio), tramos: e.tramos ?? [], deducciones: e.deducciones ?? {} })),
    config: {
      amortizaciones: cfg.amortizaciones === true,
      gananciasBase: cfg.gananciasBase === 'todo' ? 'todo' as const : 'facturado' as const,
    },
  };
}

export async function leerObjetivos(c: PoolClient, inicio: string, finExclusivo: string) {
  const r = await c.query(`
    select to_char(mes, 'YYYY-MM') as mes, sucursal_id, venta_neta, resultado
    from resultados_objetivos where mes >= $1::date and mes < $2::date order by mes`, [inicio, finExclusivo]);
  return r.rows.map((o: any) => ({
    mes: o.mes, sucursalId: o.sucursal_id,
    ventaNeta: o.venta_neta == null ? null : N(o.venta_neta), resultado: o.resultado == null ? null : N(o.resultado),
  }));
}
