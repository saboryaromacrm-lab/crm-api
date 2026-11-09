/**
 * GERENCIA › VISTA PROFESIONAL (5/11/2026, pedido del dueño: «como experto en
 * finanzas, una súper pantalla didáctica con los datos más relevantes que
 * tiene que ver un negocio, con vista mensual y semanal»).
 * ============================================================================
 * No inventa cuentas nuevas: cada número sale de la MISMA cuenta que su
 * pantalla de origen, así nunca hay dos verdades.
 *
 *   ventas netas   = la de Resultados: renglones − notas de crédito + cargos
 *                    + el IVA de lo vendido sin factura (el recargo por cuotas
 *                    va aparte, es financiero). Por semana o por mes, por local.
 *   costo vendido  = el congelado en cada renglón (el mismo del margen).
 *   resultado      = el de Resultados (solo en la vista mensual: los gastos,
 *                    sueldos e impuestos son de mes; partirlos en semanas
 *                    sería inventar).
 *   stock          = el valorizado de Métricas (a costo de hoy).
 *   proveedores    = el saldo del estado de cuenta de cada uno (lo que les
 *                    debés; los saldos a favor van aparte).
 *   clientes       = lo que falta cobrar de las ventas en cuenta corriente.
 *
 * Los «días» (de stock, de cobro, de pago) se miden contra el ritmo de los
 * últimos 90 días: un mes flojo no los dispara.
 *
 * Llave propia, `gerencia.vista` (9/11/2026): se tilda en el rol aparte de Resultados.
 */
import { BadRequestException, Controller, Get, Inject, Injectable, Module, Query } from '@nestjs/common';
import { Permiso } from '../auth/auth.decoradores';
import { asc } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { sucursales } from '../db/schema';
import { hoyAr, sumarDias } from '../cafeteria/cuenta';
import { CLASE_VENTA } from '../metricas/iva';
import { MetricasModule, MetricasService } from '../metricas/metricas.module';
import { ResultadosModule, ResultadosService } from '../resultados/resultados.module';
import { FinanzasProveedorModule, FinanzasProveedorService } from '../proveedores/finanzas.module';

const ZONA = 'America/Argentina/Buenos_Aires';
export type Unidad = 'mes' | 'semana';
const CUANTOS: Record<Unidad, number> = { mes: 12, semana: 13 };
const VENTANA_DIAS = 90;
const N = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2 = (n: number) => Math.round(n * 100) / 100;
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** Día 'AAAA-MM-DD' → { d, m, a } sin husos (todo es calendario argentino). */
const partes = (dia: string) => { const [a, m, d] = dia.split('-').map(Number); return { a, m, d }; };
const diaDe = (a: number, m: number, d: number) => {
  const x = new Date(Date.UTC(a, m - 1, d));
  return x.toISOString().slice(0, 10);
};
const diasEntre = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/**
 * LOS PERÍODOS: los últimos 12 meses o 13 semanas (lunes a domingo), el
 * último es el que está en curso. `clave` es el primer día, igual que el
 * `date_trunc` de Postgres.
 */
export function periodos(unidad: Unidad, hoy: string) {
  const out: { clave: string; desde: string; hasta: string; etiqueta: string; titulo: string; enCurso: boolean; dias: number; transcurridos: number }[] = [];
  const { a, m, d } = partes(hoy);
  for (let i = CUANTOS[unidad] - 1; i >= 0; i -= 1) {
    let desde: string; let hasta: string; let etiqueta: string; let titulo: string;
    if (unidad === 'mes') {
      const ini = new Date(Date.UTC(a, m - 1 - i, 1));
      desde = ini.toISOString().slice(0, 10);
      hasta = diaDe(ini.getUTCFullYear(), ini.getUTCMonth() + 2, 0);
      etiqueta = `${MESES[ini.getUTCMonth()]} ${String(ini.getUTCFullYear()).slice(2)}`;
      titulo = `${MESES[ini.getUTCMonth()]} ${ini.getUTCFullYear()}`;
    } else {
      const dow = (new Date(Date.UTC(a, m - 1, d)).getUTCDay() + 6) % 7; // lunes = 0
      desde = sumarDias(diaDe(a, m, d), -dow - 7 * i);
      hasta = sumarDias(desde, 6);
      const p = partes(desde);
      const h = partes(hasta);
      etiqueta = `${p.d}/${p.m}`;
      titulo = `semana del ${p.d}/${p.m} al ${h.d}/${h.m}`;
    }
    const dias = diasEntre(desde, hasta) + 1;
    const enCurso = i === 0;
    out.push({ clave: desde, desde, hasta, etiqueta, titulo, enCurso, dias, transcurridos: enCurso ? diasEntre(desde, hoy) + 1 : dias });
  }
  return out;
}

