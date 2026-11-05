/**
 * CONCILIACIÓN DE EFECTIVO (4/11/2026, pedido del dueño)
 * ============================================================================
 * «Lo que vendí en efectivo en el mes, ¿me llegó a la mano?» De punta a punta,
 * con los turnos de caja que CERRARON en el mes (como «Sobres por sucursal»):
 *
 *   efectivo de ventas + cobranzas + otros ingresos − egresos de la caja
 *   = lo que generaron las cajas
 *   − lo que generaron los turnos que cerró un jefe sin sobre (no viajó)
 *   ± la diferencia al abrir (lo que se encontró contra lo que dejó el cierre anterior)
 *   ± el fondo (lo que encontraron menos lo que dejaron)
 *   = lo que debía ir en los sobres
 *   ± la diferencia de los cajeros al contar
 *   = lo enviado
 *   − sin rendir / antes del Cash Flow / no corresponde
 *   ± la diferencia al controlar
 *   = lo contado en el Cash Flow
 *
 * LA DIFERENCIA AL ABRIR: si el cierre de anoche dejó $50.000 y a la mañana
 * se abre con $49.000, esos $1.000 se perdieron entre una caja y la otra. No es
 * «fondo que quedó»: es un faltante, y va como tal. Se mide contra lo que dejó
 * el turno anterior del mismo local; si ese lo cerró un jefe sin sobre (no
 * dejó un fondo contado) o no hay anterior, no hay contra qué medir.
 *
 * Cada renglón se suma turno por turno con los números que el turno ya guardó
 * (el esperado, lo contado, el envío, el fondo que quedó, el sobre): no se
 * recalcula nada que la caja no haya firmado. El detalle del esperado (ventas,
 * cobranzas, movimientos) se lee con la misma regla que el arqueo; si algún
 * turno no cuadra con lo guardado, se avisa con su número en vez de taparlo.
 *
 * Aparte, el puente con Gerencia › Métricas («Cómo se cobra»), que cuenta por
 * DÍA DE VENTA: qué separa ese número del efectivo de ventas de estos turnos.
 *
 * Solo lectura. La regla (`armarConciliacion`) es pura y tiene su prueba; la
 * consulta (`consultarConciliacion`) solo junta los números.
 */
import { sql } from 'drizzle-orm';
import { estadoTurno, type EstadoTurno } from './planilla';

const ZONA = 'America/Argentina/Buenos_Aires';
const filas = (r: any) => (r.rows ?? r) as any[];
/** Se suma en centavos: doscientos turnos no pueden dejar un «$0,01» de redondeo. */
const c = (n: unknown) => Math.round((Number(n) || 0) * 100);
const $ = (centavos: number) => centavos / 100;

/** Un turno cerrado, como lo trae la consulta. */
export interface TurnoConc {
  id: number;
  sucursalId: number;
  sucursal: string;
  cajero: string;
  apertura: string | null;
  cierre: string | null;
  cierreDia: string;
  fondoInicial: number;
  ventas: number;
  cobranzas: number;
  ingresos: number;
  pagosProveedor: number;
  devoluciones: number;
  otrosEgresos: number;
  /** Lo que el turno guardó al cerrar (y corrigió un movimiento posterior, 0137). */
  esperado: number;
  contado: number;
  difCajero: number;
  /** null = lo cerró un jefe con el cierre de siempre: no hubo sobre. */
  envio: number | null;
  fondoQueda: number | null;
  /** Lo que dejó en la caja el turno anterior del local; null = no se sabe (lo cerró un jefe, o es el primero). */
  fondoAnterior: number | null;
  sobreId: number | null;
  sobreEnviado: number | null;
  sobreContado: number | null;
  sobreDif: number | null;
  descartado: boolean;
}

/** Lo que separa «Cómo se cobra» de Métricas del efectivo de ventas de estos turnos. */
export interface VentasMes {
  /** Efectivo vendido en el mes por día de venta, con el criterio de Métricas. */
  metricas: number;
  /** De eso, en turnos que siguen abiertos o que cierran en otro mes. */
  otrosTurnos: number;
  /** De eso, cobrado sin turno de caja: no entra en ningún sobre. */
  sinCaja: number;
  /** De eso, facturas esperando el CAE: la caja no las espera hasta confirmarse. */
  esperandoCae: number;
  /** En turnos que cerraron en el mes, con fecha de venta de otro mes. */
  deOtroMes: number;
}

