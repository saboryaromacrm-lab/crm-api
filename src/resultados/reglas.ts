/**
 * LAS REGLAS DEL ESTADO DE RESULTADOS (0152, 9/10/2026) — funciones puras.
 * ============================================================================
 * Todo en NETO (sin IVA): el IVA es un resultado aparte. Acá vive la cuenta;
 * `datos.ts` solo junta los hechos de la base y `resultados.module.ts` arma.
 *
 * LA CASCADA (por mes y por «balde»: un local, «Sin local» o «Administración»)
 *
 *     Ventas a precio de lista
 *   − Descuentos y ofertas
 *   − Devoluciones y notas de crédito
 *   + Envíos y otros cargos cobrados
 *   = VENTAS NETAS
 *   − Costo de la mercadería vendida (el congelado en cada renglón)
 *   − Mermas, vencidos y defectuosos
 *   ± Diferencias de inventario (ajustes y controles de stock)
 *   = MARGEN BRUTO
 *   − Ingresos Brutos, tasa municipal y comisiones (por % o el pago real)
 *   − Otros gastos variables (rubros variables)
 *   = CONTRIBUCIÓN MARGINAL
 *   − Sueldos y cargas (con 1/12 de aguinaldo)
 *   − Gastos fijos (rubros fijos)
 *   − Amortizaciones (opcional)
 *   = RESULTADO OPERATIVO
 *   ± Resultados financieros (+ recargo por cuotas − rubros financieros)
 *   = RESULTADO ANTES DE GANANCIAS
 *   − Impuesto a las Ganancias (estimado, solo la empresa entera)
 *   = RESULTADO NETO
 *   (aparte) Retiros de los socios
 */

export const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const N = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Los baldes que no son un local: lo vendido sin local (web) y lo que no se reparte. */
export const SIN_LOCAL = 0;
export const ADMINISTRACION = -1;

/* --------------------------------- meses --------------------------------- */

