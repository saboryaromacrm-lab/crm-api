/**
 * GERENCIA › VISTA PROFESIONAL › «¿DÓNDE ESTÁ MI PLATA?» (26/11/2026)
 * ============================================================================
 * Pedido del dueño: «dónde estoy parado, dónde está mi dinero, tanto físico
 * como digital, porque siento que me falta dinero… todo lo que me ingresa
 * menos todo lo que pago… que no me mienta». Las reglas de qué es cada peso
 * están en `plata.ts`; acá se juntan los números, cada uno con la MISMA cuenta
 * de su pantalla de origen:
 *
 *   caja central      = el libro del Cash Flow (ingresos − egresos vigentes).
 *   sobres en camino  = cierres por envío que nadie controló (igual que el Cash Flow).
 *   cajas abiertas    = `CajaService.arqueo(id).esperadoEfectivo`, lo del cierre.
 *   cuentas propias   = el ÚLTIMO SALDO QUE CARGÓ EL DUEÑO + lo que entró (solo
 *                       la de Mercado Pago: los cobros liberados que baja la
 *                       conciliación) − lo pagado desde esa cuenta. El ERP NO
 *                       sabe el saldo de un banco: si no se cargó, no se inventa.
 *   te deben          = lo que falta cobrar de las ventas en cuenta corriente.
 *   debés             = el saldo de los proveedores (estado de cuenta) + los
 *                       gastos impagos que no están en esa vitrina + los echeqs
 *                       a terceros por debitar.
 *
 * Solo el dueño (`gerencia.cashflow`): muestra la caja central.
 */