const CAMPOS = [
  'ventas', 'cobranzas', 'ingresos', 'pagosProveedor', 'devoluciones', 'otrosEgresos', 'sinDetalle', 'generado',
  'jefeGenerado', 'jefeContado', 'jefeDif', 'jefeApertura', 'difApertura', 'fondoAbrieron', 'fondoDejaron', 'debiaSobres', 'difCajeros', 'enviado',
  'sinRendir', 'previo', 'noCorresponde', 'controlado', 'difControl', 'contado', 'faltantes', 'sobrantes',
] as const;
type Campo = (typeof CAMPOS)[number];
export type Totales = Record<Campo, number> & { turnos: number; porJefe: number; sinRendirN: number; diferencias: number };

/** Lo que cada turno aporta a cada renglón, en centavos. */
function aporte(t: TurnoConc, estado: EstadoTurno): Record<Campo, number> {
  const egresos = c(t.pagosProveedor) + c(t.devoluciones) + c(t.otrosEgresos);
  const neto = c(t.ventas) + c(t.cobranzas) + c(t.ingresos) - egresos;
  const generado = c(t.esperado) - c(t.fondoInicial);
  const porJefe = t.envio == null;
  const envio = porJefe ? 0 : c(t.envio);
  const rendida = estado === 'rendida';
  /* Al abrir: lo que se encontró contra lo que dejó el cierre anterior (0 si no se sabe). */
  const apertura = t.fondoAnterior == null ? 0 : c(t.fondoInicial) - c(t.fondoAnterior);
  /* Todas las diferencias de la caja (al abrir, al cerrar, al controlar el sobre), sin compensar unas con otras. */
  const difs = [apertura, c(t.difCajero), rendida ? c(t.sobreDif) : 0];
  return {
    ventas: c(t.ventas), cobranzas: c(t.cobranzas), ingresos: c(t.ingresos),
    pagosProveedor: c(t.pagosProveedor), devoluciones: c(t.devoluciones), otrosEgresos: c(t.otrosEgresos),
    /* El esperado guardado contra su detalle: 0 salvo un dato raro (se avisa aparte). */
    sinDetalle: generado - neto,
    generado,
    jefeGenerado: porJefe ? generado : 0,
    jefeContado: porJefe ? c(t.contado) : 0,
    jefeDif: porJefe ? c(t.difCajero) : 0,
    jefeApertura: porJefe ? apertura : 0,
    difApertura: porJefe ? 0 : apertura,
    /* Lo que encontraron al abrir según el cierre anterior (o con lo que abrieron, si no se sabe). */
    fondoAbrieron: porJefe ? 0 : c(t.fondoInicial) - apertura,
    fondoDejaron: porJefe ? 0 : c(t.fondoQueda),
    debiaSobres: porJefe ? 0 : c(t.esperado) - c(t.fondoQueda),
    difCajeros: porJefe ? 0 : c(t.difCajero),
    enviado: envio,
    sinRendir: estado === 'sin_rendir' ? envio : 0,
    previo: estado === 'previo' ? envio : 0,
    noCorresponde: estado === 'no_corresponde' ? envio : 0,
    controlado: rendida ? envio : 0,
    difControl: rendida ? c(t.sobreDif) : 0,
    contado: rendida ? c(t.sobreContado) : 0,
    faltantes: difs.filter((d) => d < 0).reduce((a, d) => a + d, 0),
    sobrantes: difs.filter((d) => d > 0).reduce((a, d) => a + d, 0),
  };
}

function totales(lista: { aporte: Record<Campo, number>; porJefe: boolean; estado: EstadoTurno }[]): Totales {
  const suma = Object.fromEntries(CAMPOS.map((k) => [k, 0])) as Record<Campo, number>;
  for (const x of lista) for (const k of CAMPOS) suma[k] += x.aporte[k];
  const t = Object.fromEntries(CAMPOS.map((k) => [k, $(suma[k])])) as Record<Campo, number>;
  return {
    ...t,
    turnos: lista.length,
    porJefe: lista.filter((x) => x.porJefe).length,
    sinRendirN: lista.filter((x) => x.estado === 'sin_rendir').length,
    /* Lo que faltó (−) o sobró (+) en el camino de los sobres, neto: al abrir, al cerrar y al controlar. */
    diferencias: $(suma.difApertura + suma.difCajeros + suma.difControl),
  };
}

