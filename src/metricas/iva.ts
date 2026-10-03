/**
 * RESULTADOS IVA (3/10/2026, pedido del dueño)
 * ============================================================================
 * «Ver bien cuánto compré facturado, cuánto vendí facturado, con porcentajes,
 * porque compro y vendo también en remito; y a la vez mi resultado de IVA.»
 *
 * Se lee de las tablas VIVAS (ventas, comprobantes, gastos), no de los
 * resúmenes de Métricas: el IVA tiene que cuadrar con los comprobantes tal
 * como están hoy (una NC cargada ayer cambia el mes pasado). Va por el pool
 * propio de Métricas, en solo lectura y con tope de tiempo.
 *
 * VENTAS (estado confirmada; las NC restan):
 *   facturado  factura_a/b/c, nota_debito_a/b/c (+) y nota_credito_a/b/c (−)
 *   pendiente  ticket con `facturar_pendiente` (ARCA caída: se cobró como
 *              factura y todavía no tiene CAE) — aparte, y suma al débito con aviso
 *   liquidado  ticket sin factura (F10) y sus devoluciones (nota_credito_ticket)
 *
 * COMPRAS (comprobantes confirmados, por su fecha — la del papel; NC restan):
 *   factura A  neto e IVA discriminado: el IVA es crédito fiscal
 *   factura B/C  el IVA viene adentro del precio y NO es crédito fiscal
 *   sin factura  liquidaciones (la mitad sin factura; letra X)
 *   remitos    todavía sin facturar: se muestran aparte (pueden pasar a factura)
 *   Para los % se compara lo que costó la mercadería: neto en A, total en B/C
 *   y liquidaciones (para la casa ese IVA es costo).
 *
 * GASTOS: crédito fiscal = IVA de los de letra A (las NC de gasto ya vienen en
 *   negativo); percepción de IVA = `perc_dgi`.
 *
 * PERCEPCIONES de compras: las de tipo IVA (marcadas o deducidas del nombre,
 *   misma regla que `tipoPercepcion`). Son pago a cuenta del IVA: restan.
 *
 * POSICIÓN mes a mes: débito − crédito − percepciones − saldo a favor del mes
 *   anterior. Positivo = a pagar; negativo = saldo a favor que pasa al mes
 *   siguiente. Arranca en el saldo inicial cargado (Sistema › Empresa, desde
 *   esta pestaña) o en cero. Es una aproximación de gestión: la declaración la
 *   hace la contadora (retenciones sufridas, saldo de libre disponibilidad, etc.).
 */
import type { PoolClient } from 'pg';
import { N, r2, pct, type Filtro } from './consultas';

const ZONA = 'America/Argentina/Buenos_Aires';
const DIA = (col: string) => `(${col} at time zone '${ZONA}')::date`;
const MES = (col: string) => `to_char(date_trunc('month', ${col} at time zone '${ZONA}'), 'YYYY-MM')`;

/** La regla de `tipoPercepcion` (common/iva.ts), en SQL. */
const TIPO_PERCEPCION_SQL = (t: string, n: string) => `case
  when ${t} in ('iva','iibb','otro') then ${t}
  when lower(${n}) ~ '(^|[^a-z])iva([^a-z]|$)|rg\\s*(2408|3337|5329)' then 'iva'
  when lower(${n}) ~ 'iibb|ingresos\\s*brutos|(^|[^a-z])dgr([^a-z]|$)|(^|[^a-z])ib([^a-z]|$)' then 'iibb'
  else 'otro' end`;

const SIGNO_VENTA = `case when v.tipo::text like 'nota_credito%' then -1 else 1 end`;
const CLASE_VENTA = `case
  when v.tipo::text like 'factura_%' or v.tipo::text like 'nota_debito_%'
    or (v.tipo::text like 'nota_credito_%' and v.tipo::text <> 'nota_credito_ticket') then 'facturado'
  when v.tipo = 'ticket' and v.facturar_pendiente then 'pendiente'
  else 'liquidado' end`;
