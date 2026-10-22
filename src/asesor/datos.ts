/**
 * GERENCIA › ASESOR · LO QUE MIRA (0193, 21/10/2026)
 * ============================================================================
 * Las cuentas del asesor. La IA NO hace cuentas: estas funciones arman números
 * cortos y ya calculados (los mismos de Métricas, Resultados, Gastos y la caja)
 * y la IA los interpreta. Las usan dos lados:
 *   · la FOTO del negocio (foto.ts), que va entera en cada análisis;
 *   · las HERRAMIENTAS de las preguntas (herramientas.ts), que la IA llama
 *     cuando necesita un dato que la foto no tiene.
 *
 * Reglas:
 *   · Todo de SOLO LECTURA, por el pool de Métricas (transacción read only, con
 *     tope de tiempo): una consulta del asesor nunca frena una caja.
 *   · Lo más posible sobre las tablas resumen `metricas_*`.
 *   · Importes NETOS (sin IVA) salvo que diga otra cosa; granel en kg.
 *   · NUNCA datos de clientes (nombres, DNI, teléfonos): no salen de acá.
 *   · Listas cortas y números redondeados: cada token que se manda se paga.
 */
import type { PoolClient } from 'pg';
import type { MetricasService } from '../metricas/metricas.module';
import type { ResultadosService } from '../resultados/resultados.module';
import type { GastosService } from '../gastos/gastos.module';
import type { CuponesService } from '../cupones/cupones.module';
import type { MetricasTiendaService } from '../web/metricas-tienda';
import type { ReglasVencimientoService } from '../vencimientos/reglas.service';
import {
  type Filtro, type Lente, N, r2, pct, variacion, reporteVentas, reporteMargenes, sumaMargen, reporteGranel, reporteComparar,
} from '../metricas/consultas';
import { reporteOfertas } from '../metricas/ofertas';
import { hoyAr, sumarDias } from '../cafeteria/cuenta';

/** Los servicios que leen los asesores (los arma el módulo: token `FUENTES`). */
export interface Fuentes {
  metricas: MetricasService;
  resultados: ResultadosService;
  gastos: GastosService;
  cupones: CuponesService;
  tienda: MetricasTiendaService;
  /** Precio de cada lista y costo real de hoy, por artículo: los mismos de la caja. */
  precios: ReglasVencimientoService;
}
export const FUENTES = 'ASESOR_FUENTES';

const ZONA = 'America/Argentina/Buenos_Aires';
const r1 = (n: number) => Math.round((Number(n) || 0) * 10) / 10;
const r0 = (n: number) => Math.round(Number(n) || 0);
const DIAS = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
/** AAAA-MM-DD de un día que existe (el 30 de febrero, no: JavaScript lo correría al 2 de marzo). */
export const diaValido = (v: unknown): v is string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T12:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
};
const diasEntre = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;
/** Un rango de días argentino sobre una columna timestamptz (usa el índice). */
const enRango = (col: string, i: number) => `${col} >= ($${i}::date::timestamp AT TIME ZONE '${ZONA}') AND ${col} < (($${i + 1}::date + 1)::timestamp AT TIME ZONE '${ZONA}')`;

/** Una parte de la foto que falla no la tumba: queda su error, para que la IA sepa que falta. */
export async function seguro<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try { return await fn(); } catch (e) { return { error: String((e as Error)?.message ?? e).slice(0, 200) }; }
}

/**
 * Las consultas de UNA conexión, una detrás de otra: el cliente de pg no admite
 * dos a la vez (y en paralelo no se ganaba nada: igual iban en fila).
 */
export async function enSerie<T extends unknown[]>(...pasos: { [K in keyof T]: () => Promise<T[K]> }): Promise<T> {
  const out: unknown[] = [];
  for (const paso of pasos) out.push(await paso());
  return out as T;
}

/* ============================== PERÍODOS ============================== */

/** Un período pedido (por la IA o por la foto), validado: hasta 3 años, nada futuro. */
export function periodo(desde?: string | null, hasta?: string | null, sucursalId?: number | null): Filtro {
  const hoy = hoyAr();
  const h = diaValido(hasta) && hasta! <= hoy ? hasta! : hoy;
  const d = diaValido(desde) && desde! <= h ? desde! : `${h.slice(0, 8)}01`;
  if (diasEntre(d, h) > 1100) throw new Error('El período puede ser de hasta 3 años.');
  return { desde: d, hasta: h, sucursalId: sucursalId && sucursalId > 0 ? sucursalId : null };
}

/** Los mismos días del mes anterior: del 1 al 21 de octubre → del 1 al 21 de septiembre (o hasta fin de mes). */
export function mismosDiasMesAnterior(f: Filtro): Filtro {
  const [y, m] = f.desde.split('-').map(Number);
  const py = m === 1 ? y - 1 : y; const pm = m === 1 ? 12 : m - 1;
  const ultimo = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  const mes = `${py}-${String(pm).padStart(2, '0')}`;
  const dd = (d: string) => String(Math.min(Number(d.slice(8, 10)), ultimo)).padStart(2, '0');
  return { ...f, desde: `${mes}-${dd(f.desde)}`, hasta: `${mes}-${dd(f.hasta)}` };
}

/** Los N días anteriores a hoy (incluido) y los N de antes: para «qué cambió último». */
export function ultimosDias(n: number, sucursalId: number | null = null): { a: Filtro; b: Filtro } {
  const hoy = hoyAr();
  const a = { desde: sumarDias(hoy, -(n - 1)), hasta: hoy, sucursalId };
  return { a, b: { desde: sumarDias(a.desde, -n), hasta: sumarDias(a.desde, -1), sucursalId } };
}

/* ============================== CONTEXTO ============================== */

export async function contexto(c: PoolClient) {
  const [sucs, est] = await enSerie(
    () => c.query(`SELECT id, nombre, tipo::text AS tipo FROM sucursales WHERE activa ORDER BY id`),
    () => c.query(`SELECT ultima_ok FROM metricas_estado WHERE id = 1`));
  return {
    hoy: hoyAr(),
    sucursales: sucs.rows.map((s: any) => ({ id: N(s.id), nombre: s.nombre, tipo: s.tipo })),
    metricasAl: est.rows[0]?.ultima_ok ?? null,
  };
}

/* ============================== VENTAS ============================== */