/** Por qué un turno no cuadra consigo mismo (vacío = cuadra). */
function descuadres(t: TurnoConc, a: Record<Campo, number>): string[] {
  const out: string[] = [];
  if (a.sinDetalle !== 0) out.push('el esperado guardado no coincide con sus ventas, cobranzas y movimientos');
  if (t.envio != null && c(t.contado) !== c(t.envio) + c(t.fondoQueda)) out.push('lo contado no es el envío más el fondo que quedó');
  if (t.sobreId != null && t.envio != null && c(t.sobreEnviado) !== c(t.envio)) out.push('el sobre controlado dice otro envío que el turno');
  if (c(t.contado) - c(t.esperado) !== c(t.difCajero)) out.push('la diferencia guardada no es lo contado menos lo esperado');
  return out;
}

export function armarConciliacion(turnosIn: TurnoConc[], fechaInicio: string | null, ventasMes: VentasMes | null) {
  const lista = turnosIn.map((t) => {
    const estado = estadoTurno({ estado: 'cerrada', envio: t.envio ?? 0, sobreId: t.sobreId, descartado: t.descartado, cierreDia: t.cierreDia }, fechaInicio);
    const a = aporte(t, estado);
    return { t, estado, porJefe: t.envio == null, aporte: a, descuadre: descuadres(t, a) };
  });
  const total = totales(lista);

  const porSuc = new Map<number, typeof lista>();
  for (const x of lista) {
    const l = porSuc.get(x.t.sucursalId);
    if (l) l.push(x); else porSuc.set(x.t.sucursalId, [x]);
  }
  const porSucursal = [...porSuc.values()]
    .map((l) => ({ sucursalId: l[0].t.sucursalId, sucursal: l[0].t.sucursal, ...totales(l) }))
    .sort((a, b) => a.sucursal.localeCompare(b.sucursal, 'es'));

  const turnos = lista.map(({ t, estado, porJefe, aporte: a, descuadre }) => ({
    id: t.id, sucursalId: t.sucursalId, sucursal: t.sucursal, cajero: t.cajero, apertura: t.apertura, cierre: t.cierre,
    estado, porJefe,
    generado: $(a.generado),
    debiaSobre: porJefe ? null : $(a.debiaSobres),
    difApertura: t.fondoAnterior == null ? null : $(a.difApertura + a.jefeApertura),
    difCajero: t.difCajero,
    envio: t.envio,
    contado: estado === 'rendida' ? t.sobreContado : null,
    difControl: estado === 'rendida' ? t.sobreDif : null,
    descuadre,
  }));

  /*
   * EL PUENTE CON MÉTRICAS: lo vendido en efectivo en el mes (por día de
   * venta) menos lo que no cae en estos turnos, más lo de otro mes que sí cae,
   * tiene que dar el efectivo de ventas de arriba. Si no da, se dice.
   */
  const desdeMetricas = ventasMes && (() => {
    const calculado = c(ventasMes.metricas) - c(ventasMes.otrosTurnos) - c(ventasMes.sinCaja) - c(ventasMes.esperandoCae) + c(ventasMes.deOtroMes);
    return { ...ventasMes, resultado: $(calculado), cuadra: calculado === c(total.ventas) };
  })();

  return {
    total,
    porSucursal,
    turnos,
    desdeMetricas,
    /** Los turnos que no cuadran consigo mismos: pocos o ninguno; se nombran. */
    descuadres: turnos.filter((t) => t.descuadre.length).map((t) => ({ id: t.id, sucursal: t.sucursal, cierre: t.cierre, motivos: t.descuadre })),
  };
}

/* ------------------------------------------------------------------------ *
 * La consulta: tres lecturas, sin N+1.
 * ------------------------------------------------------------------------ */
const enRango = (col: string, desde: string, hasta: string) => sql.raw(
  `${col} >= ('${desde}'::date::timestamp at time zone '${ZONA}') and ${col} < (('${hasta}'::date + 1)::timestamp at time zone '${ZONA}')`,
);
/** Clase de un movimiento de caja: la misma regla que Ventas › Caja › Ingresos y egresos. */
const CLASE_MOV = sql`case when m.concepto_id is not null then 'concepto' when pp.id is not null then 'pago_proveedor'
  when m.motivo like 'Devolución %' then 'devolucion' else 'otro' end`;