const SIGNO_COMPRA = `case when c.tipo = 'nota_credito' then -1 else 1 end`;
const CLASE_COMPRA = `case
  when c.tipo = 'remito' then 'remito'
  when c.tipo = 'liquidacion' or c.letra = 'X' then 'sin_factura'
  when c.letra = 'A' then 'factura_a'
  else 'factura_bc' end`;

type Rango = { desde: string; hasta: string; sucursalId: number | null };

/** Las cifras de un rango, agrupadas por mes o en un solo renglón (`mes` = 'total'). */
async function cifras(c: PoolClient, r: Rango, porMes: boolean) {
  const grupoV = porMes ? MES('v.fecha') : `'total'`;
  const grupoC = porMes ? MES('c.fecha') : `'total'`;
  const grupoG = porMes ? MES('g.fecha') : `'total'`;
  const p = [r.desde, r.hasta, r.sucursalId];
  const sucV = `($3::int is null or v.sucursal_id = $3)`;
  const sucC = `($3::int is null or c.sucursal_id = $3)`;
  const sucG = `($3::int is null or g.sucursal_id = $3)`;

  const [ventas, alic, compras, percs, gastos] = await Promise.all([
    c.query(`
      select ${grupoV} as mes, ${CLASE_VENTA} as clase,
        coalesce(sum(v.total * ${SIGNO_VENTA}), 0) as total,
        coalesce(sum(v.iva_total * ${SIGNO_VENTA}), 0) as iva,
        count(*) filter (where v.tipo::text not like 'nota_credito%')::int as comprobantes,
        count(*) filter (where v.tipo::text like 'nota_credito%')::int as notas
      from ventas v
      where v.estado in ('confirmada','pendiente_cae') and ${DIA('v.fecha')} between $1::date and $2::date and ${sucV}
      group by 1, 2`, p),
    /* El débito por alícuota (y el IVA absorbido) de lo facturado y lo pendiente: renglones y cargos extra. */
    c.query(`
      select ${grupoV} as mes, x.alicuota,
        coalesce(sum(x.neto * ${SIGNO_VENTA}), 0) as neto,
        coalesce(sum(x.absorbido * ${SIGNO_VENTA}), 0) as absorbido
      from (
        select vi.venta_id, vi.iva as alicuota, vi.subtotal as neto, coalesce(vi.cantidad * vi.iva_absorbido_unitario, 0) as absorbido from venta_items vi
        union all
        select ve.venta_id, ve.iva as alicuota, ve.importe as neto, 0 as absorbido from venta_extras ve
      ) x
      join ventas v on v.id = x.venta_id
      where v.estado in ('confirmada','pendiente_cae') and ${DIA('v.fecha')} between $1::date and $2::date and ${sucV}
        and (${CLASE_VENTA}) in ('facturado','pendiente')
      group by 1, 2`, p),
    c.query(`
      select ${grupoC} as mes, ${CLASE_COMPRA} as clase,
        coalesce(sum(c.subtotal_neto * ${SIGNO_COMPRA}), 0) as neto,
        coalesce(sum(c.iva_total * ${SIGNO_COMPRA}), 0) as iva,
        coalesce(sum(c.total * ${SIGNO_COMPRA}), 0) as total,
        count(*) filter (where c.tipo <> 'nota_credito')::int as comprobantes,
        count(*) filter (where c.tipo = 'nota_credito')::int as notas
      from comprobantes c
      where c.estado = 'confirmado' and c.tipo in ('factura','liquidacion','nota_credito','nota_debito','remito')
        and ${DIA('c.fecha')} between $1::date and $2::date and ${sucC}
      group by 1, 2`, p),
    c.query(`
      select ${grupoC} as mes, ${TIPO_PERCEPCION_SQL('cp.tipo', 'cp.nombre')} as tipo,
        coalesce(sum(cp.importe * ${SIGNO_COMPRA}), 0) as importe, count(*)::int as cantidad,
        count(*) filter (where cp.tipo = '')::int as sin_marcar
      from comprobante_percepciones cp join comprobantes c on c.id = cp.comprobante_id
      where c.estado = 'confirmado' and c.tipo in ('factura','nota_credito','nota_debito')
        and ${DIA('c.fecha')} between $1::date and $2::date and ${sucC}
      group by 1, 2`, p),
    c.query(`
      select ${grupoG} as mes,
        coalesce(sum(g.iva) filter (where g.letra = 'A'), 0) as iva,
        coalesce(sum(g.neto) filter (where g.letra = 'A'), 0) as neto_a,
        coalesce(sum(g.perc_dgi), 0) as perc_iva,
        coalesce(sum(g.total), 0) as total,
        count(*)::int as cantidad,
        count(*) filter (where g.letra <> 'A' and g.iva <> 0)::int as iva_sin_credito
      from gastos g
      where g.estado <> 'anulado' and ${DIA('g.fecha')} between $1::date and $2::date and ${sucG}
      group by 1`, p),
  ]);
  return { ventas: ventas.rows, alicuotas: alic.rows, compras: compras.rows, percepciones: percs.rows, gastos: gastos.rows };
}