import { BadRequestException, Body, Controller, Get, Inject, Injectable, Module, NotFoundException, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';
import { sql } from 'drizzle-orm';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { DRIZZLE, Database } from '../db/drizzle';
import { hoyAr } from '../cafeteria/cuenta';
import { CajaModule, CajaService } from '../caja/caja.module';
import { FinanzasProveedorModule, FinanzasProveedorService } from '../proveedores/finanzas.module';
import { PERMISO_CASHFLOW } from '../cashflow/a-controlar';
import {
  ORDEN_ENTRADA, ORDEN_SALIDA, TEXTO_ENTRADA, TEXTO_MEDIO, TEXTO_SALIDA, agrupar, claseConcepto, deDondeSalio, esDia,
  estimarSaldo, grupoCobro, grupoDelPago, r2, suma, sumarFugas, esPagoEnEfectivo, cuadrarEfectivo,
} from './plata';

const ZONA = 'America/Argentina/Buenos_Aires';
/** Desde cuándo se bajan los cobros de Mercado Pago (conciliacion.service.ts). */
const ARRANQUE_MP = '2026-11-01';
const N = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const filas = (r: any): any[] => r?.rows ?? r ?? [];
const desde = (col: string, dia: string) => sql.raw(`${col} >= ('${dia}'::date::timestamp at time zone '${ZONA}')`);
const hasta = (col: string, dia: string) => sql.raw(`${col} < (('${dia}'::date + 1)::timestamp at time zone '${ZONA}')`);
const primeroDelMes = (dia: string) => `${dia.slice(0, 8)}01`;

/**
 * LOS PAGOS como renglones de plata: una fila por parte (pago mixto) o por
 * pago. Afuera lo que no es plata del negocio: el espejo de lo que un cliente
 * transfirió a la cuenta disponible de un proveedor (no el pago propio a esa
 * cuenta, que sí salió), el de la transferencia directa de un cliente y lo que
 * pagó Coffit.
 */
const PAGOS = sql.raw(`
  select pp.id, pp.destino::text as destino, coalesce(pf.medio, pp.medio)::text as medio,
         coalesce(pf.importe, pp.importe) as importe, coalesce(pf.fecha, pp.fecha) as fecha,
         coalesce(pf.cuenta_propia_id, pp.cuenta_propia_id) as cuenta_id, pp.cambio_por, pp.caja_sesion_id, pp.creado_en,
         exists (select 1 from cashflow_movimientos m where m.pago_id = pp.id and m.anulado_en is null) as de_cf
    from proveedor_pagos pp left join pago_formas pf on pf.pago_id = pp.id
   where pp.estado = 'activo' and pp.venta_pago_id is null
     and not exists (select 1 from cuenta_disponible_pagos cdp where cdp.proveedor_pago_id = pp.id and cdp.propio is not true)
     and coalesce(pf.medio, pp.medio)::text <> 'pago_coffit'`);

export class SaldoCuentaDto {
  @IsInt() cuentaPropiaId!: number;
  @IsNumber() saldo!: number;
  @IsOptional() @IsString() @MaxLength(300) nota?: string;
  /** Marca esta cuenta como la de Mercado Pago conectada al ERP (una sola). */
  @IsOptional() @IsBoolean() esMercadoPago?: boolean;
  @IsBoolean() confirmado!: boolean;
}
export class AnularSaldoDto {
  @IsString() @MaxLength(300) motivo!: string;
}

@Injectable()
export class PlataService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly cajas: CajaService,
    private readonly finanzas: FinanzasProveedorService,
  ) {}

  async ver(q: { desde?: string; hasta?: string }) {
    const hoy = hoyAr();
    const d = esDia(q.desde) ? q.desde : primeroDelMes(hoy);
    const h = esDia(q.hasta) ? q.hasta : hoy;
    if (d > h) throw new BadRequestException('«Desde» no puede ser después de «hasta».');
    const [efectivo, cuentas, mp, teDeben, debes, periodo] = await Promise.all([
      this.efectivo(), this.cuentas(), this.mercadoPago(), this.teDeben(), this.debes(), this.periodo(d, h),
    ]);
    const enCuentas = cuentas.reduce((a, c) => a + (c.estimado ?? 0), 0);
    const sinSaldo = cuentas.filter((c) => c.estimado == null).map((c) => c.nombre);
    const tenes = r2(efectivo.total + enCuentas + (mp.conectada ? mp.aLiberar : 0));
    const debesTotal = r2(debes.proveedores + debes.gastosSinVitrina + debes.echeqsTerceros.total);
    const avisos: string[] = [];
    if (!efectivo.central.arranco) avisos.push('El Cash Flow no arrancó: la caja central no está en la cuenta.');
    if (sinSaldo.length) avisos.push(`Sin saldo cargado: ${sinSaldo.join(', ')}. Hasta que lo cargues, esa plata no está en «Tenés».`);
    if (periodo.comisionesCargadas > 0.009 && periodo.mp) {
      avisos.push(`Hay gastos con rubro «comisiones» pagados en el período (${periodo.comisionesCargadas.toLocaleString('es-AR')}): si son de Mercado Pago, se cuentan dos veces con las comisiones que trae MP.`);
    }
    return {
      hoy, ahora: new Date().toISOString(),
      foto: {
        efectivo, cuentas, mp, teDeben, debes,
        tenes, enCuentas: r2(enCuentas), debesTotal,
        posicion: r2(tenes + teDeben.clientes - debesTotal),
        completa: efectivo.central.arranco && !sinSaldo.length,
      },
      periodo,
      avisos,
    };
  }

  /* ------------------------------ El efectivo ------------------------------ */

  private async efectivo() {
    const [caja] = filas(await this.db.execute(sql`select fecha_inicio::text as "fechaInicio" from cashflow_caja limit 1`));
    const [saldo] = filas(await this.db.execute(sql`
      select coalesce(sum(case when tipo = 'ingreso' then importe else -importe end), 0) as s
        from cashflow_movimientos where anulado_en is null`));
    const [conteo] = filas(await this.db.execute(sql`
      select fecha, contado, diferencia from cashflow_conteos order by fecha desc limit 1`));
    const transito = caja ? filas(await this.db.execute(sql`
      select count(*)::int as n, coalesce(sum(cs.envio_efectivo), 0) as total
        from caja_sesiones cs
       where cs.estado = 'cerrada' and cs.envio_efectivo > 0 and ${desde('cs.cierre', caja.fechaInicio)}
         and not exists (select 1 from cashflow_sobres s where s.caja_sesion_id = cs.id and s.anulado_en is null)`))[0] : null;
    const abiertas = filas(await this.db.execute(sql`
      select cs.id, cs.apertura, su.nombre as sucursal, cs.cerrar_hasta::text as "cerrarHasta",
             (select json_build_object('fecha', cc.fecha, 'contado', cc.contado_efectivo, 'arqueoDia', cc.arqueo_dia)
                from caja_controles cc where cc.caja_sesion_id = cs.id and not cc.apertura order by cc.fecha desc limit 1) as "ultimoConteo"
        from caja_sesiones cs join sucursales su on su.id = cs.sucursal_id
       where cs.estado = 'abierta' order by su.nombre`));
    const arqueos = await Promise.all(abiertas.map((c) => this.cajas.arqueo(c.id).catch(() => null)));
    const cajas = abiertas.map((c, i) => ({
      id: c.id, sucursal: c.sucursal, apertura: c.apertura, cerrarHasta: c.cerrarHasta,
      esperado: r2(N(arqueos[i]?.esperadoEfectivo)), sinDato: !arqueos[i],
      ultimoConteo: c.ultimoConteo ? { fecha: c.ultimoConteo.fecha, contado: r2(N(c.ultimoConteo.contado)), arqueoDia: !!c.ultimoConteo.arqueoDia } : null,
    }));
    const central = {
      arranco: !!caja, desde: caja?.fechaInicio ?? null, saldo: caja ? r2(N(saldo?.s)) : 0,
      ultimoConteo: conteo ? { fecha: conteo.fecha, contado: r2(N(conteo.contado)), diferencia: r2(N(conteo.diferencia)) } : null,
    };
    const enCajas = r2(cajas.reduce((a, c) => a + c.esperado, 0));
    const enTransito = { sobres: N(transito?.n), total: r2(N(transito?.total)) };
    return { central, transito: enTransito, cajas, enCajas, total: r2(central.saldo + enTransito.total + enCajas) };
  }

  /* --------------------------- Las cuentas propias --------------------------- */

  /** Lo que el ERP sabe que entró y salió de una cuenta DESPUÉS de un instante. */
  private async movimientosDesde(cuentaId: number, nombre: string, detalle: string, esMp: boolean, instante: Date) {
    const iso = instante.toISOString();
    /* Un pago cuenta después del saldo si es de un día posterior, o del mismo día y se cargó después. */
    const [sal] = filas(await this.db.execute(sql`
      with f as (${PAGOS})
      select coalesce(sum(importe), 0) as s, count(*)::int as n from f
       where cuenta_id = ${cuentaId} and medio = 'transferencia' and cambio_por is null
         and ((fecha at time zone ${ZONA})::date > (${iso}::timestamptz at time zone ${ZONA})::date
              or ((fecha at time zone ${ZONA})::date = (${iso}::timestamptz at time zone ${ZONA})::date and creado_en > ${iso}::timestamptz))`));
    /* El efectivo del Cash Flow que alguien transfirió a esta cuenta («Cambio a mi cuenta»): por el nombre escrito. */
    const [cambio] = filas(await this.db.execute(sql`
      select coalesce(sum(importe), 0) as s from cashflow_movimientos
       where anulado_en is null and tipo = 'egreso' and fecha > ${iso}::timestamptz and coalesce(cambio_cuenta, '') <> ''
         and (lower(trim(cambio_cuenta)) = lower(${nombre}) or (${detalle} <> '' and lower(trim(cambio_cuenta)) = lower(${detalle})))`));
    let cobrado = 0;
    if (esMp) {
      const [c] = filas(await this.db.execute(sql`
        select coalesce(sum(neto), 0) as s from mp_movimientos
         where estado = 'approved' and coalesce(liberacion, fecha) > ${iso}::timestamptz and coalesce(liberacion, fecha) <= now()`));
      cobrado = N(c?.s);
    }
    return { entro: r2(cobrado + N(cambio?.s)), cobradoMp: r2(cobrado), cambioEfectivo: r2(N(cambio?.s)), salio: r2(N(sal?.s)), pagos: N(sal?.n) };
  }

  private async cuentas() {
    const cs = filas(await this.db.execute(sql`
      select id, nombre, detalle, es_mercado_pago as "esMp" from cuentas_propias where activa order by es_mercado_pago desc, nombre`));
    return Promise.all(cs.map(async (c) => {
      const hist = filas(await this.db.execute(sql`
        select s.id, s.fecha, s.saldo, s.estimado, s.diferencia, s.nota, coalesce(u.nombre, '') as quien
          from cuenta_saldos s left join usuarios u on u.id = s.usuario_id
         where s.cuenta_propia_id = ${c.id} and s.anulado_en is null order by s.fecha desc, s.id desc limit 8`))
        .map((x) => ({ id: x.id, fecha: x.fecha, saldo: r2(N(x.saldo)), estimado: x.estimado == null ? null : r2(N(x.estimado)), diferencia: x.diferencia == null ? null : r2(N(x.diferencia)), nota: x.nota, quien: x.quien }));
      const ultimo = hist[0] ?? null;
      const desdeUltimo = ultimo ? await this.movimientosDesde(c.id, c.nombre, c.detalle, c.esMp, new Date(ultimo.fecha)) : null;
      return {
        id: c.id, nombre: c.nombre, detalle: c.detalle, esMercadoPago: !!c.esMp,
        ultimo, desdeUltimo,
        estimado: ultimo && desdeUltimo ? estimarSaldo(ultimo.saldo, desdeUltimo.entro, desdeUltimo.salio) : null,
        historial: hist,
      };
    }));
  }

  /** Lo que Mercado Pago ya cobró y todavía no liberó (de la cuenta conectada). */
  private async mercadoPago() {
    const [cta] = filas(await this.db.execute(sql`select id, nombre from cuentas_propias where es_mercado_pago and activa limit 1`));
    const [a] = filas(await this.db.execute(sql`
      select coalesce(sum(neto), 0) as s, count(*)::int as n, min(liberacion) as proxima from mp_movimientos
       where estado = 'approved' and liberacion > now()`));
    const dias = filas(await this.db.execute(sql`
      select (liberacion at time zone ${ZONA})::date::text as dia, sum(neto) as neto from mp_movimientos
       where estado = 'approved' and liberacion > now() group by 1 order by 1 limit 10`));
    return {
      conectada: !!cta, cuenta: cta?.nombre ?? null, desde: ARRANQUE_MP,
      aLiberar: r2(N(a?.s)), cobros: N(a?.n), proxima: a?.proxima ?? null,
      porDia: dias.map((x) => ({ dia: x.dia, neto: r2(N(x.neto)) })),
    };
  }

  /* --------------------------- Lo que te deben / debés --------------------------- */

  private async teDeben() {
    const [c] = filas(await this.db.execute(sql`
      select coalesce(sum(greatest(0, v.total
        - coalesce((select sum(ci.importe) from cobranza_imputaciones ci join cobranzas co on co.id = ci.cobranza_id
                    where ci.venta_id = v.id and co.estado = 'confirmada'), 0)
        - coalesce((select sum(n.total) from ventas n where n.ref_venta_id = v.id and n.estado = 'confirmada'
                    and n.condicion_pago = 'cuenta_corriente' and n.tipo::text like 'nota_credito%'), 0))), 0) as saldo
      from ventas v
      where v.estado = 'confirmada' and v.condicion_pago = 'cuenta_corriente' and v.tipo::text not like 'nota_credito%'`));
    return { clientes: r2(N(c?.saldo)) };
  }

  private async debes() {
    const edoc: any[] = (await this.finanzas.edocGlobal().catch(() => null)) ?? [];
    const enVitrina = edoc.map((f) => Number(f.id)).filter((x) => x > 0);
    const proveedores = r2(edoc.reduce((a, f) => a + Math.max(0, N(f.saldo)), 0));
    const aFavor = r2(edoc.reduce((a, f) => a + Math.max(0, -N(f.saldo)), 0));
    const deudores = edoc.filter((f) => N(f.saldo) > 0.009).sort((a, b) => N(b.saldo) - N(a.saldo))
      .slice(0, 8).map((f) => ({ nombre: f.nombre, saldo: r2(N(f.saldo)), estado: f.estado }));
    /* Los gastos impagos que la vitrina de proveedores no muestra (sin proveedor, o de uno que solo factura gastos). */
    const lista = enVitrina.length ? sql.join(enVitrina.map((x) => sql`${x}`), sql`, `) : sql`0`;
    const [g] = filas(await this.db.execute(sql`
      select coalesce(sum(greatest(0, total - pagado)), 0) as s, count(*) filter (where total - pagado > 0.009)::int as n
        from gastos where estado <> 'anulado' and (proveedor_id is null or proveedor_id not in (${lista}))`));
    const [e] = filas(await this.db.execute(sql`
      select coalesce(sum(importe) filter (where proveedor_id is null), 0) as terceros,
             count(*) filter (where proveedor_id is null)::int as "nTerceros",
             coalesce(sum(importe), 0) as total, count(*)::int as n, min(fecha_venc) as proximo
        from proveedor_echeqs where estado in ('emitido', 'entregado')`));
    return {
      proveedores, aFavor, deudores,
      gastosSinVitrina: r2(N(g?.s)), gastosSinVitrinaN: N(g?.n),
      echeqs: { total: r2(N(e?.total)), cantidad: N(e?.n), proximo: e?.proximo ?? null },
      echeqsTerceros: { total: r2(N(e?.terceros)), cantidad: N(e?.nTerceros) },
    };
  }

  /* ------------------------- El período: entró y salió ------------------------- */

  private async periodo(d: string, h: string) {
    const [ventas, cobranzas, cfMovs, cajaMovs, pagos, mpCom, cierres, sobres] = await Promise.all([
      this.db.execute(sql`
        select vp.medio::text as medio, v.caja_sesion_id is not null as "conCaja",
               sum(vp.importe * case when v.tipo::text like 'nota_credito%' then -1 else 1 end) as importe
          from venta_pagos vp join ventas v on v.id = vp.venta_id
         where v.estado in ('confirmada', 'pendiente_cae') and ${desde('v.fecha', d)} and ${hasta('v.fecha', h)}
         group by 1, 2`),
      this.db.execute(sql`
        select cp.medio::text as medio, c.caja_sesion_id is not null as "conCaja", sum(cp.importe) as importe
          from cobranza_pagos cp join cobranzas c on c.id = cp.cobranza_id
         where c.estado = 'confirmada' and ${desde('c.fecha', d)} and ${hasta('c.fecha', h)}
         group by 1, 2`),
      /* Cash Flow: lo cargado a mano y los ajustes de conteo (los sobres son plata que ya entró por la caja). */
      this.db.execute(sql`
        select m.tipo, m.origen, coalesce(c.nombre, '') as concepto, sum(m.importe) as importe, count(*)::int as n
          from cashflow_movimientos m left join cashflow_conceptos c on c.id = m.concepto_id
         where m.anulado_en is null and m.origen in ('concepto', 'conteo') and m.pago_id is null and m.gasto_id is null and ${desde('m.fecha', d)} and ${hasta('m.fecha', h)}
         group by 1, 2, 3`),
      /* La caja de los locales: lo que NO es un pago (esos se cuentan en los pagos, una sola vez). */
      this.db.execute(sql`
        select cm.tipo::text as tipo, coalesce(c.nombre, '') as concepto,
               case when cm.concepto_id is null and cm.motivo like 'Devolución %' then 'devolucion' else '' end as clase,
               case when cm.concepto_id is null then left(cm.motivo, 60) else '' end as motivo,
               sum(cm.importe) as importe
          from caja_movimientos cm left join cashflow_conceptos c on c.id = cm.concepto_id
         where cm.anulado_en is null and ${desde('cm.fecha', d)} and ${hasta('cm.fecha', h)}
           and not exists (select 1 from proveedor_pagos pp where pp.caja_movimiento_id = cm.id and pp.estado = 'activo')
         group by 1, 2, 3, 4`),
      this.db.execute(sql`
        with f as (${PAGOS})
        select f.destino, f.medio, f.caja_sesion_id is not null as "deCaja", f.cambio_por is not null as cambio, f.de_cf as "deCf",
               cu.nombre as cuenta,
               (select gc.resultado from proveedor_imputaciones pi join gastos g on g.id = pi.gasto_id
                  join gasto_categorias gc on gc.id = g.categoria_id
                 where pi.pago_id = f.id order by pi.importe desc limit 1) as resultado,
               (select gc.nombre from proveedor_imputaciones pi join gastos g on g.id = pi.gasto_id
                  join gasto_categorias gc on gc.id = g.categoria_id
                 where pi.pago_id = f.id order by pi.importe desc limit 1) as categoria,
               sum(f.importe) as importe
          from f left join cuentas_propias cu on cu.id = f.cuenta_id
         where ${desde('f.fecha', d)} and ${hasta('f.fecha', h)}
         group by 1, 2, 3, 4, 5, 6, 7, 8`),
      this.db.execute(sql`
        select familia, coalesce(sum(bruto), 0) as bruto, coalesce(sum(bruto - neto), 0) as comision, count(*)::int as n
          from mp_movimientos where estado = 'approved' and ${desde('fecha', d)} and ${hasta('fecha', h)}
         group by 1`),
      this.db.execute(sql`
        select cs.id, su.nombre as sucursal, cs.cierre, cs.diferencia, coalesce(u.nombre, '') as cajero
          from caja_sesiones cs join sucursales su on su.id = cs.sucursal_id left join usuarios u on u.id = cs.cerrado_por
         where cs.estado = 'cerrada' and ${desde('cs.cierre', d)} and ${hasta('cs.cierre', h)} and abs(cs.diferencia) > 0.009`),
      this.db.execute(sql`
        select s.caja_sesion_id as "cajaSesionId", su.nombre as sucursal, s.controlado_en as fecha, s.diferencia, s.descartado, s.enviado
          from cashflow_sobres s join caja_sesiones cs on cs.id = s.caja_sesion_id join sucursales su on su.id = cs.sucursal_id
         where s.anulado_en is null and ${desde('s.controlado_en', d)} and ${hasta('s.controlado_en', h)}
           and (s.descartado or abs(s.diferencia) > 0.009)`),
    ]);

    const entradas: { grupo: string; texto: string; importe: number }[] = [];
    const salidas: { grupo: string; texto: string; importe: number }[] = [];
    const neutros: { grupo: string; texto: string; importe: number }[] = [];
    let directoProveedores = 0;
    /* El efectivo que pasó por las cajas del sistema (para el cuadre) y el que no pasó por ninguna. */
    const ef = { entro: 0, salio: 0, aCuentas: 0, cobrosSinCaja: 0, pagosSinCaja: 0 };

    for (const v of filas(ventas)) {
      const g = grupoCobro(v.medio);
      if (v.medio === 'transferencia_proveedor') directoProveedores += N(v.importe);
      if (!g) continue;
      entradas.push({ grupo: g, texto: `Ventas · ${TEXTO_MEDIO[v.medio] ?? v.medio}`, importe: N(v.importe) });
      if (v.medio === 'efectivo') { if (v.conCaja) ef.entro += N(v.importe); else ef.cobrosSinCaja += N(v.importe); }
    }
    for (const c of filas(cobranzas)) {
      if (c.medio === 'transferencia_proveedor') { directoProveedores += N(c.importe); continue; }
      if (!grupoCobro(c.medio)) continue;
      entradas.push({ grupo: 'cobranzas', texto: TEXTO_MEDIO[c.medio] ?? c.medio, importe: N(c.importe) });
      if (c.medio === 'efectivo') { if (c.conCaja) ef.entro += N(c.importe); else ef.cobrosSinCaja += N(c.importe); }
    }
    if (directoProveedores > 0.009) neutros.push({ grupo: 'directo', texto: 'Clientes que le pagaron directo a tus proveedores', importe: directoProveedores });

    const fugasConteo = { faltantes: 0, sobrantes: 0 };
    for (const m of filas(cfMovs)) {
      const v = N(m.importe);
      if (m.origen === 'conteo') {
        if (m.tipo === 'ingreso') fugasConteo.sobrantes += v; else fugasConteo.faltantes -= v;
        continue;
      }
      const nombre = m.concepto || 'Sin concepto';
      if (m.tipo === 'ingreso') { entradas.push({ grupo: 'ingresos', texto: `Caja central · ${nombre}`, importe: v }); ef.entro += v; continue; }
      const cl = claseConcepto(nombre);
      if (cl === 'interno') ef.aCuentas += v; else ef.salio += v;
      if (cl === 'interno') neutros.push({ grupo: 'interno', texto: `${nombre} (de la caja central)`, importe: v });
      else if (cl === 'retiro') salidas.push({ grupo: 'retiros', texto: `Caja central · ${nombre}`, importe: v });
      else if (cl === 'sueldos') salidas.push({ grupo: 'sueldos', texto: `Caja central · ${nombre}`, importe: v });
      else salidas.push({ grupo: 'otros', texto: `Caja central · ${nombre}`, importe: v });
    }
    for (const m of filas(cajaMovs)) {
      const v = N(m.importe);
      const nombre = m.concepto || m.motivo || 'Sin concepto';
      if (m.tipo === 'ingreso') { entradas.push({ grupo: 'ingresos', texto: `Cajas de los locales · ${nombre}`, importe: v }); ef.entro += v; continue; }
      if (m.clase === 'devolucion') { salidas.push({ grupo: 'devoluciones', texto: 'Devoluciones desde la caja', importe: v }); ef.salio += v; continue; }
      const cl = claseConcepto(nombre);
      if (cl === 'interno') ef.aCuentas += v; else ef.salio += v;
      if (cl === 'interno') neutros.push({ grupo: 'interno', texto: `${nombre} (de la caja de un local)`, importe: v });
      else if (cl === 'retiro') salidas.push({ grupo: 'retiros', texto: `Cajas de los locales · ${nombre}`, importe: v });
      else if (cl === 'sueldos') salidas.push({ grupo: 'sueldos', texto: `Cajas de los locales · ${nombre}`, importe: v });
      else salidas.push({ grupo: 'otros', texto: `Cajas de los locales · ${nombre}`, importe: v });
    }

    let comisionesCargadas = 0;
    const deDonde: { texto: string; importe: number }[] = [];
    for (const p of filas(pagos)) {
      const v = N(p.importe);
      const g = grupoDelPago(p.destino, p.resultado);
      if (p.resultado === 'comisiones') comisionesCargadas += v;
      const origen = deDondeSalio({ medio: p.medio, cajaSesionId: p.deCaja ? 1 : null, deCf: !!p.deCf, cambioPor: p.cambio ? 'x' : null, cuenta: p.cuenta });
      if (esPagoEnEfectivo(p.medio, !!p.cambio)) { if (p.deCaja || p.deCf) ef.salio += v; else ef.pagosSinCaja += v; }
      const que = g === 'mercaderia' ? origen : `${p.categoria || (p.destino === 'gastos' ? 'Sin imputar a un gasto' : 'Mercadería')} · ${origen}`;
      salidas.push({ grupo: g, texto: que, importe: v });
      deDonde.push({ texto: origen, importe: v });
    }

    /* Mercado Pago (desde que se bajan los cobros): lo que se quedó de comisiones y retenciones, y el control contra el ERP. */
    const mpFilas = filas(mpCom);
    const enMp = h >= ARRANQUE_MP;
    if (enMp) {
      for (const x of mpFilas) salidas.push({ grupo: 'comisiones_mp', texto: `Sobre cobros con ${x.familia === 'qr' ? 'QR' : x.familia === 'tarjeta' ? 'tarjeta' : 'transferencia'}`, importe: N(x.comision) });
    }

    const entro = agrupar(entradas, TEXTO_ENTRADA, ORDEN_ENTRADA);
    const salio = agrupar(salidas, TEXTO_SALIDA as Record<string, string>, ORDEN_SALIDA);
    const totalEntro = suma(entro);
    const totalSalio = suma(salio);

    /* Las fugas de efectivo: lo que ya se midió que faltó (o sobró). */
    const cierresF = filas(cierres);
    const sobresF = filas(sobres);
    const fCierres = { faltantes: r2(cierresF.reduce((a, c) => a + Math.min(0, N(c.diferencia)), 0)), sobrantes: r2(cierresF.reduce((a, c) => a + Math.max(0, N(c.diferencia)), 0)) };
    const vivos = sobresF.filter((s) => !s.descartado);
    const fSobres = { faltantes: r2(vivos.reduce((a, s) => a + Math.min(0, N(s.diferencia)), 0)), sobrantes: r2(vivos.reduce((a, s) => a + Math.max(0, N(s.diferencia)), 0)) };
    const descartados = sobresF.filter((s) => s.descartado);
    const fugas = {
      ...sumarFugas([fCierres, fSobres, fugasConteo]),
      cierres: { ...fCierres, peores: cierresF.sort((a, b) => Math.abs(N(b.diferencia)) - Math.abs(N(a.diferencia))).slice(0, 6)
        .map((c) => ({ id: c.id, sucursal: c.sucursal, fecha: c.cierre, cajero: c.cajero, diferencia: r2(N(c.diferencia)) })), n: cierresF.length },
      sobres: { ...fSobres, n: vivos.length },
      conteos: { faltantes: r2(fugasConteo.faltantes), sobrantes: r2(fugasConteo.sobrantes) },
      descartados: { total: r2(descartados.reduce((a, s) => a + N(s.enviado), 0)), n: descartados.length },
    };

    /* Control contra Mercado Pago: lo cobrado en el ERP con QR/tarjeta debería haber entrado a MP. */
    let mp: any = null;
    if (enMp) {
      const dMp = d < ARRANQUE_MP ? ARRANQUE_MP : d;
      const [erp] = filas(await this.db.execute(sql`
        select coalesce(sum(x.importe) filter (where x.medio in ('qr', 'tarjeta_debito', 'tarjeta_credito')), 0) as "qrTarjeta",
               coalesce(sum(x.importe) filter (where x.medio = 'transferencia'), 0) as transferencia
          from (select vp.medio::text as medio, vp.importe * case when v.tipo::text like 'nota_credito%' then -1 else 1 end as importe
                  from venta_pagos vp join ventas v on v.id = vp.venta_id
                 where v.estado in ('confirmada', 'pendiente_cae') and ${desde('v.fecha', dMp)} and ${hasta('v.fecha', h)}
                union all
                select cp.medio::text, cp.importe from cobranza_pagos cp join cobranzas c on c.id = cp.cobranza_id
                 where c.estado = 'confirmada' and ${desde('c.fecha', dMp)} and ${hasta('c.fecha', h)}) x`));
      const [enM] = filas(await this.db.execute(sql`
        select coalesce(sum(bruto) filter (where familia in ('qr', 'tarjeta')), 0) as "qrTarjeta",
               coalesce(sum(bruto) filter (where familia = 'transferencia'), 0) as transferencia,
               coalesce(sum(bruto - neto), 0) as comision
          from mp_movimientos where estado = 'approved' and ${desde('fecha', dMp)} and ${hasta('fecha', h)}`));
      mp = {
        desde: dMp, hasta: h, recortado: d < ARRANQUE_MP,
        qrTarjeta: { erp: r2(N(erp?.qrTarjeta)), mp: r2(N(enM?.qrTarjeta)), diferencia: r2(N(enM?.qrTarjeta) - N(erp?.qrTarjeta)) },
        transferencia: { erp: r2(N(erp?.transferencia)), mp: r2(N(enM?.transferencia)), diferencia: r2(N(enM?.transferencia) - N(erp?.transferencia)) },
        comision: r2(N(enM?.comision)),
      };
    }

    const quedo = r2(totalEntro - totalSalio);
    const cuadre: any = await this.cuadre(d, h, ef, fugas);
    /* Lo que quedó de verdad: «entró − salió» menos las diferencias de efectivo ya medidas. */
    const medidas = cuadre.posible ? cuadre.diferencias.total : r2(fugas.neto - fugas.descartados.total);
    /* Lo que tendría que haber sumado a tus cuentas: lo cobrado que no es efectivo + el efectivo depositado − lo pagado desde ellas. */
    const efectivoEntro = r2(ef.entro + ef.cobrosSinCaja);
    const efectivoSalio = r2(ef.salio + ef.pagosSinCaja);
    const digital = {
      entro: r2(totalEntro - efectivoEntro),
      depositado: r2(ef.aCuentas),
      salio: r2(totalSalio - efectivoSalio),
    };
    return {
      desde: d, hasta: h,
      entro, salio, totalEntro, totalSalio, quedo,
      diferenciasMedidas: medidas,
      quedoDeVerdad: r2(quedo + medidas),
      enEfectivo: r2(efectivoEntro - efectivoSalio - ef.aCuentas + medidas),
      enLoDigital: r2(digital.entro + digital.depositado - digital.salio),
      digital,
      neutros: agrupar(neutros, { directo: 'Pasó directo a tus proveedores', interno: 'Movimientos entre tus cajas y cuentas' }, ['directo', 'interno']),
      porOrigen: agrupar(deDonde.map((x) => ({ grupo: 'origen', ...x })), { origen: 'Pagos por de dónde salieron' }, ['origen'])[0]?.detalle ?? [],
      fugas, mp, comisionesCargadas: r2(comisionesCargadas), cuadre,
    };
  }

  /**
   * EL EFECTIVO EN UN INSTANTE, armado con la misma regla en las dos puntas:
   * la caja central (el libro hasta ese momento), los sobres cerrados que
   * todavía nadie había controlado, lo que tenía cada caja abierta (fondo +
   * efectivo cobrado + ingresos − egresos) y el fondo que quedó guardado en el
   * cajón de los locales que estaban cerrados.
   */
  private async efectivoEn(t: string, fechaInicio: string) {
    const [r] = filas(await this.db.execute(sql`
      select
        (select coalesce(sum(case when tipo = 'ingreso' then importe else -importe end), 0) from cashflow_movimientos
          where anulado_en is null and fecha < ${t}::timestamptz) as central,
        (select coalesce(sum(cs.envio_efectivo), 0) from caja_sesiones cs
          where cs.estado = 'cerrada' and cs.envio_efectivo > 0 and cs.cierre < ${t}::timestamptz and ${desde('cs.cierre', fechaInicio)}
            and not exists (select 1 from cashflow_sobres s where s.caja_sesion_id = cs.id and s.anulado_en is null and s.controlado_en < ${t}::timestamptz)) as transito,
        (select coalesce(sum(cs.monto_inicial
            + coalesce((select sum(vp.importe * case when v.tipo::text like 'nota_credito%' then -1 else 1 end) from venta_pagos vp join ventas v on v.id = vp.venta_id
                         where v.caja_sesion_id = cs.id and v.estado in ('confirmada', 'pendiente_cae') and vp.medio = 'efectivo' and v.fecha < ${t}::timestamptz), 0)
            + coalesce((select sum(cp.importe) from cobranza_pagos cp join cobranzas c on c.id = cp.cobranza_id
                         where c.caja_sesion_id = cs.id and c.estado = 'confirmada' and cp.medio = 'efectivo' and c.fecha < ${t}::timestamptz), 0)
            + coalesce((select sum(case when cm.tipo = 'ingreso' then cm.importe else -cm.importe end) from caja_movimientos cm
                         where cm.caja_sesion_id = cs.id and cm.anulado_en is null and cm.fecha < ${t}::timestamptz), 0)), 0)
          from caja_sesiones cs where cs.apertura < ${t}::timestamptz and (cs.cierre is null or cs.cierre >= ${t}::timestamptz)) as cajas,
        (select coalesce(sum(x.fondo), 0) from (
           select distinct on (cs.sucursal_id) case when cs.cierre is not null and cs.cierre < ${t}::timestamptz then coalesce(cs.fondo_queda, 0) else 0 end as fondo
             from caja_sesiones cs where cs.apertura < ${t}::timestamptz order by cs.sucursal_id, cs.apertura desc, cs.id desc) x) as fondos`));
    const central = r2(N(r?.central)), transito = r2(N(r?.transito)), cajas = r2(N(r?.cajas)), fondos = r2(N(r?.fondos));
    return { central, transito, cajas, fondos, total: r2(central + transito + cajas + fondos) };
  }

  /** El cuadre del efectivo del período (solo desde que arrancó el Cash Flow: antes no hay caja central que mirar). */
  private async cuadre(d: string, h: string, ef: { entro: number; salio: number; aCuentas: number; cobrosSinCaja: number; pagosSinCaja: number }, fugas: any) {
    const [caja] = filas(await this.db.execute(sql`select fecha_inicio::text as "fechaInicio" from cashflow_caja limit 1`));
    if (!caja) return { posible: false, motivo: 'El Cash Flow no arrancó: no hay caja central para cuadrar.' };
    if (d <= caja.fechaInicio) return { posible: false, motivo: `El cuadre del efectivo empieza el día después del arranque del Cash Flow (${caja.fechaInicio}): elegí un período desde ahí.` };
    const [tt] = filas(await this.db.execute(sql`
      select (${d}::date::timestamp at time zone ${ZONA}) as t0,
             least(now(), ((${h}::date + 1)::timestamp at time zone ${ZONA})) as t1`));
    const t0 = new Date(tt.t0).toISOString(), t1 = new Date(tt.t1).toISOString();
    /* Turnos que abrieron con otro monto que el que había quedado guardado: plata que apareció o faltó al abrir. */
    const [ap] = filas(await this.db.execute(sql`
      select coalesce(sum(cs.monto_inicial - coalesce(prev.fondo_queda, cs.monto_inicial)), 0) as dif,
             count(*) filter (where abs(cs.monto_inicial - coalesce(prev.fondo_queda, cs.monto_inicial)) > 0.009)::int as n
        from caja_sesiones cs
        left join lateral (select p.fondo_queda from caja_sesiones p where p.sucursal_id = cs.sucursal_id and (p.apertura, p.id) < (cs.apertura, cs.id)
                            order by p.apertura desc, p.id desc limit 1) prev on true
       where cs.apertura >= ${t0}::timestamptz and cs.apertura < ${t1}::timestamptz`));
    const [inicio, fin] = await Promise.all([this.efectivoEn(t0, caja.fechaInicio), this.efectivoEn(t1, caja.fechaInicio)]);
    const aperturas = r2(N(ap?.dif));
    const total = r2(fugas.neto - fugas.descartados.total + aperturas);
    const c = cuadrarEfectivo({ inicio: inicio.total, fin: fin.total, entro: r2(ef.entro), salio: r2(ef.salio), aCuentas: r2(ef.aCuentas), fugas: total });
    return {
      posible: true, desde: t0, hasta: t1, inicio, fin,
      entro: r2(ef.entro), salio: r2(ef.salio), aCuentas: r2(ef.aCuentas),
      diferencias: {
        cierres: r2(fugas.cierres.faltantes + fugas.cierres.sobrantes), sobres: r2(fugas.sobres.faltantes + fugas.sobres.sobrantes),
        conteos: r2(fugas.conteos.faltantes + fugas.conteos.sobrantes), descartados: r2(-fugas.descartados.total),
        aperturas, aperturasN: N(ap?.n), total,
      },
      ...c,
      fueraDeCaja: { cobros: r2(ef.cobrosSinCaja), pagos: r2(ef.pagosSinCaja) },
    };
  }

  /* --------------------------- Cargar el saldo de una cuenta --------------------------- */

  async cargarSaldo(dto: SaldoCuentaDto, usuarioId: number | null) {
    if (dto.confirmado !== true) throw new BadRequestException('Confirmá el saldo.');
    const saldo = r2(dto.saldo);
    if (!Number.isFinite(saldo)) throw new BadRequestException('El saldo tiene que ser un número.');
    return this.db.transaction(async (tx: any) => {
      const [c] = filas(await tx.execute(sql`select id, nombre, detalle, es_mercado_pago as "esMp", activa from cuentas_propias where id = ${dto.cuentaPropiaId} for update`));
      if (!c || !c.activa) throw new NotFoundException('Esa cuenta no existe o está desactivada.');
      let esMp = !!c.esMp;
      if (dto.esMercadoPago === true && !esMp) {
        await tx.execute(sql`update cuentas_propias set es_mercado_pago = false where es_mercado_pago`);
        await tx.execute(sql`update cuentas_propias set es_mercado_pago = true where id = ${c.id}`);
        esMp = true;
      } else if (dto.esMercadoPago === false && esMp) {
        await tx.execute(sql`update cuentas_propias set es_mercado_pago = false where id = ${c.id}`);
        esMp = false;
      }
      const [prev] = filas(await tx.execute(sql`
        select fecha, saldo from cuenta_saldos where cuenta_propia_id = ${c.id} and anulado_en is null order by fecha desc, id desc limit 1`));
      let estimado: number | null = null;
      if (prev) {
        const m = await this.movimientosDesde(c.id, c.nombre, c.detalle, esMp, new Date(prev.fecha));
        estimado = estimarSaldo(N(prev.saldo), m.entro, m.salio);
      }
      const diferencia = estimado == null ? null : r2(saldo - estimado);
      const [s] = filas(await tx.execute(sql`
        insert into cuenta_saldos (cuenta_propia_id, saldo, estimado, diferencia, nota, usuario_id)
        values (${c.id}, ${saldo}, ${estimado}, ${diferencia}, ${String(dto.nota ?? '').trim().slice(0, 300)}, ${usuarioId})
        returning id, fecha`));
      return { ok: true, id: s.id, fecha: s.fecha, saldo, estimado, diferencia };
    });
  }

  async anularSaldo(id: number, dto: AnularSaldoDto, usuarioId: number | null) {
    const motivo = String(dto.motivo ?? '').trim();
    if (motivo.length < 5) throw new BadRequestException('Escribí por qué lo anulás (por ejemplo: «lo cargué mal»).');
    const r = filas(await this.db.execute(sql`
      update cuenta_saldos set anulado_en = now(), anulado_por = ${usuarioId}, anulado_motivo = ${motivo.slice(0, 300)}
       where id = ${id} and anulado_en is null returning id`));
    if (!r.length) throw new NotFoundException('Ese saldo no existe o ya estaba anulado.');
    return { ok: true };
  }
}

@Controller('gerencia/plata')
@Permiso(PERMISO_CASHFLOW)
export class PlataController {
  constructor(private readonly svc: PlataService) {}

  @Get() ver(@Query('desde') desde?: string, @Query('hasta') hasta?: string) { return this.svc.ver({ desde, hasta }); }

  @Post('saldos') cargar(@Body() dto: SaldoCuentaDto, @Auth() s: Sesion) { return this.svc.cargarSaldo(dto, s?.usuarioId ?? null); }

  @Post('saldos/:id/anular')
  anular(@Param('id', ParseIntPipe) id: number, @Body() dto: AnularSaldoDto, @Auth() s: Sesion) {
    return this.svc.anularSaldo(id, dto, s?.usuarioId ?? null);
  }
}

@Module({
  imports: [CajaModule, FinanzasProveedorModule],
  controllers: [PlataController],
  providers: [PlataService],
})
export class PlataModule {}