/** `desde`/`hasta` llegan validados ('AAAA-MM-DD'). */
export async function consultarConciliacion(db: any, desde: string, hasta: string, sucursalId: number, cajeroDelTurno: any) {
  const cierreEnMes = enRango('cs.cierre', desde, hasta);
  const sucTurno = sucursalId ? sql`and cs.sucursal_id = ${sucursalId}` : sql``;
  const sucVenta = sucursalId ? sql`and v.sucursal_id = ${sucursalId}` : sql``;
  const sucCobranza = sucursalId ? sql`and co.sucursal_id = ${sucursalId}` : sql``;
  const [turnos, detalle, ventas, cobranzasSueltas] = await Promise.all([
    db.execute(sql`
      select cs.id, cs.sucursal_id as "sucursalId", su.nombre as sucursal, coalesce(uc.nombre, ua.nombre, '') as cajero,
        cs.apertura, cs.cierre, (cs.cierre at time zone ${ZONA})::date::text as "cierreDia",
        cs.monto_inicial as "fondoInicial", cs.sistema_efectivo as esperado, cs.declarado_efectivo as contado,
        cs.diferencia as "difCajero", cs.envio_efectivo as envio, cs.fondo_queda as "fondoQueda", ant.fondo_queda as "fondoAnterior",
        coalesce(vv.importe, 0) as ventas, coalesce(cb.importe, 0) as cobranzas,
        coalesce(mv.ingresos, 0) as ingresos, coalesce(mv.proveedor, 0) as "pagosProveedor",
        coalesce(mv.devoluciones, 0) as devoluciones, coalesce(mv.otros, 0) as "otrosEgresos",
        s.id as "sobreId", s.enviado as "sobreEnviado", s.contado as "sobreContado", s.diferencia as "sobreDif",
        coalesce(s.descartado, false) as descartado
      from caja_sesiones cs
      join sucursales su on su.id = cs.sucursal_id
      ${cajeroDelTurno}
      left join lateral (
        select p.fondo_queda from caja_sesiones p
        where p.sucursal_id = cs.sucursal_id and (p.apertura, p.id) < (cs.apertura, cs.id)
        order by p.apertura desc, p.id desc limit 1
      ) ant on true
      left join lateral (
        select sum(vp.importe) as importe from ventas v join venta_pagos vp on vp.venta_id = v.id
        where v.caja_sesion_id = cs.id and v.estado = 'confirmada' and vp.medio = 'efectivo'
      ) vv on true
      left join lateral (
        select sum(cp.importe) as importe from cobranzas co join cobranza_pagos cp on cp.cobranza_id = co.id
        where co.caja_sesion_id = cs.id and co.estado = 'confirmada' and cp.medio = 'efectivo'
      ) cb on true
      left join lateral (
        select sum(m.importe) filter (where m.tipo = 'ingreso') as ingresos,
          sum(m.importe) filter (where m.tipo = 'egreso' and ${CLASE_MOV} = 'pago_proveedor') as proveedor,
          sum(m.importe) filter (where m.tipo = 'egreso' and ${CLASE_MOV} = 'devolucion') as devoluciones,
          sum(m.importe) filter (where m.tipo = 'egreso' and ${CLASE_MOV} in ('concepto', 'otro')) as otros
        from caja_movimientos m left join proveedor_pagos pp on pp.caja_movimiento_id = m.id
        where m.caja_sesion_id = cs.id and m.anulado_en is null
      ) mv on true
      left join cashflow_sobres s on s.caja_sesion_id = cs.id and s.anulado_en is null
      where cs.estado = 'cerrada' and ${cierreEnMes} ${sucTurno}
      order by cs.cierre`),
    /* Qué fueron los otros ingresos y los egresos, agrupados (el detalle de los renglones). */
    db.execute(sql`
      select m.tipo, ${CLASE_MOV} as clase,
        case when m.concepto_id is not null then co.nombre when pp.id is not null then coalesce(pr.nombre, 'Proveedor')
          when m.motivo like 'Devolución %' then 'Devoluciones a clientes' else nullif(trim(m.motivo), '') end as nombre,
        sum(m.importe) as importe, count(*)::int as cantidad
      from caja_movimientos m
      join caja_sesiones cs on cs.id = m.caja_sesion_id
      left join proveedor_pagos pp on pp.caja_movimiento_id = m.id
      left join proveedores pr on pr.id = pp.proveedor_id
      left join cashflow_conceptos co on co.id = m.concepto_id
      where m.anulado_en is null and cs.estado = 'cerrada' and ${cierreEnMes} ${sucTurno}
      group by 1, 2, 3 order by 4 desc`),
    /* El puente con Métricas: mismo criterio que «Cómo se cobra» (confirmadas y esperando CAE, día argentino de la venta). */
    db.execute(sql`
      with t as (select cs.id from caja_sesiones cs where cs.estado = 'cerrada' and ${cierreEnMes}),
      p as (
        select v.estado, v.caja_sesion_id, (v.caja_sesion_id in (select id from t)) as en_turnos,
          ${enRango('v.fecha', desde, hasta)} as en_mes, vp.importe
        from ventas v join venta_pagos vp on vp.venta_id = v.id
        where vp.medio = 'efectivo' and v.estado in ('confirmada', 'pendiente_cae') ${sucVenta}
          and (${enRango('v.fecha', desde, hasta)} or v.caja_sesion_id in (select id from t))
      )
      select
        coalesce(sum(importe) filter (where en_mes), 0) as metricas,
        coalesce(sum(importe) filter (where en_mes and estado = 'confirmada' and caja_sesion_id is not null and not en_turnos), 0) as "otrosTurnos",
        coalesce(sum(importe) filter (where en_mes and estado = 'confirmada' and caja_sesion_id is null), 0) as "sinCaja",
        coalesce(sum(importe) filter (where en_mes and estado = 'pendiente_cae'), 0) as "esperandoCae",
        coalesce(sum(importe) filter (where not en_mes and estado = 'confirmada' and en_turnos), 0) as "deOtroMes"
      from p`),
    /* Recibos en efectivo sin caja (caja no obligatoria, sin turno abierto): esa plata no entra en ningún sobre. */
    db.execute(sql`
      select coalesce(sum(cp.importe), 0) as importe from cobranzas co join cobranza_pagos cp on cp.cobranza_id = co.id
      where co.caja_sesion_id is null and co.estado = 'confirmada' and cp.medio = 'efectivo'
        and ${enRango('co.fecha', desde, hasta)} ${sucCobranza}`),
  ]);
  const n = (v: unknown) => Number(v) || 0;
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  const lista: TurnoConc[] = filas(turnos).map((x: any) => ({
    id: Number(x.id), sucursalId: Number(x.sucursalId), sucursal: x.sucursal, cajero: x.cajero,
    apertura: iso(x.apertura), cierre: iso(x.cierre), cierreDia: x.cierreDia,
    fondoInicial: n(x.fondoInicial), ventas: n(x.ventas), cobranzas: n(x.cobranzas), ingresos: n(x.ingresos),
    pagosProveedor: n(x.pagosProveedor), devoluciones: n(x.devoluciones), otrosEgresos: n(x.otrosEgresos),
    esperado: n(x.esperado), contado: n(x.contado), difCajero: n(x.difCajero),
    envio: x.envio == null ? null : n(x.envio), fondoQueda: x.fondoQueda == null ? null : n(x.fondoQueda),
    fondoAnterior: x.fondoAnterior == null ? null : n(x.fondoAnterior),
    sobreId: x.sobreId == null ? null : Number(x.sobreId),
    sobreEnviado: x.sobreEnviado == null ? null : n(x.sobreEnviado),
    sobreContado: x.sobreContado == null ? null : n(x.sobreContado),
    sobreDif: x.sobreDif == null ? null : n(x.sobreDif),
    descartado: !!x.descartado,
  }));
  const v: any = filas(ventas)[0] ?? {};
  const ventasMes: VentasMes = {
    metricas: n(v.metricas), otrosTurnos: n(v.otrosTurnos), sinCaja: n(v.sinCaja), esperandoCae: n(v.esperandoCae), deOtroMes: n(v.deOtroMes),
  };
  const detalleMov = filas(detalle).map((x: any) => ({
    tipo: x.tipo as 'ingreso' | 'egreso', clase: x.clase as string, nombre: x.nombre ?? 'Sin motivo',
    importe: Math.round(n(x.importe) * 100) / 100, cantidad: Number(x.cantidad) || 0,
  }));
  /** Efectivo del mes que no pasó por ninguna caja: ventas (también en el puente) y recibos. */
  const sinCaja = { ventas: ventasMes.sinCaja, cobranzas: n(filas(cobranzasSueltas)[0]?.importe) };
  return { turnos: lista, ventasMes, detalleMov, sinCaja };
}