/** Cómo se agrupan los medios de pago para leerlos de un vistazo. */
export const GRUPO_MEDIO: Record<string, string> = {
  efectivo: 'efectivo', transferencia: 'transferencia', transferencia_proveedor: 'transferencia',
  tarjeta_debito: 'tarjeta', tarjeta_credito: 'tarjeta', qr: 'mercadopago',
};

@Injectable()
export class VistaProfesionalService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly metricas: MetricasService,
    private readonly resultados: ResultadosService,
    private readonly finanzas: FinanzasProveedorService,
  ) {}

  async vista(unidad: Unidad) {
    const hoy = hoyAr();
    const ps = periodos(unidad, hoy);
    const inicio = ps[0].desde;
    const trunc = unidad === 'mes' ? 'month' : 'week';
    const PER = `to_char(date_trunc('${trunc}', v.fecha at time zone '${ZONA}'), 'YYYY-MM-DD')`;
    const DESDE = `v.fecha >= ($1::date::timestamp at time zone '${ZONA}')`;
    const VALIDA = `v.estado in ('confirmada','pendiente_cae')`;
    const SIGNO = `(case when v.tipo::text like 'nota_credito%' then -1 else 1 end)`;
    const desde90 = sumarDias(hoy, -(VENTANA_DIAS - 1));

    const [ventas, costos, medios, ritmo, clientes] = await this.metricas.leer((c) => Promise.all([
      c.query(`
        select ${PER} as p, coalesce(v.sucursal_id, 0) as suc,
          count(*) filter (where v.tipo::text not like 'nota_credito%')::int as tickets,
          sum(v.subtotal_neto * ${SIGNO}) as neto,
          sum(v.total * ${SIGNO}) as total,
          coalesce(sum(v.iva_total * ${SIGNO}) filter (where (${CLASE_VENTA}) = 'liquidado'), 0) as iva_sf,
          coalesce(sum(v.subtotal_neto * ${SIGNO}) filter (where (${CLASE_VENTA}) in ('facturado','pendiente')), 0) as facturado,
          coalesce(sum(v.total * ${SIGNO}) filter (where v.condicion_pago = 'cuenta_corriente'), 0) as cta_cte,
          coalesce(sum((select coalesce(sum(e.importe), 0) from venta_extras e
            where e.venta_id = v.id and e.concepto ~ '^Recargo [0-9]+ cuotas? [(]') * ${SIGNO}), 0) as recargos
        from ventas v where ${VALIDA} and ${DESDE}
        group by 1, 2`, [inicio]),
      c.query(`
        select ${PER} as p, coalesce(v.sucursal_id, 0) as suc,
          coalesce(sum(vi.cantidad * vi.costo_unitario * ${SIGNO}), 0) as costo,
          coalesce(sum(vi.subtotal * ${SIGNO}) filter (where vi.costo_unitario is null or vi.costo_unitario = 0), 0) as sin_costo
        from venta_items vi join ventas v on v.id = vi.venta_id
        where ${VALIDA} and ${DESDE}
        group by 1, 2`, [inicio]),
      c.query(`
        select ${PER} as p, coalesce(v.sucursal_id, 0) as suc, vp.medio::text as medio, sum(vp.importe * ${SIGNO}) as importe
        from venta_pagos vp join ventas v on v.id = vp.venta_id
        where ${VALIDA} and ${DESDE}
        group by 1, 2, 3`, [inicio]),
      /* El ritmo de los últimos 90 días: costo vendido, venta con IVA y compras con IVA. */
      c.query(`
        select
          (select coalesce(sum(vi.cantidad * vi.costo_unitario * ${SIGNO}), 0) from venta_items vi join ventas v on v.id = vi.venta_id
            where ${VALIDA} and ${DESDE}) as costo,
          (select coalesce(sum(v.total * ${SIGNO}), 0) from ventas v where ${VALIDA} and ${DESDE}) as ventas,
          (select coalesce(sum(cb.total * case when cb.tipo = 'nota_credito' then -1 else 1 end), 0) from comprobantes cb
            where cb.estado = 'confirmado' and cb.tipo in ('factura','liquidacion','nota_debito','nota_credito')
              and cb.fecha >= ($1::date::timestamp at time zone '${ZONA}')) as compras,
          (select min(v.fecha at time zone '${ZONA}')::date::text from ventas v where ${VALIDA}) as primera`, [desde90]),
      /* Lo que falta cobrar de las ventas en cuenta corriente (la misma cuenta del aviso de vencidas). */
      c.query(`
        select coalesce(sum(greatest(0, v.total
          - coalesce((select sum(ci.importe) from cobranza_imputaciones ci join cobranzas co on co.id = ci.cobranza_id
                      where ci.venta_id = v.id and co.estado = 'confirmada'), 0)
          - coalesce((select sum(n.total) from ventas n where n.ref_venta_id = v.id and n.estado = 'confirmada'
                      and n.condicion_pago = 'cuenta_corriente' and n.tipo::text like 'nota_credito%'), 0))), 0) as saldo
        from ventas v
        where v.estado = 'confirmada' and v.condicion_pago = 'cuenta_corriente' and v.tipo::text not like 'nota_credito%'`),
    ]));

    /* ---- Por período y por local ---- */
    type Celda = { ventas: number; costo: number; sinCosto: number; tickets: number; total: number; ivaSinFactura: number; facturado: number; ctaCte: number; recargos: number; medios: Record<string, number> };
    const vacia = (): Celda => ({ ventas: 0, costo: 0, sinCosto: 0, tickets: 0, total: 0, ivaSinFactura: 0, facturado: 0, ctaCte: 0, recargos: 0, medios: {} });
    const celdas = new Map<string, Map<number, Celda>>();
    const de = (p: string, suc: number) => {
      let m = celdas.get(p); if (!m) { m = new Map(); celdas.set(p, m); }
      let x = m.get(suc); if (!x) { x = vacia(); m.set(suc, x); }
      return x;
    };
    for (const f of ventas.rows) {
      const x = de(f.p, N(f.suc));
      x.tickets += N(f.tickets); x.total += N(f.total); x.ivaSinFactura += N(f.iva_sf); x.facturado += N(f.facturado);
      x.ctaCte += N(f.cta_cte); x.recargos += N(f.recargos);
      x.ventas += N(f.neto) - N(f.recargos) + N(f.iva_sf);
    }
    for (const f of costos.rows) { const x = de(f.p, N(f.suc)); x.costo += N(f.costo); x.sinCosto += N(f.sin_costo); }
    for (const f of medios.rows) {
      const x = de(f.p, N(f.suc));
      const g = GRUPO_MEDIO[f.medio] ?? 'otros';
      x.medios[g] = (x.medios[g] ?? 0) + N(f.importe);
    }
    const redondear = (x: Celda) => ({
      ...Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'medios').map(([k, v]) => [k, r2(v as number)])),
      medios: Object.fromEntries(Object.entries(x.medios).map(([k, v]) => [k, r2(v)])),
    });

    /* ---- El resultado mensual, de Resultados ---- */
    const avisos: string[] = [];
    let porMes = new Map<string, any>();
    if (unidad === 'mes') {
      try {
        const est: any = await this.resultados.estado({ desde: ps[0].clave.slice(0, 7), hasta: ps[ps.length - 1].clave.slice(0, 7) });
        porMes = new Map(est.meses.map((m: any) => [m.mes, m]));
        for (const a of est.avisos ?? []) if (a.tono === 'warn') avisos.push(a.texto);
      } catch (e: any) {
        avisos.push(`No se pudo leer el estado de resultados: ${e?.message ?? 'error'}.`);
      }
    }
    const resultadoDe = (m: any, balde: number | null) => {
      if (!m) return null;
      const b = balde == null ? m.total : m.baldes.find((x: any) => x.balde === balde);
      const c = b?.cascada;
      if (!c) return null;
      return {
        /* Las diferencias de inventario que entraron (para avisar si pesan). */
        ajustesStock: r2(b.hechos?.ajustesStock ?? 0),
        margenBruto: r2(c.margenBruto), contribucion: r2(c.contribucion), totalFijos: r2(c.totalFijos),
        operativo: r2(c.operativo), antesGanancias: r2(c.antesGanancias),
        ganancias: balde == null ? r2(m.ganancias?.impuesto ?? 0) : null,
        neto: balde == null ? r2(m.neto) : null,
      };
    };

    const salida = ps.map((p) => {
      const m = celdas.get(p.clave) ?? new Map<number, Celda>();
      const total = vacia();
      for (const x of m.values()) {
        for (const k of Object.keys(total) as (keyof Celda)[]) if (k !== 'medios') (total as any)[k] += (x as any)[k];
        for (const [g, v] of Object.entries(x.medios)) total.medios[g] = (total.medios[g] ?? 0) + v;
      }
      const mes = porMes.get(p.clave.slice(0, 7));
      return {
        ...p,
        total: { ...redondear(total), resultado: resultadoDe(mes, null) },
        porLocal: Object.fromEntries([...m.entries()].map(([suc, x]) => [suc, { ...redondear(x), resultado: resultadoDe(mes, suc) }])),
      };
    });

    /* ---- La foto de hoy: dónde está la plata ---- */
    const [stockV, edoc, sucs] = await Promise.all([
      this.metricas.stock({ ventana: 30 }).catch(() => null),
      this.finanzas.edocGlobal().catch(() => null),
      this.db.select({ id: sucursales.id, nombre: sucursales.nombre, activa: sucursales.activa }).from(sucursales).orderBy(asc(sucursales.id)),
    ]);
    const rt = ritmo.rows[0] ?? {};
    const primera = rt.primera as string | null;
    /* Si el sistema tiene menos de 90 días de ventas, el ritmo se mide sobre los que hay. */
    const diasRitmo = Math.max(1, Math.min(VENTANA_DIAS, primera ? diasEntre(primera, hoy) + 1 : VENTANA_DIAS));
    const porDia = (v: unknown) => N(v) / diasRitmo;
    const deudaProv = edoc ? r2(edoc.reduce((a: number, f: any) => a + Math.max(0, N(f.saldo)), 0)) : null;
    const aFavorProv = edoc ? r2(edoc.reduce((a: number, f: any) => a + Math.max(0, -N(f.saldo)), 0)) : null;
    const stockCosto = stockV ? r2(stockV.resumen.valorPropio) : null;
    const aCobrar = r2(N(clientes.rows[0]?.saldo));
    const dias = (monto: number | null, diario: number) => (monto != null && diario > 0 ? Math.round(monto / diario) : null);
    const diasStock = dias(stockCosto, porDia(rt.costo));
    const diasCobro = dias(aCobrar, porDia(rt.ventas));
    const diasPago = dias(deudaProv, porDia(rt.compras));
    const foto = {
      stockCosto, stockParado: stockV ? r2(stockV.resumen.valorParado) : null,
      stockPorLocal: stockV?.porSucursal ?? [],
      deudaProveedores: deudaProv, aFavorProveedores: aFavorProv, aCobrarClientes: aCobrar,
      diasStock, diasCobro, diasPago,
      cicloCaja: diasStock != null && diasCobro != null && diasPago != null ? diasStock + diasCobro - diasPago : null,
      ritmo: { dias: diasRitmo, costoDiario: r2(porDia(rt.costo)), ventaDiaria: r2(porDia(rt.ventas)), compraDiaria: r2(porDia(rt.compras)) },
    };
    if (diasRitmo < VENTANA_DIAS) avisos.push(`El ritmo diario se mide con ${diasRitmo} días de ventas (el sistema arrancó el ${primera}): los «días» de stock, cobro y pago se afinan solos con el tiempo.`);

    return { unidad, hoy, sucursales: sucs, periodos: salida, foto, avisos };
  }
}

@Controller('gerencia/vista-profesional')
@Permiso('gerencia.vista')
export class VistaProfesionalController {
  constructor(private readonly svc: VistaProfesionalService) {}

  @Get()
  vista(@Query('unidad') unidad?: string) {
    if (unidad && unidad !== 'mes' && unidad !== 'semana') throw new BadRequestException('La vista es «mes» o «semana».');
    return this.svc.vista((unidad as Unidad) || 'mes');
  }
}

@Module({
  imports: [MetricasModule, ResultadosModule, FinanzasProveedorModule],
  controllers: [VistaProfesionalController],
  providers: [VistaProfesionalService],
})
export class VistaProfesionalModule {}