export async function ventas(c: PoolClient, f: Filtro, contra: Filtro) {
  const [a, b] = await enSerie(() => reporteVentas(c, f, 'mes'), () => reporteVentas(c, contra, 'mes'));
  const sucB = new Map(b.porSucursal.map((s) => [s.sucursalId, s]));
  const t = a.totales; const tb = b.totales;
  return {
    periodo: `${f.desde} a ${f.hasta}`, comparadoCon: `${contra.desde} a ${contra.hasta}`,
    ventaNeta: t.ventaNeta, tickets: t.tickets, ticketPromedio: t.ticketPromedio, promedioPorDia: t.promedioPorDia,
    diasConVenta: t.diasConVenta, descuentos: t.descuento,
    antes: { ventaNeta: tb.ventaNeta, tickets: tb.tickets, ticketPromedio: tb.ticketPromedio, promedioPorDia: tb.promedioPorDia },
    variacionVentaPct: variacion(t.ventaNeta, tb.ventaNeta),
    variacionTicketsPct: variacion(t.tickets, tb.tickets),
    variacionTicketPromedioPct: variacion(t.ticketPromedio, tb.ticketPromedio),
    porSucursal: a.porSucursal.map((s) => ({
      sucursal: s.nombre, ventaNeta: s.ventaNeta, tickets: s.tickets, ticketPromedio: s.ticketPromedio, participacionPct: s.participacion,
      ventaNetaAntes: sucB.get(s.sucursalId)?.ventaNeta ?? 0, ticketsAntes: sucB.get(s.sucursalId)?.tickets ?? 0,
      variacionVentaPct: variacion(s.ventaNeta, sucB.get(s.sucursalId)?.ventaNeta ?? 0),
    })),
    porDiaSemana: a.porDiaSemana.map((d) => ({ dia: DIAS[d.dia], promedioPorDia: d.promedioPorDia, tickets: d.tickets })),
    porHora: a.porHora.filter((h) => h.tickets > 0).map((h) => ({ hora: h.hora, ventaNeta: h.ventaNeta, tickets: h.tickets })),
    porMedioPago: a.porMedio.map((m) => ({ medio: m.medio, importeConIva: m.importe, pct: pct(m.importe, a.porMedio.reduce((x, y) => x + y.importe, 0)) })),
    porCajero: a.porCajero.slice(0, 12).map((x) => ({ cajero: x.nombre, tickets: x.tickets, ventaNeta: x.ventaNeta, ticketPromedio: x.ticketPromedio })),
  };
}

/* ============================== RENTABILIDAD ============================== */

export type Orden = 'venta' | 'margen' | 'margen_pct_menor' | 'margen_pct_mayor' | 'caida_margen' | 'perdida';

export async function rentabilidad(
  c: PoolClient, f: Filtro, contra: Filtro, lente: Lente,
  o: { orden?: Orden; limite?: number; buscar?: string | null; tipo?: 'granel' | 'entero' | null } = {},
) {
  const tipo = o.tipo ?? null;
  const [a, b, tb] = await enSerie(
    () => reporteMargenes(c, { ...f, tipo }, 'mes', lente),
    () => reporteMargenes(c, { ...contra, tipo }, 'mes', lente),
    () => sumaMargen(c, { ...contra, tipo }));
  const antes = new Map(b.filas.map((x) => [x.clave, x]));
  const total = a.totales.ventaNeta;
  /* Para «el peor margen» no cuentan las migas: al menos 0,2 % de la venta del período. */
  const piso = Math.max(total * 0.002, 1);
  let filas = a.filas.filter((x) => x.ventaNeta > 0 || (x.comprasNeto ?? 0) > 0).map((x) => {
    const p = antes.get(x.clave);
    return {
      ...(lente === 'producto' ? { productoId: x.clave } : {}),
      nombre: x.nombre, ventaNeta: x.ventaNeta, margen: x.margen, margenPct: x.margenPct, participacionPct: x.participacion,
      ...(x.unidades != null ? { cantidad: x.unidades } : {}),
      ...(x.comprasNeto != null ? { comprasNeto: x.comprasNeto } : {}),
      margenPctAntes: p?.margenPct ?? null,
      variacionVentaPct: variacion(x.ventaNeta, p?.ventaNeta ?? 0),
      ventaSinCosto: r2(x.ventaNeta - x.ventaCosteada),
    };
  });
  const buscar = String(o.buscar ?? '').trim().toLowerCase();
  if (buscar) filas = filas.filter((x) => x.nombre.toLowerCase().includes(buscar));
  const orden = o.orden ?? 'venta';
  const conMargen = (x: any) => x.margenPct != null && x.ventaNeta >= piso;
  if (orden === 'margen') filas.sort((x, y) => y.margen - x.margen);
  else if (orden === 'margen_pct_menor') filas = filas.filter(conMargen).sort((x, y) => x.margenPct! - y.margenPct!);
  else if (orden === 'margen_pct_mayor') filas = filas.filter(conMargen).sort((x, y) => y.margenPct! - x.margenPct!);
  else if (orden === 'perdida') filas = filas.filter((x) => x.margen < 0).sort((x, y) => x.margen - y.margen);
  else if (orden === 'caida_margen') {
    filas = filas.filter((x) => conMargen(x) && x.margenPctAntes != null)
      .sort((x, y) => (x.margenPct! - x.margenPctAntes!) - (y.margenPct! - y.margenPctAntes!));
  }
  const limite = Math.min(Math.max(o.limite ?? 15, 1), 60);
  const t = a.totales;
  return {
    periodo: `${f.desde} a ${f.hasta}`, comparadoCon: `${contra.desde} a ${contra.hasta}`, verPor: lente, orden, ...(tipo ? { tipo } : {}),
    totales: {
      ventaNeta: t.ventaNeta, margen: t.margen, margenPct: t.margenPct, ventaSinCosto: t.ventaSinCosto,
      margenPctAntes: tb.margenPct, variacionMargenPct: variacion(t.margen, tb.margen), variacionVentaPct: variacion(t.ventaNeta, tb.ventaNeta),
    },
    filas: filas.slice(0, limite),
    totalFilas: filas.length,
  };
}

/* ============================== GRANEL Y ENTEROS ============================== */

