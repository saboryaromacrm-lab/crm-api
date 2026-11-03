/**
 * MÉTRICAS › SISTEMA ANTERIOR (0213, 3/11/2026)
 * ============================================================================
 * Pedido del dueño: comparar los meses del sistema viejo (su «Estadística de
 * ventas por período», un archivo por local) con los primeros meses del ERP.
 * «Aproximado nomás; lo que no estés seguro de comparar, que no se haga».
 *
 * QUÉ SE COMPARA Y POR QUÉ ASÍ:
 *   · Venta, ticket promedio y venta por día: CON IVA y de todo lo vendido,
 *     como el monto del archivo. Del ERP sale el total cobrado (las notas de
 *     crédito restan).
 *   · Tickets y días con venta: comprobantes y días del archivo, tickets y
 *     días con tickets del ERP.
 *   · Renta y markup: el archivo trae venta y costo con IVA; el ERP los guarda
 *     netos. El % da casi lo mismo (el IVA está arriba y abajo), los pesos no:
 *     por eso se compara el % y no la ganancia en $. Y solo si el ERP tiene
 *     costo para casi todo lo vendido: con productos sin costo la renta sale
 *     inflada.
 *   · Las unidades NO: el sistema viejo y el ERP no cuentan igual el granel.
 *
 * CADA MES SALE DE UN SOLO SISTEMA: si se subió del anterior, ese (y si el ERP
 * también vendió algo ese mes se avisa, sin sumarlo); si no, el del ERP.
 */
import { BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsInt, IsNumber, Matches, Max, Min, ValidateNested } from 'class-validator';
import type { PoolClient } from 'pg';
import { hoyAr } from '../cafeteria/cuenta';
import { N, pct, r2, variacion } from './consultas';

/** Con menos de esta parte de lo vendido con costo, la renta del ERP no se muestra: saldría inflada. */
export const COBERTURA_MIN = 95;

const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const TOPE = 10_000_000_000;

export class MesAnteriorDto {
  @Matches(MES_RE, { message: 'El mes va como AAAA-MM.' }) mes!: string;
  @IsInt() @Min(0) @Max(31) diasVenta!: number;
  @IsInt() @Min(0) @Max(10_000_000) comprobantes!: number;
  @IsNumber() @Min(0) @Max(TOPE) monto!: number;
  @IsNumber() @Min(0) @Max(TOPE) costo!: number;
}

export class GuardarAnteriorDto {
  @IsInt() @Min(1) sucursalId!: number;
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(60) @ValidateNested({ each: true }) @Type(() => MesAnteriorDto)
  meses!: MesAnteriorDto[];
}

/** El mes anterior a 'AAAA-MM'. */
const mesAnterior = (m: string) => {
  const [a, n] = m.split('-').map(Number);
  return n === 1 ? `${a - 1}-12` : `${a}-${String(n - 1).padStart(2, '0')}`;
};

/** Un mes, con las mismas cuentas para los dos sistemas. */
function armarMes(
  origen: 'anterior' | 'erp', mes: string,
  x: { dias: number; tickets: number; venta: number; ventaRenta: number; costo: number; cobertura: number | null },
) {
  const comparable = x.cobertura == null || x.cobertura >= COBERTURA_MIN;
  return {
    mes, origen,
    enCurso: mes === hoyAr().slice(0, 7),
    diasVenta: x.dias,
    tickets: x.tickets,
    venta: r2(x.venta),
    ticketPromedio: x.tickets > 0 ? r2(x.venta / x.tickets) : 0,
    ventaPorDia: x.dias > 0 ? r2(x.venta / x.dias) : 0,
    rentaPct: comparable ? pct(x.ventaRenta - x.costo, x.ventaRenta) : null,
    markupPct: comparable && x.costo > 0 ? r2((x.ventaRenta / x.costo - 1) * 100) : null,
    /** Qué parte de lo vendido tiene costo (solo el ERP: el archivo viejo trae el costo de todo). */
    cobertura: x.cobertura,
  };
}
type Mes = ReturnType<typeof armarMes>;

/** De `b` a `a`: % en lo que es plata o cantidad, puntos en la renta. */
const variaciones = (a: Mes, b: Mes) => ({
  venta: variacion(a.venta, b.venta),
  ventaPorDia: variacion(a.ventaPorDia, b.ventaPorDia),
  tickets: variacion(a.tickets, b.tickets),
  ticketPromedio: variacion(a.ticketPromedio, b.ticketPromedio),
  rentaPts: a.rentaPct != null && b.rentaPct != null ? r2(a.rentaPct - b.rentaPct) : null,
});

/** Los locales que tienen algo subido del sistema anterior, con desde y hasta qué mes. */
export async function localesConAnterior(c: Pick<PoolClient, 'query'>) {
  const r = await c.query(
    `SELECT a.sucursal_id, s.nombre, to_char(min(a.mes), 'YYYY-MM') AS desde, to_char(max(a.mes), 'YYYY-MM') AS hasta
     FROM metricas_sistema_anterior a JOIN sucursales s ON s.id = a.sucursal_id
     GROUP BY 1, 2 ORDER BY 1`);
  return r.rows.map((x: any) => ({ sucursalId: N(x.sucursal_id), nombre: x.nombre as string, desde: x.desde as string, hasta: x.hasta as string }));
}