export const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 'AAAA-MM' de a uno, de `a` a `b` inclusive. */
export function mesesEntre(a: string, b: string): string[] {
  const out: string[] = [];
  let [y, m] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  while (y < yb || (y === yb && m <= mb)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** El mes `n` meses antes (negativo) o después de `mes`. */
export function sumarMeses(mes: string, n: number): string {
  const [y, m] = mes.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

export const diasDelMes = (mes: string) => {
  const [y, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/* ------------------------------ tasas (vigencia) ------------------------------ */

export type Tasa = {
  id?: number; concepto: 'iibb' | 'municipalidad' | 'tarjeta';
  sucursalId: number | null; medio: string | null;
  porcentaje: number; minimo: number; desde: string; // 'AAAA-MM'
};

/**
 * LA TASA DEL MES. De las que valen desde ese mes o antes, manda la más
 * PUNTUAL (la de ese local / ese medio antes que la general) y, entre las
 * igual de puntuales, la más nueva. Así una tasa propia de Fontana no la pisa
 * un cambio posterior de la general.
 */
export function tasaVigente(
  tasas: Tasa[], concepto: Tasa['concepto'], mes: string,
  o: { sucursalId?: number | null; medio?: string | null } = {},
): Tasa | null {
  let mejor: Tasa | null = null;
  let mejorPuntaje = -1;
  for (const t of tasas) {
    if (t.concepto !== concepto || t.desde > mes) continue;
    if (t.sucursalId != null && t.sucursalId !== (o.sucursalId ?? null)) continue;
    if (t.medio != null && t.medio !== (o.medio ?? null)) continue;
    const puntaje = (t.sucursalId != null ? 2 : 0) + (t.medio != null ? 1 : 0);
    if (puntaje > mejorPuntaje || (puntaje === mejorPuntaje && mejor && t.desde > mejor.desde)) {
      mejor = t; mejorPuntaje = puntaje;
    }
  }
  return mejor;
}

/* ------------------------------ sueldos ------------------------------ */

export type Sueldo = { desde: string; bruto: number; cargas: number }; // desde 'AAAA-MM'
export type Empleado = {
  id: number; nombre: string; sucursalId: number | null;
  alta: string; baja: string | null; // 'AAAA-MM-DD'
  sueldos: Sueldo[];
};

/** Qué parte del mes estuvo contratado (por días): 1 = el mes entero. */
export function parteDelMes(alta: string, baja: string | null, mes: string): number {
  const ini = `${mes}-01`;
  const fin = `${mes}-${String(diasDelMes(mes)).padStart(2, '0')}`;
  const desde = alta > ini ? alta : ini;
  const hasta = baja && baja < fin ? baja : fin;
  if (hasta < desde) return 0;
  const dias = (Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000 + 1;
  return Math.min(1, dias / diasDelMes(mes));
}

/**
 * EL COSTO DE UN EMPLEADO EN EL MES (devengado): sueldo bruto + cargas del
 * empleador + 1/12 de aguinaldo sobre los dos (así junio y diciembre no
 * muestran una pérdida falsa). Proporcional a los días si entró o se fue en
 * el mes. Sin sueldo cargado para ese mes → 0 y `sinSueldo`.
 */
export function costoEmpleadoMes(e: Empleado, mes: string) {
  const parte = parteDelMes(e.alta, e.baja, mes);
  if (parte <= 0) return null;
  const s = [...e.sueldos].filter((x) => x.desde <= mes).sort((a, b) => (a.desde < b.desde ? 1 : -1))[0];
  if (!s) return { parte, bruto: 0, cargas: 0, aguinaldo: 0, total: 0, sinSueldo: true };
  const bruto = N(s.bruto) * parte;
  const cargas = bruto * N(s.cargas) / 100;
  const aguinaldo = (bruto + cargas) / 12;
  return { parte, bruto: r2(bruto), cargas: r2(cargas), aguinaldo: r2(aguinaldo), total: r2(bruto + cargas + aguinaldo), sinSueldo: false };
}

/* ------------------------------ amortizaciones ------------------------------ */

export type Bien = { id: number; nombre: string; sucursalId: number | null; valor: number; alta: string; vidaMeses: number; baja: string | null };

/** En línea recta: valor / vida útil, cada mes desde el de alta, hasta completar la vida o la baja. */
export function amortizacionMes(b: Bien, mes: string): number {
  const alta = b.alta.slice(0, 7);
  if (mes < alta || mes > sumarMeses(alta, b.vidaMeses - 1)) return 0;
  if (b.baja && mes > b.baja.slice(0, 7)) return 0;
  return r2(N(b.valor) / Math.max(1, b.vidaMeses));
}

/* ------------------------------ reparto ------------------------------ */

/**
 * REPARTIR un importe entre baldes en proporción a sus pesos (las ventas
 * netas de cada local), al centavo: la suma de las partes es EXACTAMENTE el
 * importe. Sin pesos positivos va entero a «Administración».
 */
export function repartir(importe: number, pesos: Map<number, number>): Map<number, number> {
  const out = new Map<number, number>();
  const total = r2(importe);
  if (Math.abs(total) < 0.005) return out;
  const validos = [...pesos].filter(([, p]) => p > 0);
  const suma = validos.reduce((a, [, p]) => a + p, 0);
  if (!validos.length || suma <= 0) { out.set(ADMINISTRACION, total); return out; }
  const centavos = Math.round(total * 100);
  const crudos = validos.map(([k, p]) => ({ k, exacto: (centavos * p) / suma }));
  const base = crudos.map((x) => ({ ...x, piso: Math.floor(x.exacto) }));
  let resto = centavos - base.reduce((a, x) => a + x.piso, 0);
  base.sort((a, b) => (b.exacto - b.piso) - (a.exacto - a.piso));
  for (const x of base) { const extra = resto > 0 ? 1 : 0; resto -= extra; out.set(x.k, (x.piso + extra) / 100); }
  return out;
}

/* ------------------------------ Ganancias ------------------------------ */

export type Tramo = { desde: number; fijo: number; pct: number };
export type Escala = { anio: number; tramos: Tramo[]; deducciones: Record<string, number> };

export const totalDeducciones = (d: Record<string, number>) => r2(Object.values(d ?? {}).reduce((a, v) => a + N(v), 0));

/** El impuesto del artículo 94 sobre una ganancia imponible, con la escala multiplicada por `k` (meses/12). */
export function impuestoEscala(tramos: Tramo[], imponible: number, k = 1): number {
  if (!(imponible > 0) || !tramos.length) return 0;
  const orden = [...tramos].sort((a, b) => a.desde - b.desde);
  let t = orden[0];
  for (const x of orden) if (imponible > x.desde * k) t = x;
  return r2(t.fijo * k + (imponible - t.desde * k) * t.pct / 100);
}

/** La escala del año: la suya, o la del último año cargado antes (o la primera, si no hay anterior). */
export function escalaDelAnio(escalas: Escala[], anio: number): { escala: Escala; propia: boolean } | null {
  if (!escalas.length) return null;
  const propia = escalas.find((e) => e.anio === anio);
  if (propia) return { escala: propia, propia: true };
  const antes = escalas.filter((e) => e.anio < anio).sort((a, b) => b.anio - a.anio)[0];
  return { escala: antes ?? [...escalas].sort((a, b) => a.anio - b.anio)[0], propia: false };
}

/**
 * GANANCIAS POR LO ACUMULADO (como liquida ARCA las retenciones): en el mes M
 * del año, la ganancia acumulada de enero a M menos las deducciones de M
 * meses, contra la escala de M meses. El impuesto del mes es lo acumulado
 * menos lo que ya se había reconocido: si un mes da pérdida, devuelve parte
 * (negativo). `bases[i]` = la base del mes i+1 (enero = 0).
 */
export function gananciasDelAnio(escala: Escala, bases: number[]) {
  const ded = totalDeducciones(escala.deducciones);
  let acumulada = 0;
  let impuestoAntes = 0;
  return bases.map((base, i) => {
    const k = (i + 1) / 12;
    acumulada = r2(acumulada + N(base));
    const imponible = r2(Math.max(0, acumulada - ded * k));
    const impuestoAcum = impuestoEscala(escala.tramos, imponible, k);
    const delMes = r2(impuestoAcum - impuestoAntes);
    impuestoAntes = impuestoAcum;
    return { base: r2(base), acumulada, deducciones: r2(ded * k), imponible, impuestoAcum, impuesto: delMes };
  });
}

/* ------------------------------ la cascada ------------------------------ */

/** Lo que pasó en un balde y un mes (todo neto, todo en positivo salvo los ± marcados). */
export type Hechos = {
  ventasLista: number; descuentos: number; notasCredito: number; cargos: number;
  cmv: number; mermas: number; ajustesStock: number; // ajustesStock: + sobrante / − faltante
  iibb: number; municipalidad: number; comisiones: number;
  variables: Record<string, number>; // rubroId → importe
  sueldos: number; fijos: Record<string, number>; amortizaciones: number;
  recargos: number; financieros: Record<string, number>; // recargos: + ingreso; financieros: gasto
  retiros: number;
  sinCosto: number; ventaSinCosto: number; // renglones sin costo y lo vendido en ellos
  /* Informativos (no entran en la cascada): */
  facturado: number; // neto facturado: la base de IIBB y de la tasa municipal
  ivaSinFactura: number; // el IVA de lo vendido sin factura (el resultado de IVA «de gestión»)
  comisionesMp: number; // la parte de Mercado Pago dentro de `comisiones`
};

export const hechosVacios = (): Hechos => ({
  ventasLista: 0, descuentos: 0, notasCredito: 0, cargos: 0, cmv: 0, mermas: 0, ajustesStock: 0,
  iibb: 0, municipalidad: 0, comisiones: 0, variables: {}, sueldos: 0, fijos: {}, amortizaciones: 0,
  recargos: 0, financieros: {}, retiros: 0, sinCosto: 0, ventaSinCosto: 0,
  facturado: 0, ivaSinFactura: 0, comisionesMp: 0,
});

const sumaDe = (o: Record<string, number>) => Object.values(o).reduce((a, v) => a + N(v), 0);

/** Los subtotales de la cascada. Son sumas: los de varios baldes o meses se pueden sumar entre sí. */
export function cascada(h: Hechos) {
  const ventasNetas = r2(h.ventasLista - h.descuentos - h.notasCredito + h.cargos);
  const margenBruto = r2(ventasNetas - h.cmv - h.mermas + h.ajustesStock);
  const otrosVariables = r2(sumaDe(h.variables));
  const totalVariables = r2(h.iibb + h.municipalidad + h.comisiones + otrosVariables);
  const contribucion = r2(margenBruto - totalVariables);
  const otrosFijos = r2(sumaDe(h.fijos));
  const totalFijos = r2(h.sueldos + otrosFijos + h.amortizaciones);
  const operativo = r2(contribucion - totalFijos);
  const resultadoFinanciero = r2(h.recargos - sumaDe(h.financieros));
  const antesGanancias = r2(operativo + resultadoFinanciero);
  return {
    ventasNetas, margenBruto, otrosVariables, totalVariables, contribucion,
    otrosFijos, totalFijos, operativo, resultadoFinanciero, antesGanancias,
  };
}

/** Suma `b` en `a` (los dos son Hechos; los rubros, por id). */
export function sumarHechos(a: Hechos, b: Hechos): Hechos {
  const out = { ...a, variables: { ...a.variables }, fijos: { ...a.fijos }, financieros: { ...a.financieros } };
  for (const k of Object.keys(b) as (keyof Hechos)[]) {
    const v = b[k];
    if (typeof v === 'number') (out as any)[k] = r2(N((out as any)[k]) + v);
  }
  for (const grupo of ['variables', 'fijos', 'financieros'] as const) {
    for (const [id, v] of Object.entries(b[grupo])) out[grupo][id] = r2(N(out[grupo][id]) + N(v));
  }
  return out;
}