export async function granelYEnteros(c: PoolClient, f: Filtro) {
  const g = await reporteGranel(c, f, 'mes');
  const lado = (x: any) => ({
    ventaNeta: x.ventaNeta, margenPct: x.margenPct, participacionPct: x.participacion, participacionMargenPct: x.participacionMargen,
    variacionVentaPct: x.variacionVenta, margenPctAntes: x.anterior?.margenPct ?? null,
  });
  return {
    periodo: `${f.desde} a ${f.hasta}`,
    granel: {
      ...lado(g.granel), kgVendidos: r1(g.granel.cantidadBase), precioPorKg: g.granel.precioPorKg, precioPorKgAntes: g.granel.precioPorKgAnterior,
      enPaquetes: { ventaNeta: g.granel.fraccionado.ventaNeta, margenPct: g.granel.fraccionado.margenPct, pctDelGranel: g.granel.fraccionado.participacion },
      suelto: { ventaNeta: g.granel.suelto.ventaNeta, margenPct: g.granel.suelto.margenPct, pctDelGranel: g.granel.suelto.participacion },
    },
    enteros: lado(g.entero),
  };
}

/* ============================== FRACCIONADO ============================== */

/**
 * LA PRODUCCIÓN DE PAQUETES: cuánto se fraccionó (kg y paquetes), quién, las
 * correcciones (se cargaron de más) y los FALTANTES al corregir (paquetes que
 * no estaban: se dieron de baja como merma). Lo que se mide de verdad: el
 * sistema no pesa el granel antes y después, así que el «rinde» real es
 * kg empaquetados contra faltantes y correcciones.
 */