export async function reporteAnterior(c: PoolClient, sucursalId: number) {
  const [viejo, erp, locales] = await Promise.all([
    c.query(
      `SELECT to_char(mes, 'YYYY-MM') AS mes, dias_venta, comprobantes, monto::float8 AS monto, costo::float8 AS costo
       FROM metricas_sistema_anterior WHERE sucursal_id = $1`, [sucursalId]),
    c.query(
      `SELECT to_char(v.mes, 'YYYY-MM') AS mes, v.dias, v.tickets, v.total,
         coalesce(m.venta_neta, 0) AS venta_neta, coalesce(m.venta_costeada, 0) AS venta_costeada, coalesce(m.costo, 0) AS costo
       FROM (SELECT date_trunc('month', d.dia) AS mes, sum(d.tickets)::float8 AS tickets, sum(d.total) AS total,
               count(DISTINCT d.dia) FILTER (WHERE d.tickets > 0)::float8 AS dias
             FROM metricas_venta_dia d WHERE d.sucursal_id = $1 GROUP BY 1) v
         LEFT JOIN (SELECT date_trunc('month', f.dia) AS mes, sum(f.venta_neta) AS venta_neta,
               sum(f.venta_costeada) AS venta_costeada, sum(f.costo) AS costo
             FROM metricas_venta_prod_dia f WHERE f.sucursal_id = $1 GROUP BY 1) m ON m.mes = v.mes`, [sucursalId]),
    localesConAnterior(c),
  ]);

  const deErp = new Map<string, Mes>(erp.rows.map((x: any) => [x.mes, armarMes('erp', x.mes, {
    dias: N(x.dias), tickets: N(x.tickets), venta: N(x.total), ventaRenta: N(x.venta_costeada), costo: N(x.costo),
    cobertura: N(x.venta_neta) > 0 ? r2((N(x.venta_costeada) / N(x.venta_neta)) * 100) : null,
  })]));
  const delViejo = new Map<string, Mes>(viejo.rows.map((x: any) => [x.mes, armarMes('anterior', x.mes, {
    dias: N(x.dias_venta), tickets: N(x.comprobantes), venta: N(x.monto), ventaRenta: N(x.monto), costo: N(x.costo), cobertura: null,
  })]));

  const meses = [...new Set([...deErp.keys(), ...delViejo.keys()])].sort().map((mes) => {
    const v = delViejo.get(mes);
    if (!v) return { ...deErp.get(mes)!, tambienErp: null };
    const e = deErp.get(mes);
    // Lo que el ERP vendió en un mes que se subió del anterior: se avisa, no se suma.
    return { ...v, tambienErp: e && (e.tickets > 0 || e.venta !== 0) ? { venta: e.venta, tickets: e.tickets } : null };
  });
  const filas = meses.map((m, i) => {
    const previo = meses[i - 1];
    return { ...m, vsMesAnterior: previo && previo.mes === mesAnterior(m.mes) ? variaciones(m, previo) : null };
  });

  // El último mes cerrado del ERP contra el último del sistema anterior.
  const ultimoErp = [...filas].reverse().find((m) => m.origen === 'erp' && !m.enCurso);
  const base = ultimoErp && [...filas].reverse().find((m) => m.origen === 'anterior' && m.mes < ultimoErp.mes);
  return {
    sucursalId,
    coberturaMin: COBERTURA_MIN,
    meses: filas,
    comparacion: ultimoErp && base ? { erp: ultimoErp.mes, anterior: base.mes, variacion: variaciones(ultimoErp, base) } : null,
    locales,
  };
}

/** Guarda los meses de un local; un mes que ya estaba se reemplaza. Solo meses cerrados. */
export async function guardarAnterior(c: PoolClient, dto: GuardarAnteriorDto) {
  const suc = await c.query('SELECT 1 FROM sucursales WHERE id = $1', [dto.sucursalId]);
  if (!suc.rowCount) throw new BadRequestException('La sucursal no existe.');
  const vistos = new Set<string>();
  const actual = hoyAr().slice(0, 7);
  for (const m of dto.meses) {
    if (vistos.has(m.mes)) throw new BadRequestException(`El mes ${m.mes} viene dos veces en el archivo.`);
    if (m.mes >= actual) throw new BadRequestException(`El mes ${m.mes} no terminó: del sistema anterior solo se suben meses cerrados.`);
    vistos.add(m.mes);
  }
  await c.query('BEGIN');
  try {
    for (const m of dto.meses) {
      await c.query(
        `INSERT INTO metricas_sistema_anterior (sucursal_id, mes, dias_venta, comprobantes, monto, costo)
         VALUES ($1, ($2 || '-01')::date, $3, $4, $5, $6)
         ON CONFLICT (sucursal_id, mes) DO UPDATE SET dias_venta = $3, comprobantes = $4, monto = $5, costo = $6, importado_en = now()`,
        [dto.sucursalId, m.mes, m.diasVenta, m.comprobantes, m.monto, m.costo]);
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
  return { ok: true, meses: dto.meses.length };
}

/** Saca un mes subido por error. */
export async function quitarAnterior(c: Pick<PoolClient, 'query'>, sucursalId: number, mes: string) {
  if (!MES_RE.test(mes)) throw new BadRequestException('El mes va como AAAA-MM.');
  const r = await c.query(`DELETE FROM metricas_sistema_anterior WHERE sucursal_id = $1 AND mes = ($2 || '-01')::date`, [sucursalId, mes]);
  if (!r.rowCount) throw new BadRequestException('Ese mes no estaba subido.');
  return { ok: true };
}