/** Lo de un mes (o del total), con nombres. */
function armar(d: Awaited<ReturnType<typeof cifras>>, mes: string) {
  const v = (cl: string) => d.ventas.find((x: any) => x.mes === mes && x.clase === cl);
  const c = (cl: string) => d.compras.find((x: any) => x.mes === mes && x.clase === cl);
  const g = d.gastos.find((x: any) => x.mes === mes);
  const percIvaCompras = r2(d.percepciones.filter((x: any) => x.mes === mes && x.tipo === 'iva').reduce((a: number, x: any) => a + N(x.importe), 0));
  const ventas = {
    facturado: { total: r2(N(v('facturado')?.total)), iva: r2(N(v('facturado')?.iva)), comprobantes: N(v('facturado')?.comprobantes), notas: N(v('facturado')?.notas) },
    pendiente: { total: r2(N(v('pendiente')?.total)), iva: r2(N(v('pendiente')?.iva)), comprobantes: N(v('pendiente')?.comprobantes) },
    liquidado: { total: r2(N(v('liquidado')?.total)), comprobantes: N(v('liquidado')?.comprobantes), notas: N(v('liquidado')?.notas) },
  };
  const baseV = ventas.facturado.total + ventas.pendiente.total + ventas.liquidado.total;
  const compras = {
    facturaA: { neto: r2(N(c('factura_a')?.neto)), iva: r2(N(c('factura_a')?.iva)), total: r2(N(c('factura_a')?.total)), comprobantes: N(c('factura_a')?.comprobantes), notas: N(c('factura_a')?.notas) },
    facturaBC: { total: r2(N(c('factura_bc')?.neto)), comprobantes: N(c('factura_bc')?.comprobantes), notas: N(c('factura_bc')?.notas) },
    sinFactura: { total: r2(N(c('sin_factura')?.neto)), comprobantes: N(c('sin_factura')?.comprobantes), notas: N(c('sin_factura')?.notas) },
    remitos: { total: r2(N(c('remito')?.neto)), comprobantes: N(c('remito')?.comprobantes) },
  };
  const compradoFacturado = compras.facturaA.neto + compras.facturaBC.total;
  const baseC = compradoFacturado + compras.sinFactura.total;
  const gastos = { iva: r2(N(g?.iva)), netoA: r2(N(g?.neto_a)), percIva: r2(N(g?.perc_iva)), total: r2(N(g?.total)), cantidad: N(g?.cantidad), ivaSinCredito: N(g?.iva_sin_credito) };
  const debito = r2(ventas.facturado.iva + ventas.pendiente.iva);
  const credito = r2(compras.facturaA.iva + gastos.iva);
  const percepciones = r2(percIvaCompras + gastos.percIva);
  return {
    ventas: {
      ...ventas,
      pct: { facturado: pct(ventas.facturado.total, baseV), pendiente: pct(ventas.pendiente.total, baseV), liquidado: pct(ventas.liquidado.total, baseV) },
      total: r2(baseV),
    },
    compras: {
      ...compras,
      facturado: r2(compradoFacturado),
      total: r2(baseC),
      pct: { facturado: pct(compradoFacturado, baseC), sinFactura: pct(compras.sinFactura.total, baseC) },
    },
    gastos,
    iva: {
      debito, debitoFacturado: ventas.facturado.iva, debitoPendiente: ventas.pendiente.iva,
      credito, creditoCompras: compras.facturaA.iva, creditoGastos: gastos.iva,
      percepciones, percepcionesCompras: percIvaCompras, percepcionesGastos: gastos.percIva,
      resultado: r2(debito - credito - percepciones),
    },
  };
}