export async function fraccionado(c: PoolClient, f: Filtro, buscar?: string | null) {
  const params: any[] = [f.desde, f.hasta];
  let extra = '';
  if (f.sucursalId) { params.push(f.sucursalId); extra += ` AND f.sucursal_id = $${params.length}`; }
  if (buscar?.trim()) { params.push(`%${buscar.trim()}%`); extra += ` AND p.nombre ILIKE $${params.length}`; }
  const base = `FROM fraccionamientos f JOIN fraccionamiento_items fi ON fi.fraccionamiento_id = f.id JOIN productos p ON p.id = fi.producto_id
    WHERE ${enRango('f.fecha', 1)}${extra}`;
  const paramsMov: any[] = [f.desde, f.hasta];
  let extraMov = '';
  if (f.sucursalId) { paramsMov.push(f.sucursalId); extraMov += ` AND m.sucursal_id = $${paramsMov.length}`; }
  if (buscar?.trim()) { paramsMov.push(`%${buscar.trim()}%`); extraMov += ` AND p.nombre ILIKE $${paramsMov.length}`; }
  const [tot, porProducto, porTamano, porOperador, faltantes] = await enSerie(
    () => c.query(`SELECT
        coalesce(sum(fi.paquetes * fi.tam_kg) FILTER (WHERE f.origen <> 'correccion'), 0)::float8 AS kg,
        coalesce(sum(fi.paquetes) FILTER (WHERE f.origen <> 'correccion'), 0)::float8 AS paquetes,
        count(DISTINCT f.id) FILTER (WHERE f.origen <> 'correccion')::int AS registros,
        coalesce(-sum(fi.paquetes * fi.tam_kg) FILTER (WHERE f.origen = 'correccion'), 0)::float8 AS kg_corregidos,
        count(DISTINCT f.id) FILTER (WHERE f.origen = 'correccion')::int AS correcciones ${base}`, params),
    () => c.query(`SELECT p.nombre, coalesce(s.nombre, '') AS sucursal,
        sum(fi.paquetes * fi.tam_kg) FILTER (WHERE f.origen <> 'correccion')::float8 AS kg,
        sum(fi.paquetes) FILTER (WHERE f.origen <> 'correccion')::float8 AS paquetes,
        coalesce(-sum(fi.paquetes * fi.tam_kg) FILTER (WHERE f.origen = 'correccion'), 0)::float8 AS kg_corregidos
      ${base.replace('JOIN productos p ON p.id = fi.producto_id', 'JOIN productos p ON p.id = fi.producto_id LEFT JOIN sucursales s ON s.id = f.sucursal_id')}
      GROUP BY 1, 2 ORDER BY 3 DESC NULLS LAST LIMIT 25`, params),
    () => c.query(`SELECT fi.tam_kg::float8 AS tam, sum(fi.paquetes)::float8 AS paquetes, sum(fi.paquetes * fi.tam_kg)::float8 AS kg
      ${base} AND f.origen <> 'correccion' GROUP BY 1 ORDER BY 3 DESC`, params),
    () => c.query(`SELECT coalesce(o.nombre, 'Sin colaborador') AS nombre,
        count(DISTINCT ((f.fecha AT TIME ZONE '${ZONA}')::date, f.turno))::int AS turnos,
        sum(fi.paquetes * fi.tam_kg)::float8 AS kg, sum(fi.paquetes)::float8 AS paquetes
      ${base.replace('JOIN productos p ON p.id = fi.producto_id', 'JOIN productos p ON p.id = fi.producto_id LEFT JOIN fraccion_operadores o ON o.id = f.operador_id')}
        AND f.origen <> 'correccion' GROUP BY 1 ORDER BY 3 DESC`, params),
    () => c.query(`SELECT p.nombre, sum(m.cantidad * coalesce(pr.tam_kg, 1))::float8 AS kg, sum(m.cantidad)::float8 AS paquetes
      FROM movimientos m JOIN productos p ON p.id = m.producto_id LEFT JOIN presentaciones pr ON pr.id = m.presentacion_id
      WHERE m.tipo = 'merma' AND m.motivo LIKE 'Faltan al corregir el fraccionado%' AND ${enRango('m.fecha', 1)}${extraMov}
      GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, paramsMov));
  const t: any = tot.rows[0] ?? {};
  const kg = r1(N(t.kg));
  const kgFaltantes = r1(faltantes.rows.reduce((a: number, x: any) => a + N(x.kg), 0));
  return {
    periodo: `${f.desde} a ${f.hasta}`,
    kgFraccionados: kg, paquetes: r0(N(t.paquetes)), registros: N(t.registros),
    correcciones: N(t.correcciones), kgCorregidos: r1(N(t.kg_corregidos)),
    kgFaltantesAlCorregir: kgFaltantes, faltantesPctDeLoFraccionado: pct(kgFaltantes, kg),
    porProducto: porProducto.rows.filter((x: any) => N(x.kg) > 0 || N(x.kg_corregidos) > 0).map((x: any) => ({
      producto: x.nombre, sucursal: x.sucursal, kg: r1(N(x.kg)), paquetes: r0(N(x.paquetes)), kgCorregidos: r1(N(x.kg_corregidos)),
    })),
    porTamano: porTamano.rows.map((x: any) => ({ tamanoKg: N(x.tam), paquetes: r0(N(x.paquetes)), kg: r1(N(x.kg)) })),
    porColaborador: porOperador.rows.map((x: any) => ({
      colaborador: x.nombre, turnos: N(x.turnos), kg: r1(N(x.kg)), paquetes: r0(N(x.paquetes)),
      kgPorTurno: N(x.turnos) > 0 ? r1(N(x.kg) / N(x.turnos)) : null,
    })),
    faltantesAlCorregir: faltantes.rows.map((x: any) => ({ producto: x.nombre, kg: r1(N(x.kg)), paquetes: r0(N(x.paquetes)) })),
  };
}

/**
 * LOS PAQUETES DE CADA GRANEL: con lo vendido en `dias` (la tabla resumen) y el
 * stock de hoy, por producto y tamaño:
 *   · el precio por kg al que realmente se vendió cada tamaño y su margen;
 *   · cuántos días alcanza el stock de cada paquete y del granel suelto;
 *   · qué conviene fraccionar ya, qué está sobrefraccionado y dónde un paquete
 *     chico sale más barato por kg que uno grande (precio incoherente).
 */
export async function paquetes(c: PoolClient, dias: number, sucursalId: number | null, buscar?: string | null) {
  const hoy = hoyAr();
  const desde = sumarDias(hoy, -(dias - 1));
  const params: any[] = [desde, hoy];
  let sucV = ''; let sucS = ''; let filtroP = '';
  if (sucursalId) { params.push(sucursalId); sucV = ` AND m.sucursal_id = $${params.length}`; sucS = ` AND s.sucursal_id = $${params.length}`; }
  if (buscar?.trim()) { params.push(`%${buscar.trim()}%`); filtroP = ` AND p.nombre ILIKE $${params.length}`; }
  const r = await c.query(
    `WITH v AS (
       SELECT m.producto_id, coalesce(m.presentacion_id, 0) AS pres, sum(m.unidades) AS u, sum(m.cantidad_base) AS kg,
         sum(m.venta_neta) AS vn, sum(m.venta_costeada) AS vc, sum(m.costo) AS co
       FROM metricas_venta_prod_dia m WHERE m.granel AND m.dia BETWEEN $1::date AND $2::date${sucV} GROUP BY 1, 2),
     st AS (
       SELECT s.producto_id, coalesce(s.presentacion_id, 0) AS pres, sum(s.cantidad) AS cant
       FROM stock s WHERE s.estado = 'disponible'${sucS} GROUP BY 1, 2)
     SELECT coalesce(v.producto_id, st.producto_id) AS producto_id, coalesce(v.pres, st.pres) AS pres, p.nombre,
       pr.tam_kg::float8 AS tam, coalesce(v.u, 0)::float8 AS u, coalesce(v.kg, 0)::float8 AS kg, coalesce(v.vn, 0)::float8 AS vn,
       coalesce(v.vc, 0)::float8 AS vc, coalesce(v.co, 0)::float8 AS co, coalesce(st.cant, 0)::float8 AS stock
     FROM v FULL JOIN st ON st.producto_id = v.producto_id AND st.pres = v.pres
     JOIN productos p ON p.id = coalesce(v.producto_id, st.producto_id) AND p.tipo = 'granel' AND p.estado <> 'archivado'${filtroP}
     LEFT JOIN presentaciones pr ON pr.id = coalesce(v.pres, st.pres)`, params);

  type Fila = { pres: number; tam: number | null; u: number; kg: number; vn: number; vc: number; co: number; stock: number };
  const prods = new Map<number, { nombre: string; filas: Fila[] }>();
  for (const x of r.rows as any[]) {
    const id = N(x.producto_id);
    const p = prods.get(id) ?? { nombre: x.nombre as string, filas: [] as Fila[] };
    p.filas.push({ pres: N(x.pres), tam: x.tam == null ? null : N(x.tam), u: N(x.u), kg: N(x.kg), vn: N(x.vn), vc: N(x.vc), co: N(x.co), stock: N(x.stock) });
    prods.set(id, p);
  }

  const aFraccionar: any[] = []; const sinGranel: any[] = []; const sobrefraccionado: any[] = []; const precioIncoherente: any[] = [];
  const porTam = new Map<number, { kg: number; vn: number; vc: number; co: number }>();
  const productos: any[] = [];
  for (const [id, p] of prods) {
    const suelto = p.filas.find((x) => x.pres === 0);
    const packs = p.filas.filter((x) => x.pres > 0 && x.tam && x.tam > 0).sort((a, b) => a.tam! - b.tam!);
    const kgDia = p.filas.reduce((a, x) => a + x.kg, 0) / dias;
    const granelKg = suelto?.stock ?? 0;
    const diasGranel = kgDia > 0 ? Math.round(granelKg / kgDia) : null;
    const vn = p.filas.reduce((a, x) => a + x.vn, 0);
    for (const x of packs) {
      const t = porTam.get(x.tam!) ?? { kg: 0, vn: 0, vc: 0, co: 0 };
      t.kg += x.kg; t.vn += x.vn; t.vc += x.vc; t.co += x.co;
      porTam.set(x.tam!, t);
      const uDia = x.u / dias;
      const cobertura = uDia > 0 ? Math.round(x.stock / uDia) : null;
      /* Fraccionar ya: se vende y alcanza para menos de una semana. Lo que falta para 14 días, en kg. */
      if (uDia > 0 && cobertura != null && cobertura < 7) {
        const kgPara14 = r1(Math.max(0, uDia * 14 - x.stock) * x.tam!);
        const item = { productoId: id, presentacionId: x.pres, producto: p.nombre, tamanoKg: x.tam, stockPaquetes: r0(x.stock), vendePorDia: r1(uDia), diasQueAlcanza: cobertura, kgParaDosSemanas: kgPara14, granelSueltoKg: r1(granelKg) };
        if (granelKg + 1e-9 >= kgPara14 * 0.5) aFraccionar.push(item); else sinGranel.push(item);
      }
      /* Sobrefraccionado: paquetes que no rotan (más de 90 días de stock, o stock sin ventas). */
      if (x.stock > 0 && (cobertura == null || cobertura > 90)) {
        sobrefraccionado.push({ productoId: id, presentacionId: x.pres, producto: p.nombre, tamanoKg: x.tam, stockPaquetes: r0(x.stock), kgEnPaquetes: r1(x.stock * x.tam!), diasQueAlcanza: cobertura, vendePorDia: r1(uDia) });
      }
    }
    /* Un tamaño más chico vendido MÁS BARATO por kg que uno más grande (con al menos 3 % de diferencia). */
    const vendidos = packs.filter((x) => x.kg > 0 && x.vn > 0);
    for (let i = 0; i < vendidos.length; i++) {
      for (let j = i + 1; j < vendidos.length; j++) {
        const chico = vendidos[i]; const grande = vendidos[j];
        const pkChico = chico.vn / chico.kg; const pkGrande = grande.vn / grande.kg;
        if (pkChico < pkGrande * 0.97) {
          precioIncoherente.push({
            producto: p.nombre, chicoKg: chico.tam, precioPorKgChico: r0(pkChico), grandeKg: grande.tam, precioPorKgGrande: r0(pkGrande),
            diferenciaPct: r1((pkChico / pkGrande - 1) * 100),
          });
        }
      }
    }
    if (vn > 0 || granelKg > 0) {
      productos.push({
        producto: p.nombre, ventaNeta: r0(vn), kgPorDia: r1(kgDia), granelSueltoKg: r1(granelKg), diasDeGranel: diasGranel,
        tamanos: [...(suelto && (suelto.kg > 0 || suelto.stock > 0) ? [{ tamanoKg: 'suelto', ...economia(suelto, dias) }] : []),
          ...packs.map((x) => ({ tamanoKg: x.tam, ...economia(x, dias), stockPaquetes: r0(x.stock), diasQueAlcanza: x.u > 0 ? Math.round(x.stock / (x.u / dias)) : null }))],
      });
    }
  }
  productos.sort((a, b) => b.ventaNeta - a.ventaNeta);
  return {
    ultimosDias: dias, ...(sucursalId ? { sucursalId } : { sucursal: 'todas' }),
    margenPorTamano: [...porTam.entries()].filter(([, t]) => t.kg > 0).sort((a, b) => a[0] - b[0]).map(([tam, t]) => ({
      tamanoKg: tam, kgVendidos: r1(t.kg), ventaNeta: r0(t.vn), precioPorKg: t.kg > 0 ? r0(t.vn / t.kg) : null, margen: r0(t.vc - t.co), margenPct: pct(t.vc - t.co, t.vc),
    })),
    aFraccionar: aFraccionar.sort((a, b) => a.diasQueAlcanza - b.diasQueAlcanza || b.vendePorDia - a.vendePorDia).slice(0, 20),
    sinGranelParaFraccionar: sinGranel.sort((a, b) => b.vendePorDia - a.vendePorDia).slice(0, 15),
    sobrefraccionado: sobrefraccionado.sort((a, b) => b.kgEnPaquetes - a.kgEnPaquetes).slice(0, 15),
    precioPorKgIncoherente: precioIncoherente.sort((a, b) => a.diferenciaPct - b.diferenciaPct).slice(0, 15),
    productos: productos.slice(0, buscar ? 10 : 15),
  };
}

const economia = (x: { u: number; kg: number; vn: number; vc: number; co: number }, dias: number) => ({
  vendePorDia: r1(x.u / dias), kgVendidos: r1(x.kg), ventaNeta: r0(x.vn),
  precioPorKg: x.kg > 0 ? r0(x.vn / x.kg) : null, margen: r0(x.vc - x.co), margenPct: pct(x.vc - x.co, x.vc),
});

/* ============================== STOCK ============================== */

export async function stock(f: Fuentes, sucursalId: number | null, estado?: 'parado' | 'por_agotarse' | 'sobrestock' | null, limite = 15) {
  const v = await f.metricas.stockValorizado(sucursalId, 30);
  const lista = v.lista.filter((x) => !x.deCoffit);
  const valor = lista.reduce((a, x) => a + x.valor, 0);
  const de = (e: string) => lista.filter((x) => x.estado === e);
  const parado = de('parado'); const agotarse = de('por_agotarse'); const sobre = de('sobrestock');
  const fila = (x: any) => ({
    productoId: x.productoId, producto: x.nombre, unidad: x.unidad, stock: x.stock, valor: r0(x.valor), vendePorDia: x.promedioPorDia, diasDeStock: x.diasDeStock,
    ...(x.estado === 'parado' ? { ultimaVenta: x.ultimaVenta } : {}),
  });
  const lim = Math.min(Math.max(limite, 1), 50);
  return {
    ...(sucursalId ? { sucursalId } : { sucursal: 'todas' }), ventanaDias: 30,
    resumen: {
      valorACosto: r0(valor), valorParado: r0(parado.reduce((a, x) => a + x.valor, 0)),
      pctParado: pct(parado.reduce((a, x) => a + x.valor, 0), valor),
      productosPorAgotarse: agotarse.length, valorSobrestock: r0(sobre.reduce((a, x) => a + x.valor, 0)),
    },
    ...(estado == null || estado === 'por_agotarse' ? { porAgotarse: agotarse.sort((a, b) => b.promedioPorDia * (b.costoUnitario || 1) - a.promedioPorDia * (a.costoUnitario || 1)).slice(0, lim).map(fila) } : {}),
    ...(estado == null || estado === 'parado' ? { parado: parado.sort((a, b) => b.valor - a.valor).slice(0, lim).map(fila) } : {}),
    ...(estado == null || estado === 'sobrestock' ? { sobrestock: sobre.sort((a, b) => b.valor - a.valor).slice(0, Math.min(lim, 10)).map(fila) } : {}),
  };
}

/* ============================== COSTOS Y PRECIOS ============================== */

/**
 * COSTOS QUE SUBIERON (del proveedor que fija el precio) en los últimos `dias`.
 * Con markup el precio sigue solo al costo; el riesgo es el PRECIO FIJO: si el
 * producto tiene listas con precio fijo y no cambió de precio después de la
 * suba, el margen se está comiendo.
 */
export async function costosQueSubieron(c: PoolClient, dias: number) {
  /* La suba ACUMULADA del período (el costo antes del primer cambio contra el último): un
   * cambio posterior sin suba (una importación masiva) no la esconde. La fecha es la de la
   * última suba: el precio tuvo que cambiar después de esa. */
  const r = await c.query(
    `WITH h AS (
       SELECT pp.producto_id, pp.proveedor_id, h.fecha,
         coalesce(nullif(h.costo_final_anterior, 0), h.costo_anterior) AS antes, coalesce(nullif(h.costo_final, 0), h.costo) AS ahora
       FROM producto_proveedor_costos h JOIN producto_proveedores pp ON pp.id = h.producto_proveedor_id
       WHERE h.fecha >= now() - ($1::int * interval '1 day') AND pp.usar_para_precio),
     a AS (
       SELECT producto_id, min(proveedor_id) AS proveedor_id,
         (array_agg(antes ORDER BY fecha) FILTER (WHERE antes > 0))[1] AS antes, (array_agg(ahora ORDER BY fecha DESC))[1] AS ahora,
         max(fecha) FILTER (WHERE ahora > antes) AS fecha
       FROM h GROUP BY producto_id)
     SELECT p.nombre, pv.nombre AS proveedor, to_char(a.fecha AT TIME ZONE '${ZONA}', 'YYYY-MM-DD') AS fecha,
       a.antes::float8, a.ahora::float8,
       (SELECT count(*) FROM producto_listas pl WHERE pl.producto_id = a.producto_id AND pl.modo_precio = 'precio')::int AS fijos,
       coalesce((SELECT max(ph.fecha) FROM precio_historial ph WHERE ph.producto_id = a.producto_id) > a.fecha, false) AS precio_despues
     FROM a JOIN productos p ON p.id = a.producto_id LEFT JOIN proveedores pv ON pv.id = a.proveedor_id
     WHERE a.antes > 0 AND a.fecha IS NOT NULL AND a.ahora > a.antes * 1.03 AND p.estado <> 'archivado'
     ORDER BY a.ahora / a.antes DESC LIMIT 40`, [Math.min(Math.max(dias, 1), 365)]);
  const filas = r.rows.map((x: any) => ({
    producto: x.nombre, proveedor: x.proveedor ?? '', fecha: x.fecha, costoAntes: r2(N(x.antes)), costoAhora: r2(N(x.ahora)),
    subaPct: r1((N(x.ahora) / N(x.antes) - 1) * 100), listasConPrecioFijo: N(x.fijos), precioCambioDespues: !!x.precio_despues,
  }));
  return {
    ultimosDias: dias,
    subas: filas,
    /* Los que pueden estar comiéndose el margen: precio fijo y sin cambio de precio desde la suba. */
    sinTrasladar: filas.filter((x) => x.listasConPrecioFijo > 0 && !x.precioCambioDespues),
  };
}

/* ============================== CAJA ============================== */

export async function caja(c: PoolClient, f: Filtro) {
  const params: any[] = [f.desde, f.hasta];
  const suc = f.sucursalId ? (params.push(f.sucursalId), ` AND cs.sucursal_id = $${params.length}`) : '';
  const [turnos, egresos] = await enSerie(
    () => c.query(
      `SELECT su.nombre AS sucursal, coalesce(uc.nombre, ua.nombre, '') AS cajero, cs.diferencia::float8 AS dif
       FROM caja_sesiones cs JOIN sucursales su ON su.id = cs.sucursal_id
       LEFT JOIN usuarios ua ON ua.id = cs.usuario_id
       LEFT JOIN LATERAL (SELECT cc.usuario_id FROM caja_controles cc WHERE cc.caja_sesion_id = cs.id
         AND cc.observaciones LIKE 'Cierre por envío%' ORDER BY cc.id DESC LIMIT 1) cx ON true
       LEFT JOIN usuarios uc ON uc.id = cx.usuario_id
       WHERE cs.cierre IS NOT NULL AND ${enRango('cs.cierre', 1)}${suc}`, params),
    () => c.query(
      `SELECT coalesce(co.nombre, CASE WHEN pp.id IS NOT NULL THEN 'Pago a proveedor' WHEN m.motivo LIKE 'Devolución %' THEN 'Devoluciones a clientes'
         ELSE 'A mano (sin concepto)' END) AS que, count(*)::int AS veces, sum(m.importe)::float8 AS importe
       FROM caja_movimientos m JOIN caja_sesiones cs ON cs.id = m.caja_sesion_id
       LEFT JOIN cashflow_conceptos co ON co.id = m.concepto_id
       LEFT JOIN proveedor_pagos pp ON pp.caja_movimiento_id = m.id
       WHERE m.tipo = 'egreso' AND m.anulado_en IS NULL AND ${enRango('m.fecha', 1)}${suc}
       GROUP BY 1 ORDER BY 3 DESC LIMIT 15`, params));
  /* Una diferencia de menos de $100 es redondeo: no cuenta como faltante ni sobrante. */
  const agrupar = (clave: (x: any) => string) => {
    const m = new Map<string, { turnos: number; faltantes: number; sumaFaltantes: number; sobrantes: number; sumaSobrantes: number; neto: number }>();
    for (const x of turnos.rows as any[]) {
      const k = clave(x) || 'Sin nombre';
      const a = m.get(k) ?? { turnos: 0, faltantes: 0, sumaFaltantes: 0, sobrantes: 0, sumaSobrantes: 0, neto: 0 };
      const d = N(x.dif);
      a.turnos++; a.neto += d;
      if (d <= -100) { a.faltantes++; a.sumaFaltantes += d; } else if (d >= 100) { a.sobrantes++; a.sumaSobrantes += d; }
      m.set(k, a);
    }
    return [...m.entries()].map(([nombre, a]) => ({ nombre, ...a, sumaFaltantes: r0(a.sumaFaltantes), sumaSobrantes: r0(a.sumaSobrantes), neto: r0(a.neto) }))
      .sort((a, b) => a.neto - b.neto);
  };
  const totalEgresos = egresos.rows.reduce((a: number, x: any) => a + N(x.importe), 0);
  return {
    periodo: `${f.desde} a ${f.hasta}`, turnosCerrados: turnos.rows.length,
    nota: 'Diferencia = lo contado menos lo que el sistema esperaba: negativo es faltante. Menos de $100 no cuenta.',
    porCajero: agrupar((x) => x.cajero),
    porSucursal: agrupar((x) => x.sucursal),
    egresosPorConcepto: egresos.rows.map((x: any) => ({ que: x.que, veces: N(x.veces), importe: r0(N(x.importe)), pct: pct(N(x.importe), totalEgresos) })),
  };
}

/* ============================== GASTOS ============================== */

export async function gastos(f: Fuentes, desde: string, hasta: string, sucursalId: number | null) {
  const r: any = await f.gastos.resumen({ desde, hasta, sucursalId: sucursalId ?? undefined, negocio: 'distribuidora' });
  return {
    periodo: `${desde} a ${hasta}`, nota: 'Importes con IVA, por fecha del comprobante. Solo la distribuidora (Coffit aparte).',
    total: r.total, neto: r.neto, fijos: r.porTipo.fijos, variables: r.porTipo.variables, faltaPagar: r.saldo,
    porRubro: r.porCategoria.slice(0, 15).map((x: any) => ({ rubro: x.nombre, tipo: x.tipo, total: r0(x.total), comprobantes: x.cantidad })),
  };
}

/* ============================== RESULTADOS ============================== */

/** El estado de resultados de cada mes (todo neto), con el punto de equilibrio calculado igual que la pantalla. */
export async function resultados(f: Fuentes, desdeMes: string, hastaMes: string) {
  const e: any = await f.resultados.estado({ desde: desdeMes, hasta: hastaMes });
  const objetivo = (mes: string) => e.objetivos.find((o: any) => o.mes === mes && (o.sucursalId == null || o.sucursalId === 0)) ?? null;
  return {
    nota: 'Todo neto (sin IVA). El mes en curso va hasta hoy. Punto de equilibrio = fijos ÷ (contribución ÷ ventas).',
    meses: e.meses.map((m: any) => {
      const c = m.total.cascada;
      const contribPct = c.ventasNetas > 0 ? c.contribucion / c.ventasNetas : 0;
      /* Sin gastos fijos cargados no hay equilibrio que calcular (daría $0, que confunde). */
      const equilibrio = contribPct > 0 && c.totalFijos > 0 ? r0(c.totalFijos / contribPct) : null;
      const o = objetivo(m.mes);
      return {
        mes: m.mes, enCurso: m.mes === e.mesEnCurso,
        ventasNetas: r0(c.ventasNetas), margenBruto: r0(c.margenBruto), margenBrutoPct: pct(c.margenBruto, c.ventasNetas),
        gastosVariables: r0(c.totalVariables), contribucion: r0(c.contribucion), contribucionPct: pct(c.contribucion, c.ventasNetas),
        gastosFijos: r0(c.totalFijos), resultadoOperativo: r0(c.operativo), antesDeGanancias: r0(c.antesGanancias), resultadoNeto: r0(m.neto ?? c.antesGanancias),
        puntoDeEquilibrio: equilibrio, margenDeSeguridadPct: equilibrio && c.ventasNetas > 0 ? pct(c.ventasNetas - equilibrio, c.ventasNetas) : null,
        ...(o ? { objetivoVenta: o.ventaNeta ?? null, objetivoResultado: o.resultado ?? null } : {}),
      };
    }),
    avisos: (e.avisos ?? []).slice(0, 6).map((a: any) => a.texto),
  };
}

/* ============================== OFERTAS ============================== */

export async function ofertas(c: PoolClient, f: Filtro) {
  const r: any = await reporteOfertas(c, f);
  const d = r.desglose ?? {};
  return {
    periodo: `${f.desde} a ${f.hasta}`,
    descuentosPctDeLaVenta: d.pctDescuentos ?? null,
    ofertas: (r.ofertas ?? []).slice(0, 25).map((o: any) => ({
      oferta: o.nombre, estado: o.estado, veredicto: o.veredicto, vendidoNeto: r0(o.vendido?.neto), descuento: r0(o.vendido?.descuento),
      ganancia: o.vendido?.ganancia != null ? r0(o.vendido.ganancia) : null, margenPct: o.vendido?.margenPct ?? null,
      pctDelStockVendido: o.stock?.pctVendido ?? null,
    })).sort((a: any, b: any) => (a.ganancia ?? 0) - (b.ganancia ?? 0)),
  };
}

/* ============================== QUÉ CAMBIÓ ============================== */

/** Lo que más subió y más bajó entre dos períodos, por producto y por categoría. */
export async function comparar(c: PoolClient, a: Filtro, b: Filtro) {
  const r: any = await reporteComparar(c, a, b, 'mes');
  const prod = (x: any) => ({
    productoId: x.productoId, producto: x.nombre, ventaA: r0(x.a), ventaB: r0(x.b), cantidadA: r1(x.cantidadA), cantidadB: r1(x.cantidadB), diferencia: r0(x.diferencia), variacionPct: x.variacion,
  });
  return {
    periodoA: `${a.desde} a ${a.hasta}`, periodoB: `${b.desde} a ${b.hasta}`,
    ventaA: r0(r.a?.ventaNeta), ventaB: r0(r.b?.ventaNeta), margenPctA: r.a?.margenPct ?? null, margenPctB: r.b?.margenPct ?? null,
    porCategoria: (r.porCategoria ?? []).slice(0, 10).map((x: any) => ({
      categoria: x.nombre, ventaA: r0(x.a), ventaB: r0(x.b), variacionPct: x.variacion, margenPctA: x.margenPctA, margenPctB: x.margenPctB,
    })),
    productosQueSuben: (r.productos?.suben ?? []).slice(0, 10).map(prod),
    productosQueBajan: (r.productos?.bajan ?? []).slice(0, 10).map(prod),
  };
}

/* ============================== UN PRODUCTO ============================== */

/** Hasta 5 productos que coinciden con el texto: todo lo que hace falta para opinar de uno. */
export async function producto(c: PoolClient, texto: string) {
  const t = String(texto ?? '').trim();
  if (t.length < 2) return { error: 'Escribí al menos 2 letras del producto.' };
  const hoy = hoyAr(); const d30 = sumarDias(hoy, -29); const d60 = sumarDias(hoy, -59);
  const ps = await c.query(
    `SELECT p.id, p.nombre, p.tipo::text AS tipo, p.merma::float8 AS merma, p.estado::text AS estado, coalesce(cat.nombre, '') AS categoria, coalesce(m.nombre, '') AS marca
     FROM productos p LEFT JOIN categorias cat ON cat.id = p.categoria_id LEFT JOIN marcas m ON m.id = p.marca_id
     WHERE p.nombre ILIKE $1 AND p.estado <> 'archivado'
     ORDER BY (SELECT coalesce(sum(v.venta_neta), 0) FROM metricas_venta_prod_dia v WHERE v.producto_id = p.id AND v.dia >= $2::date) DESC, p.nombre
     LIMIT 5`, [`%${t}%`, d60]);
  if (!ps.rows.length) return { encontrados: 0, aviso: `No hay productos que digan «${t}».` };
  const ids = ps.rows.map((x: any) => N(x.id));
  const [provs, st, vend, cost, prec, fijos] = await enSerie(
    () => c.query(`SELECT pp.producto_id, pv.nombre, coalesce(nullif(pp.costo_final, 0), pp.costo / greatest(pp.cantidad, 1))::float8 AS costo, pp.usar_para_precio FROM producto_proveedores pp
      JOIN proveedores pv ON pv.id = pp.proveedor_id WHERE pp.producto_id = ANY($1)`, [ids]),
    () => c.query(`SELECT s.producto_id, su.nombre AS sucursal, coalesce(pr.tam_kg, 0)::float8 AS tam, s.estado::text AS estado, sum(s.cantidad)::float8 AS cant
      FROM stock s JOIN sucursales su ON su.id = s.sucursal_id LEFT JOIN presentaciones pr ON pr.id = s.presentacion_id
      WHERE s.producto_id = ANY($1) AND abs(s.cantidad) > 1e-9 GROUP BY 1, 2, 3, 4`, [ids]),
    () => c.query(`SELECT v.producto_id, coalesce(pr.tam_kg, 0)::float8 AS tam, (v.dia >= $2::date) AS reciente,
        sum(v.unidades)::float8 AS u, sum(v.cantidad_base)::float8 AS kg, sum(v.venta_neta)::float8 AS vn, sum(v.venta_costeada)::float8 AS vc, sum(v.costo)::float8 AS co
      FROM metricas_venta_prod_dia v LEFT JOIN presentaciones pr ON pr.id = v.presentacion_id
      WHERE v.producto_id = ANY($1) AND v.dia >= $3::date GROUP BY 1, 2, 3`, [ids, d30, d60]),
    () => c.query(`SELECT * FROM (SELECT pp.producto_id, to_char(h.fecha AT TIME ZONE '${ZONA}', 'YYYY-MM-DD') AS fecha,
        coalesce(nullif(h.costo_final_anterior, 0), h.costo_anterior)::float8 AS antes, coalesce(nullif(h.costo_final, 0), h.costo)::float8 AS ahora,
        row_number() OVER (PARTITION BY pp.producto_id ORDER BY h.fecha DESC) AS n
      FROM producto_proveedor_costos h JOIN producto_proveedores pp ON pp.id = h.producto_proveedor_id
      WHERE pp.producto_id = ANY($1) AND pp.usar_para_precio) x WHERE n <= 3`, [ids]),
    () => c.query(`SELECT * FROM (SELECT ph.producto_id, coalesce(lv.nombre, '') AS lista, to_char(ph.fecha AT TIME ZONE '${ZONA}', 'YYYY-MM-DD') AS fecha,
        ph.precio::float8, ph.precio_anterior::float8 AS antes, row_number() OVER (PARTITION BY ph.producto_id, ph.lista_id ORDER BY ph.fecha DESC) AS n
      FROM precio_historial ph LEFT JOIN listas_venta lv ON lv.id = ph.lista_id WHERE ph.producto_id = ANY($1)) x WHERE n = 1`, [ids]),
    () => c.query(`SELECT pl.producto_id, coalesce(lv.nombre, '') || coalesce(' · ' || pr.tam_kg || ' kg', '') AS lista
      FROM producto_listas pl LEFT JOIN listas_venta lv ON lv.id = pl.lista_id LEFT JOIN presentaciones pr ON pr.id = pl.presentacion_id
      WHERE pl.producto_id = ANY($1) AND pl.modo_precio = 'precio'`, [ids]));
  const de = <T>(rows: T[], id: number) => rows.filter((x: any) => N(x.producto_id) === id);
  return {
    encontrados: ps.rows.length,
    productos: ps.rows.map((p: any) => {
      const id = N(p.id);
      const unidad = p.tipo === 'granel' ? 'kg' : 'u.';
      const ventas = (reciente: boolean) => de(vend.rows as any[], id).filter((x) => x.reciente === reciente).map((x) => ({
        tamano: x.tam > 0 ? `${x.tam} kg` : unidad === 'kg' ? 'suelto' : 'unidad',
        cantidad: r1(x.u), kg: unidad === 'kg' ? r1(x.kg) : undefined, ventaNeta: r0(x.vn), margen: r0(x.vc - x.co), margenPct: pct(x.vc - x.co, x.vc),
        precioPorKg: unidad === 'kg' && x.kg > 0 ? r0(x.vn / x.kg) : undefined,
      }));
      return {
        producto: p.nombre, tipo: p.tipo, categoria: p.categoria, marca: p.marca, estado: p.estado,
        ...(p.tipo === 'granel' ? { mermaPct: r1(N(p.merma) * 100) } : {}),
        /* «suCostoArmaElPrecio»: es el proveedor cuyo costo se usa para calcular el precio (NO quiere decir precio fijo). */
        proveedores: de(provs.rows as any[], id).map((x) => ({ proveedor: x.nombre, costoNeto: r2(N(x.costo)), suCostoArmaElPrecio: !!x.usar_para_precio })),
        listasConPrecioFijo: de(fijos.rows as any[], id).map((x) => x.lista),
        stock: de(st.rows as any[], id).map((x) => ({ sucursal: x.sucursal, tamano: x.tam > 0 ? `${x.tam} kg` : unidad === 'kg' ? 'granel suelto (kg)' : 'unidades', estado: x.estado, cantidad: r1(x.cant) })),
        ventasUltimos30Dias: ventas(true),
        ventas30DiasAnteriores: ventas(false),
        cambiosDeCosto: de(cost.rows as any[], id).map((x) => ({ fecha: x.fecha, antes: r2(x.antes), ahora: r2(x.ahora) })),
        ultimoPrecioPorLista: de(prec.rows as any[], id).map((x) => ({ lista: x.lista, fecha: x.fecha, precioConIva: r2(x.precio), antes: x.antes != null ? r2(x.antes) : null })),
      };
    }),
  };
}