const mesesEntre = (a: string, b: string) => {
  const out: string[] = [];
  let [y, m] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  while (y < yb || (y === yb && m <= mb)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
};
const finDeMes = (mes: string) => {
  const [y, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/**
 * La posición mes a mes con el saldo a favor arrastrado. `saldo` = el saldo a
 * favor con el que ARRANCA el primer mes. Devuelve, por mes, lo de cada uno.
 */
export function arrastrar(meses: { mes: string; debito: number; credito: number; percepciones: number }[], saldo: number) {
  let favor = Math.max(0, N(saldo));
  return meses.map((m) => {
    const saldoAnterior = r2(favor);
    const posicion = r2(m.debito - m.credito - m.percepciones - favor);
    const aPagar = posicion > 0 ? posicion : 0;
    favor = posicion > 0 ? 0 : -posicion;
    return { ...m, saldoAnterior, aPagar: r2(aPagar), saldoAFavor: r2(favor) };
  });
}

export async function reporteIva(c: PoolClient, f: Filtro, saldoInicial: { importe: number; mes: string }) {
  const mesDesde = f.desde.slice(0, 7);
  const mesHasta = f.hasta.slice(0, 7);
  /* El arrastre arranca en el mes del saldo inicial (si es anterior) o en el
   * primer mes del período; como mucho 36 meses atrás. */
  const mesInicioSaldo = /^\d{4}-\d{2}$/.test(saldoInicial.mes) ? saldoInicial.mes : '';
  let inicio = mesInicioSaldo && mesInicioSaldo < mesDesde ? mesInicioSaldo : mesDesde;
  const tope = mesesEntre(inicio, mesHasta);
  if (tope.length > 36) inicio = tope[tope.length - 36];
  const [periodo, porMes] = await Promise.all([
    cifras(c, f, false),
    cifras(c, { desde: `${inicio}-01`, hasta: finDeMes(mesHasta) < f.hasta ? finDeMes(mesHasta) : f.hasta, sucursalId: f.sucursalId }, true),
  ]);
  const total = armar(periodo, 'total');

  const lista = mesesEntre(inicio, mesHasta).map((mes) => {
    const a = armar(porMes, mes);
    return {
      mes,
      debito: a.iva.debito, credito: a.iva.credito, percepciones: a.iva.percepciones,
      ventasFacturadas: r2(a.ventas.facturado.total + a.ventas.pendiente.total), ventasLiquidadas: a.ventas.liquidado.total,
      comprasFacturadas: a.compras.facturado, comprasSinFactura: a.compras.sinFactura.total,
      pctVentasFacturadas: pct(a.ventas.facturado.total + a.ventas.pendiente.total, a.ventas.total),
      pctComprasFacturadas: a.compras.pct.facturado,
    };
  });
  /* El saldo inicial vale desde SU mes; antes de ese mes se arranca en cero. */
  const desdeSaldo = mesInicioSaldo ? lista.findIndex((m) => m.mes === mesInicioSaldo) : -1;
  const conArrastre = desdeSaldo >= 0
    ? [...arrastrar(lista.slice(0, desdeSaldo), 0), ...arrastrar(lista.slice(desdeSaldo), saldoInicial.importe)]
    : arrastrar(lista, 0);
  const meses = conArrastre.filter((m) => m.mes >= mesDesde);

  /* Por alícuota (débito): del período. El IVA por alícuota se calcula sobre el neto. */
  const porAlicuota = periodo.alicuotas
    .map((x: any) => ({ alicuota: N(x.alicuota), neto: r2(N(x.neto)), iva: r2(N(x.neto) * N(x.alicuota) / 100) }))
    .filter((x: any) => Math.abs(x.neto) > 0.009)
    .sort((a: any, b: any) => b.alicuota - a.alicuota);
  const ivaAbsorbido = r2(periodo.alicuotas.reduce((a: number, x: any) => a + N(x.absorbido), 0));

  /* Por proveedor: cuánto le compraste con y sin factura en el período. */
  const prov = await c.query(`
    select p.id, p.nombre,
      coalesce(sum(case when c.tipo <> 'liquidacion' and c.letra <> 'X' then c.subtotal_neto else 0 end * ${SIGNO_COMPRA}), 0) as facturado,
      coalesce(sum(case when c.tipo = 'liquidacion' or c.letra = 'X' then c.subtotal_neto else 0 end * ${SIGNO_COMPRA}), 0) as sin_factura
    from comprobantes c join proveedores p on p.id = c.proveedor_id
    where c.estado = 'confirmado' and c.tipo in ('factura','liquidacion','nota_credito','nota_debito')
      and ${DIA('c.fecha')} between $1::date and $2::date and ($3::int is null or c.sucursal_id = $3)
    group by 1, 2`, [f.desde, f.hasta, f.sucursalId]);
  const porProveedor = prov.rows
    .map((x: any) => {
      const fac = r2(N(x.facturado)); const sin = r2(N(x.sin_factura));
      return { proveedorId: x.id, proveedor: x.nombre, facturado: fac, sinFactura: sin, total: r2(fac + sin), pctSinFactura: pct(sin, fac + sin) };
    })
    .filter((x: any) => Math.abs(x.total) > 0.009)
    .sort((a: any, b: any) => b.total - a.total)
    .slice(0, 20);

  const ult = meses[meses.length - 1];
  const percSinMarcar = periodo.percepciones.reduce((a: number, x: any) => a + N(x.sin_marcar), 0);
  const percOtras = periodo.percepciones.filter((x: any) => x.tipo === 'otro').reduce((a: number, x: any) => a + N(x.cantidad), 0);
  const avisos: string[] = [];
  if (total.ventas.pendiente.comprobantes > 0) {
    avisos.push(`${total.ventas.pendiente.comprobantes} venta(s) cobradas como factura con ARCA caída todavía sin CAE: su IVA (${total.iva.debitoPendiente}) está sumado al débito. Facturalas en Ventas › Caídas por ARCA.`);
  }
  if (total.compras.remitos.comprobantes > 0) {
    avisos.push(`${total.compras.remitos.comprobantes} remito(s) de compra sin facturar: no entran en los % hasta que se sepa si llegan con factura o sin factura.`);
  }
  if (percOtras > 0) avisos.push(`${percOtras} percepción(es) de compra no se reconocen como IVA ni IIBB por su nombre: marcales el tipo en la ficha del proveedor.`);
  if (total.gastos.ivaSinCredito > 0) avisos.push(`${total.gastos.ivaSinCredito} gasto(s) de letra B/C/ticket tienen IVA cargado: no es crédito fiscal y no se suma.`);
  if (f.sucursalId != null) avisos.push('El IVA se declara por CUIT, con todas las sucursales juntas: este resultado es solo de la sucursal elegida.');

  return {
    periodo: { desde: f.desde, hasta: f.hasta, sucursalId: f.sucursalId },
    ...total,
    iva: {
      ...total.iva,
      porAlicuota,
      ivaAbsorbido,
      /* Del último mes del período, con el arrastre. */
      saldoAnterior: ult?.saldoAnterior ?? 0,
      aPagar: ult?.aPagar ?? 0,
      saldoAFavor: ult?.saldoAFavor ?? 0,
      aPagarPeriodo: r2(meses.reduce((a, m) => a + m.aPagar, 0)),
    },
    /* Cuánto se vende facturado por cada $100 que se compra facturado (con IVA en los dos lados). */
    cobertura: total.compras.facturaA.total + total.compras.facturaBC.total > 0
      ? r2(((total.ventas.facturado.total + total.ventas.pendiente.total) / (total.compras.facturaA.total + total.compras.facturaBC.total)) * 100)
      : null,
    porProveedor,
    meses,
    saldoInicial: { importe: N(saldoInicial.importe), mes: mesInicioSaldo },
    percepcionesSinMarcar: percSinMarcar,
    avisos,
  };
}
