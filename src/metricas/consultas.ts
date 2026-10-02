/**
 * MÉTRICAS · LAS CONSULTAS (0122, 29/9/2026)
 * ============================================================================
 * TODAS leen las tablas resumen `metricas_*`, NUNCA las ventas una por una: por
 * eso tardan lo mismo con un mes que con diez años de historia. Corren en una
 * transacción de SOLO LECTURA con tope de tiempo (ver `leer` en el módulo).
 *
 * Los criterios son los de Gerencia › Rentabilidad: margen real = venta de los
 * renglones CON costo congelado − ese costo. Lo que no tiene costo no se
 * inventa: se cuenta aparte en `cobertura`.
 */
import type { PoolClient } from 'pg';
import { sumarDias } from '../cafeteria/cuenta';

export const PASOS = { dia: 'day', semana: 'week', mes: 'month' } as const;
export type Paso = keyof typeof PASOS;
export const LENTES = ['producto', 'categoria', 'marca', 'proveedor', 'lista', 'sucursal'] as const;
export type Lente = (typeof LENTES)[number];

/** Granel (fraccionado o suelto) o enteros: el tipo que tenía el producto al sincronizar (0123). */
export const TIPOS = ['granel', 'entero'] as const;
export type TipoVenta = (typeof TIPOS)[number];

export interface Filtro { desde: string; hasta: string; sucursalId: number | null; tipo?: TipoVenta | null }

export const N = (x: unknown) => Number(x ?? 0) || 0;
export const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
export const pct = (parte: number, base: number) => (base > 0 ? r2((parte / base) * 100) : null);
export const variacion = (ahora: number, antes: number) => (antes > 0 ? r2(((ahora - antes) / antes) * 100) : null);

const MS_DIA = 86_400_000;
const diasEntre = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MS_DIA);

/** El período inmediatamente anterior, del mismo largo: contra qué se compara. */
export function periodoAnterior(f: Filtro): Filtro {
  const n = diasEntre(f.desde, f.hasta) + 1;
  return { desde: sumarDias(f.desde, -n), hasta: sumarDias(f.desde, -1), sucursalId: f.sucursalId, tipo: f.tipo ?? null };
}

/** Todos los períodos (inicio) entre dos días, para que un día sin ventas figure en cero y no desaparezca del gráfico. */
export function periodos(desde: string, hasta: string, paso: Paso): string[] {
  const out: string[] = [];
  const d = new Date(`${desde}T12:00:00Z`);
  if (paso === 'semana') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // lunes, como date_trunc('week')
  if (paso === 'mes') d.setUTCDate(1);
  const fin = new Date(`${hasta}T12:00:00Z`);
  while (d <= fin) {
    out.push(d.toISOString().slice(0, 10));
    if (paso === 'dia') d.setUTCDate(d.getUTCDate() + 1);
    else if (paso === 'semana') d.setUTCDate(d.getUTCDate() + 7);
    else d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

/**
 * Parámetros y filtro de sucursal ($3 solo si hay). `a` es el alias de la tabla.
 * `conTipo`: solo para `metricas_venta_prod_dia`, la única que sabe si lo vendido es granel.
 */
export const donde = (f: Filtro, a: string, conTipo = false) => ({
  sql: `${a}.dia BETWEEN $1::date AND $2::date${f.sucursalId ? ` AND ${a}.sucursal_id = $3` : ''}`
    + (conTipo && f.tipo ? ` AND ${f.tipo === 'granel' ? '' : 'NOT '}${a}.granel` : ''),
  params: f.sucursalId ? [f.desde, f.hasta, f.sucursalId] : [f.desde, f.hasta],
});

/* ============================== VENTAS ============================== */

const sumaVentas = async (c: PoolClient, f: Filtro) => {
  const w = donde(f, 'd');
  const r = await c.query(
    `SELECT coalesce(sum(d.tickets), 0)::float8 AS tickets, coalesce(sum(d.notas), 0)::float8 AS notas,
       coalesce(sum(d.venta_neta), 0) AS venta_neta, coalesce(sum(d.descuento), 0) AS descuento,
       coalesce(sum(d.iva), 0) AS iva, coalesce(sum(d.total), 0) AS total,
       count(DISTINCT d.dia) FILTER (WHERE d.tickets > 0)::float8 AS dias
     FROM metricas_venta_dia d WHERE ${w.sql}`, w.params);
  const x = r.rows[0];
  const t = {
    tickets: N(x.tickets), notas: N(x.notas), ventaNeta: r2(N(x.venta_neta)), descuento: r2(N(x.descuento)),
    iva: r2(N(x.iva)), total: r2(N(x.total)), diasConVenta: N(x.dias),
  };
  return { ...t, ticketPromedio: t.tickets > 0 ? r2(t.ventaNeta / t.tickets) : 0, promedioPorDia: t.diasConVenta > 0 ? r2(t.ventaNeta / t.diasConVenta) : 0 };
};

export async function reporteVentas(c: PoolClient, f: Filtro, paso: Paso) {
  const w = donde(f, 'd');
  const wh = donde(f, 'h');
  const wp = donde(f, 'p');
  const wc = donde(f, 'k');
  const ant = periodoAnterior(f);
  const trunc = PASOS[paso];

  const [serie, totales, anterior, sucs, horas, semana, cajeros, medios, clientes] = await Promise.all([
    c.query(
      `SELECT to_char(date_trunc('${trunc}', d.dia), 'YYYY-MM-DD') AS periodo, sum(d.tickets)::float8 AS tickets,
         sum(d.venta_neta) AS venta_neta, sum(d.total) AS total
       FROM metricas_venta_dia d WHERE ${w.sql} GROUP BY 1 ORDER BY 1`, w.params),
    sumaVentas(c, f),
    sumaVentas(c, ant),
    c.query(
      `SELECT d.sucursal_id, coalesce(s.nombre, 'Sin sucursal') AS nombre, sum(d.tickets)::float8 AS tickets,
         sum(d.venta_neta) AS venta_neta, sum(d.total) AS total
       FROM metricas_venta_dia d LEFT JOIN sucursales s ON s.id = d.sucursal_id
       WHERE ${w.sql} GROUP BY 1, 2 ORDER BY 4 DESC`, w.params),
    c.query(
      `SELECT h.hora::int AS hora, sum(h.tickets)::float8 AS tickets, sum(h.venta_neta) AS venta_neta
       FROM metricas_venta_hora h WHERE ${wh.sql} GROUP BY 1 ORDER BY 1`, wh.params),
    c.query(
      `SELECT extract(isodow FROM d.dia)::int AS dow, sum(d.tickets)::float8 AS tickets, sum(d.venta_neta) AS venta_neta,
         count(DISTINCT d.dia)::float8 AS dias
       FROM metricas_venta_dia d WHERE ${w.sql} GROUP BY 1 ORDER BY 1`, w.params),
    c.query(
      `SELECT d.usuario_id, coalesce(u.nombre, 'Sin usuario') AS nombre, sum(d.tickets)::float8 AS tickets,
         sum(d.venta_neta) AS venta_neta
       FROM metricas_venta_dia d LEFT JOIN usuarios u ON u.id = d.usuario_id
       WHERE ${w.sql} GROUP BY 1, 2 ORDER BY 4 DESC`, w.params),
    c.query(
      `SELECT p.medio, sum(p.importe) AS importe, sum(p.cantidad)::float8 AS cantidad
       FROM metricas_venta_pago_dia p WHERE ${wp.sql} GROUP BY 1 ORDER BY 2 DESC`, wp.params),
    c.query(
      `SELECT k.cliente_id, coalesce(nullif(cl.nombre_fantasia, ''), cl.nombre, 'Cliente eliminado') AS nombre,
         sum(k.tickets)::float8 AS tickets, sum(k.venta_neta) AS venta_neta
       FROM metricas_venta_cliente_dia k LEFT JOIN clientes cl ON cl.id = k.cliente_id
       WHERE ${wc.sql} GROUP BY 1, 2 HAVING sum(k.venta_neta) > 0 ORDER BY 4 DESC LIMIT 10`, wc.params),
  ]);

  const porPeriodo = new Map(serie.rows.map((x: any) => [x.periodo, x]));
  const total = totales.ventaNeta;
  return {
    desde: f.desde, hasta: f.hasta, paso,
    totales: { ...totales, variacionVenta: variacion(totales.ventaNeta, anterior.ventaNeta), variacionTickets: variacion(totales.tickets, anterior.tickets) },
    anterior: { desde: ant.desde, hasta: ant.hasta, ...anterior },
    serie: periodos(f.desde, f.hasta, paso).map((p) => {
      const x: any = porPeriodo.get(p);
      const tk = N(x?.tickets); const v = r2(N(x?.venta_neta));
      return { periodo: p, tickets: tk, ventaNeta: v, total: r2(N(x?.total)), ticketPromedio: tk > 0 ? r2(v / tk) : 0 };
    }),
    porSucursal: sucs.rows.map((x: any) => ({
      sucursalId: N(x.sucursal_id), nombre: x.nombre, tickets: N(x.tickets), ventaNeta: r2(N(x.venta_neta)), total: r2(N(x.total)),
      ticketPromedio: N(x.tickets) > 0 ? r2(N(x.venta_neta) / N(x.tickets)) : 0, participacion: pct(N(x.venta_neta), total),
    })),
    porHora: horas.rows.map((x: any) => ({ hora: N(x.hora), tickets: N(x.tickets), ventaNeta: r2(N(x.venta_neta)) })),
    porDiaSemana: semana.rows.map((x: any) => ({
      dia: N(x.dow), tickets: N(x.tickets), ventaNeta: r2(N(x.venta_neta)), dias: N(x.dias),
      promedioPorDia: N(x.dias) > 0 ? r2(N(x.venta_neta) / N(x.dias)) : 0,
    })),
    porCajero: cajeros.rows.map((x: any) => ({
      usuarioId: N(x.usuario_id), nombre: x.nombre, tickets: N(x.tickets), ventaNeta: r2(N(x.venta_neta)),
      ticketPromedio: N(x.tickets) > 0 ? r2(N(x.venta_neta) / N(x.tickets)) : 0, participacion: pct(N(x.venta_neta), total),
    })),
    porMedio: medios.rows.map((x: any) => ({ medio: x.medio, importe: r2(N(x.importe)), cantidad: N(x.cantidad) })),
    topClientes: clientes.rows.map((x: any) => ({
      clienteId: N(x.cliente_id), nombre: x.nombre, tickets: N(x.tickets), ventaNeta: r2(N(x.venta_neta)), participacion: pct(N(x.venta_neta), total),
    })),
  };
}

/* ============================== MÁRGENES ============================== */

export const sumaMargen = async (c: PoolClient, f: Filtro) => {
  const w = donde(f, 'f', true);
  const r = await c.query(
    `SELECT coalesce(sum(f.venta_neta), 0) AS venta_neta, coalesce(sum(f.venta_costeada), 0) AS venta_costeada,
       coalesce(sum(f.costo), 0) AS costo, coalesce(sum(f.iva_absorbido), 0) AS iva_absorbido,
       coalesce(sum(f.renglones), 0)::float8 AS renglones, coalesce(sum(f.con_costo), 0)::float8 AS con_costo
     FROM metricas_venta_prod_dia f WHERE ${w.sql}`, w.params);
  const x = r.rows[0];
  const ventaCosteada = r2(N(x.venta_costeada)); const costo = r2(N(x.costo));
  const margen = r2(ventaCosteada - costo);
  return {
    ventaNeta: r2(N(x.venta_neta)), ventaCosteada, costo, margen, margenPct: pct(margen, ventaCosteada),
    ivaAbsorbido: r2(N(x.iva_absorbido)), renglones: N(x.renglones), conCosto: N(x.con_costo),
  };
};

/** Cómo se agrupa cada lente. Las que necesitan datos del producto agregan primero por producto (2.700 filas) y recién ahí unen. */
const DEF_LENTE: Record<Lente, { porProducto: boolean; sel: string; join: string; group: string }> = {
  producto: { porProducto: true, sel: 'x.producto_id AS clave, p.nombre AS nombre', join: 'JOIN productos p ON p.id = x.producto_id', group: 'x.producto_id, p.nombre' },
  categoria: {
    porProducto: true, sel: `coalesce(p.categoria_id, 0) AS clave, coalesce(cat.nombre, 'Sin categoría') AS nombre`,
    join: 'JOIN productos p ON p.id = x.producto_id LEFT JOIN categorias cat ON cat.id = p.categoria_id', group: `coalesce(p.categoria_id, 0), coalesce(cat.nombre, 'Sin categoría')`,
  },
  marca: {
    porProducto: true, sel: `coalesce(p.marca_id, 0) AS clave, coalesce(m.nombre, 'Sin marca') AS nombre`,
    join: 'JOIN productos p ON p.id = x.producto_id LEFT JOIN marcas m ON m.id = p.marca_id', group: `coalesce(p.marca_id, 0), coalesce(m.nombre, 'Sin marca')`,
  },
  proveedor: {
    // El proveedor ACTIVO del producto (el que fija el precio), con la misma regla que `formatoActivo`.
    porProducto: true, sel: `coalesce(pa.proveedor_id, 0) AS clave, coalesce(prov.nombre, 'Sin proveedor') AS nombre`,
    join: `JOIN productos p ON p.id = x.producto_id
      LEFT JOIN LATERAL (SELECT pp.proveedor_id FROM producto_proveedores pp WHERE pp.producto_id = x.producto_id
        ORDER BY pp.usar_para_precio DESC, pp.id LIMIT 1) pa ON true
      LEFT JOIN proveedores prov ON prov.id = pa.proveedor_id`,
    group: `coalesce(pa.proveedor_id, 0), coalesce(prov.nombre, 'Sin proveedor')`,
  },
  lista: { porProducto: false, sel: `f.lista_id AS clave, coalesce(lv.nombre, 'Sin lista') AS nombre`, join: 'LEFT JOIN listas_venta lv ON lv.id = f.lista_id', group: `f.lista_id, coalesce(lv.nombre, 'Sin lista')` },
  sucursal: { porProducto: false, sel: `f.sucursal_id AS clave, coalesce(s.nombre, 'Sin sucursal') AS nombre`, join: 'LEFT JOIN sucursales s ON s.id = f.sucursal_id', group: `f.sucursal_id, coalesce(s.nombre, 'Sin sucursal')` },
};

export const SUMAS = (a: string) => `sum(${a}.venta_neta) AS venta_neta, sum(${a}.venta_costeada) AS venta_costeada, sum(${a}.costo) AS costo,
  sum(${a}.iva_absorbido) AS iva_absorbido, sum(${a}.renglones)::float8 AS renglones, sum(${a}.con_costo)::float8 AS con_costo`;

export async function reporteMargenes(c: PoolClient, f: Filtro, paso: Paso, lente: Lente) {
  const w = donde(f, 'f', true);
  const ant = periodoAnterior(f);
  const trunc = PASOS[paso];
  const L = DEF_LENTE[lente];

  const filasSql = L.porProducto
    ? `WITH x AS (SELECT f.producto_id, sum(f.unidades) AS unidades, ${SUMAS('f')}
         FROM metricas_venta_prod_dia f WHERE ${w.sql} GROUP BY f.producto_id)
       SELECT ${L.sel}, ${lente === 'producto' ? 'sum(x.unidades) AS unidades,' : ''} ${SUMAS('x')}
       FROM x ${L.join} GROUP BY ${L.group} ORDER BY sum(x.venta_neta) DESC LIMIT 500`
    : `SELECT ${L.sel}, ${SUMAS('f')}
       FROM metricas_venta_prod_dia f ${L.join} WHERE ${w.sql} GROUP BY ${L.group} ORDER BY sum(f.venta_neta) DESC LIMIT 500`;

  const [filas, totales, anterior, serie, compras] = await Promise.all([
    c.query(filasSql, w.params),
    sumaMargen(c, f),
    sumaMargen(c, ant),
    c.query(
      `SELECT to_char(date_trunc('${trunc}', f.dia), 'YYYY-MM-DD') AS periodo, ${SUMAS('f')}
       FROM metricas_venta_prod_dia f WHERE ${w.sql} GROUP BY 1 ORDER BY 1`, w.params),
    lente === 'proveedor'
      ? c.query(
        `SELECT m.proveedor_id, coalesce(pv.nombre, 'Proveedor eliminado') AS nombre, sum(m.neto) AS neto,
           sum(m.comprobantes)::float8 AS comprobantes
         FROM metricas_compra_prov_dia m LEFT JOIN proveedores pv ON pv.id = m.proveedor_id
         WHERE m.dia BETWEEN $1::date AND $2::date GROUP BY 1, 2`, [f.desde, f.hasta])
      : Promise.resolve({ rows: [] as any[] }),
  ]);

  const totalVenta = totales.ventaNeta;
  const mapear = (x: any) => {
    const ventaCosteada = r2(N(x.venta_costeada)); const costo = r2(N(x.costo));
    const margen = r2(ventaCosteada - costo);
    return {
      clave: N(x.clave), nombre: x.nombre as string,
      unidades: x.unidades != null ? r2(N(x.unidades)) : null,
      ventaNeta: r2(N(x.venta_neta)), ventaCosteada, costo, margen, margenPct: pct(margen, ventaCosteada),
      ivaAbsorbido: r2(N(x.iva_absorbido)), renglones: N(x.renglones), conCosto: N(x.con_costo),
      participacion: pct(N(x.venta_neta), totalVenta),
      comprasNeto: null as number | null, comprobantes: null as number | null,
    };
  };
  let out = filas.rows.map(mapear);

  if (lente === 'proveedor') {
    // Lo comprado a cada proveedor, incluso los que no vendieron nada en el período: es plata que compraste y no rotó.
    const cm = new Map<number, any>(compras.rows.map((x: any) => [N(x.proveedor_id), x]));
    for (const fila of out) { const k = cm.get(fila.clave); if (k) { fila.comprasNeto = r2(N(k.neto)); fila.comprobantes = N(k.comprobantes); cm.delete(fila.clave); } }
    for (const [id, k] of cm) {
      out.push({
        clave: id, nombre: k.nombre, unidades: null, ventaNeta: 0, ventaCosteada: 0, costo: 0, margen: 0, margenPct: null,
        ivaAbsorbido: 0, renglones: 0, conCosto: 0, participacion: null, comprasNeto: r2(N(k.neto)), comprobantes: N(k.comprobantes),
      });
    }
    out = out.sort((a, b) => b.ventaNeta - a.ventaNeta || (b.comprasNeto ?? 0) - (a.comprasNeto ?? 0));
  }

  const porPeriodo = new Map(serie.rows.map((x: any) => [x.periodo, x]));
  return {
    desde: f.desde, hasta: f.hasta, paso, lente, tipo: f.tipo ?? null,
    totales: {
      ...totales,
      variacionVenta: variacion(totales.ventaNeta, anterior.ventaNeta),
      variacionMargen: variacion(totales.margen, anterior.margen),
      /** Venta de renglones SIN costo congelado: no entra al margen, se avisa. */
      ventaSinCosto: r2(totales.ventaNeta - totales.ventaCosteada),
    },
    anterior: { desde: ant.desde, hasta: ant.hasta, ...anterior },
    serie: periodos(f.desde, f.hasta, paso).map((p) => {
      const x: any = porPeriodo.get(p);
      const vc = r2(N(x?.venta_costeada)); const cs = r2(N(x?.costo)); const mg = r2(vc - cs);
      return { periodo: p, ventaNeta: r2(N(x?.venta_neta)), ventaCosteada: vc, costo: cs, margen: mg, margenPct: pct(mg, vc) };
    }),
    filas: out,
    recortado: filas.rows.length >= 500,
  };
}

/* ============================== GRANEL Y ENTEROS (0123) ============================== */

/** Granel en paquetes (fraccionado), granel al peso (suelto) o entero. */
const CLASE = (a: string) => `(CASE WHEN ${a}.granel THEN (CASE WHEN ${a}.presentacion_id > 0 THEN 'fraccionado' ELSE 'suelto' END) ELSE 'entero' END)`;

/** Una fila de sumas de `metricas_venta_prod_dia` → números con el margen calculado. */
export const armarSuma = (x: any) => {
  const ventaCosteada = r2(N(x?.venta_costeada)); const costo = r2(N(x?.costo));
  const margen = r2(ventaCosteada - costo);
  return {
    ventaNeta: r2(N(x?.venta_neta)), ventaCosteada, costo, margen, margenPct: pct(margen, ventaCosteada),
    ivaAbsorbido: r2(N(x?.iva_absorbido)), renglones: N(x?.renglones), conCosto: N(x?.con_costo),
    unidades: r2(N(x?.unidades)), cantidadBase: Math.round(N(x?.cantidad_base) * 1000) / 1000, productos: N(x?.productos),
  };
};

/**
 * Las tres clases, cada granel y el total, en UNA consulta (GROUPING SETS): así
 * «productos distintos» de granel no cuenta dos veces al que se vendió suelto y
 * en paquetes, y los tres niveles salen de las mismas filas.
 */
const sumasPorClase = async (c: PoolClient, f: Filtro) => {
  const w = donde(f, 'f');
  const r = await c.query(
    `SELECT g.granel, g.clase, grouping(g.granel)::int AS sin_granel, grouping(g.clase)::int AS sin_clase,
       ${SUMAS('g')}, sum(g.unidades) AS unidades, sum(g.cantidad_base) AS cantidad_base,
       count(DISTINCT g.producto_id) FILTER (WHERE g.renglones > 0)::float8 AS productos
     FROM (SELECT f.*, ${CLASE('f')} AS clase FROM metricas_venta_prod_dia f WHERE ${w.sql}) g
     GROUP BY GROUPING SETS ((g.granel, g.clase), (g.granel), ())`, w.params);
  const total = armarSuma(r.rows.find((x: any) => x.sin_granel === 1));
  const grupo = (granel: boolean) => armarSuma(r.rows.find((x: any) => x.sin_granel === 0 && x.sin_clase === 1 && x.granel === granel));
  const clase = (k: string) => armarSuma(r.rows.find((x: any) => x.sin_clase === 0 && x.clase === k));
  return { total, granel: grupo(true), entero: grupo(false), fraccionado: clase('fraccionado'), suelto: clase('suelto') };
};

/** Tickets según lo que llevan: solo enteros, solo granel o de los dos. */
const sumaMezcla = async (c: PoolClient, f: Filtro) => {
  const w = donde(f, 'm');
  const r = await c.query(
    `SELECT m.mezcla, sum(m.tickets)::float8 AS tickets, sum(m.venta_neta) AS venta_neta
     FROM metricas_venta_mezcla_dia m WHERE ${w.sql} GROUP BY 1`, w.params);
  const de = (k: string) => { const x = r.rows.find((y: any) => y.mezcla === k); return { tickets: N(x?.tickets), ventaNeta: r2(N(x?.venta_neta)) }; };
  const entero = de('entero'); const granel = de('granel'); const mixto = de('mixto');
  const tickets = entero.tickets + granel.tickets + mixto.tickets;
  return { entero, granel, mixto, tickets, conGranel: granel.tickets + mixto.tickets, conEnteros: entero.tickets + mixto.tickets };
};

export async function reporteGranel(c: PoolClient, f: Filtro, paso: Paso) {
  const w = donde(f, 'f');
  const ant = periodoAnterior(f);
  const trunc = PASOS[paso];

  const [clases, clasesAnt, mezcla, mezclaAnt, serie, sucs, top] = await Promise.all([
    sumasPorClase(c, f),
    sumasPorClase(c, ant),
    sumaMezcla(c, f),
    sumaMezcla(c, ant),
    c.query(
      `SELECT to_char(date_trunc('${trunc}', f.dia), 'YYYY-MM-DD') AS periodo, f.granel, ${SUMAS('f')}
       FROM metricas_venta_prod_dia f WHERE ${w.sql} GROUP BY 1, 2`, w.params),
    c.query(
      `SELECT f.sucursal_id, coalesce(s.nombre, 'Sin sucursal') AS nombre, f.granel, ${SUMAS('f')}
       FROM metricas_venta_prod_dia f LEFT JOIN sucursales s ON s.id = f.sucursal_id
       WHERE ${w.sql} GROUP BY 1, 2, 3`, w.params),
    // Los 10 que más venden de cada lado.
    c.query(
      `WITH x AS (
         SELECT f.producto_id, f.granel, sum(f.unidades) AS unidades, sum(f.cantidad_base) AS cantidad_base, ${SUMAS('f')}
         FROM metricas_venta_prod_dia f WHERE ${w.sql} GROUP BY 1, 2),
       r AS (SELECT x.*, row_number() OVER (PARTITION BY x.granel ORDER BY x.venta_neta DESC, x.producto_id) AS n FROM x)
       SELECT r.*, coalesce(p.nombre, 'Producto eliminado') AS nombre
       FROM r LEFT JOIN productos p ON p.id = r.producto_id
       WHERE r.n <= 10 ORDER BY r.granel DESC, r.n`, w.params),
  ]);

  const { total, granel, entero } = clases;
  const lado = (g: ReturnType<typeof armarSuma>, gAnt: ReturnType<typeof armarSuma>, tickets: number) => ({
    ...g,
    /** Qué parte de la venta total es este lado. */
    participacion: pct(g.ventaNeta, total.ventaNeta),
    /** Qué parte de la GANANCIA deja: si es más que su parte de la venta, rinde más que el otro lado. */
    participacionMargen: total.margen > 0 ? pct(g.margen, total.margen) : null,
    ventaSinCosto: r2(g.ventaNeta - g.ventaCosteada),
    anterior: { ventaNeta: gAnt.ventaNeta, margen: gAnt.margen, margenPct: gAnt.margenPct, participacion: pct(gAnt.ventaNeta, clasesAnt.total.ventaNeta) },
    variacionVenta: variacion(g.ventaNeta, gAnt.ventaNeta),
    /** Tickets que llevan al menos un artículo de este lado (un ticket mixto cuenta en los dos). */
    tickets,
    participacionTickets: pct(tickets, mezcla.tickets),
  });

  // La serie: los dos lados por período, con los que no vendieron en cero.
  const porPeriodo = new Map<string, { granel: any; entero: any }>();
  for (const x of serie.rows) {
    const e = porPeriodo.get(x.periodo) ?? { granel: null, entero: null };
    if (x.granel) e.granel = x; else e.entero = x;
    porPeriodo.set(x.periodo, e);
  }
  const partir = (g: any, e: any) => {
    const sg = armarSuma(g); const se = armarSuma(e);
    const t = r2(sg.ventaNeta + se.ventaNeta);
    return {
      total: t, granel: sg.ventaNeta, entero: se.ventaNeta, pctGranel: pct(sg.ventaNeta, t), pctEntero: pct(se.ventaNeta, t),
      margenGranel: sg.margen, margenEntero: se.margen, margenPctGranel: sg.margenPct, margenPctEntero: se.margenPct,
    };
  };

  const porSuc = new Map<number, { nombre: string; granel: any; entero: any }>();
  for (const x of sucs.rows) {
    const id = N(x.sucursal_id);
    const e = porSuc.get(id) ?? { nombre: x.nombre, granel: null, entero: null };
    if (x.granel) e.granel = x; else e.entero = x;
    porSuc.set(id, e);
  }

  const topDe = (esGranel: boolean, base: number) => top.rows.filter((x: any) => x.granel === esGranel).map((x: any) => {
    const s = armarSuma(x);
    return {
      productoId: N(x.producto_id), nombre: x.nombre as string, unidades: s.unidades, cantidadBase: s.cantidadBase,
      ventaNeta: s.ventaNeta, margen: s.margen, margenPct: s.margenPct, participacion: pct(s.ventaNeta, base),
    };
  });

  return {
    desde: f.desde, hasta: f.hasta, paso,
    anterior: { desde: ant.desde, hasta: ant.hasta, ventaNeta: clasesAnt.total.ventaNeta, pctGranel: pct(clasesAnt.granel.ventaNeta, clasesAnt.total.ventaNeta) },
    total: { ...total, ventaSinCosto: r2(total.ventaNeta - total.ventaCosteada), variacionVenta: variacion(total.ventaNeta, clasesAnt.total.ventaNeta) },
    granel: {
      ...lado(granel, clasesAnt.granel, mezcla.conGranel),
      /** Precio promedio por kg: solo tiene sentido en granel (un paquete de 500 g cuenta 0,5 kg). */
      precioPorKg: granel.cantidadBase > 0 ? r2(granel.ventaNeta / granel.cantidadBase) : null,
      precioPorKgAnterior: clasesAnt.granel.cantidadBase > 0 ? r2(clasesAnt.granel.ventaNeta / clasesAnt.granel.cantidadBase) : null,
      fraccionado: { ...clases.fraccionado, participacion: pct(clases.fraccionado.ventaNeta, granel.ventaNeta) },
      suelto: { ...clases.suelto, participacion: pct(clases.suelto.ventaNeta, granel.ventaNeta) },
    },
    entero: lado(entero, clasesAnt.entero, mezcla.conEnteros),
    mezcla: (['entero', 'granel', 'mixto'] as const).map((k) => ({
      mezcla: k, tickets: mezcla[k].tickets, ventaNeta: mezcla[k].ventaNeta,
      ticketPromedio: mezcla[k].tickets > 0 ? r2(mezcla[k].ventaNeta / mezcla[k].tickets) : 0,
      participacion: pct(mezcla[k].tickets, mezcla.tickets),
      participacionAnterior: pct(mezclaAnt[k].tickets, mezclaAnt.tickets),
    })),
    tickets: mezcla.tickets,
    serie: periodos(f.desde, f.hasta, paso).map((p) => { const e = porPeriodo.get(p); return { periodo: p, ...partir(e?.granel, e?.entero) }; }),
    porSucursal: [...porSuc.entries()]
      .map(([id, e]) => ({ sucursalId: id, nombre: e.nombre, ...partir(e.granel, e.entero) }))
      .sort((a, b) => b.total - a.total),
    top: { granel: topDe(true, granel.ventaNeta), entero: topDe(false, entero.ventaNeta) },
  };
}

/* ============================== COMPARAR DOS PERÍODOS (0123) ============================== */

/**
 * Dos rangos en una misma consulta, con FILTER por rango: cada suma mira solo
 * el suyo aunque los períodos se pisen. $1–$2 = A, $3–$4 = B, $5 = sucursal.
 */
const dosRangos = (a: Filtro, b: Filtro, al: string) => {
  const A = `${al}.dia BETWEEN $1::date AND $2::date`;
  const B = `${al}.dia BETWEEN $3::date AND $4::date`;
  return {
    A, B,
    sql: `(${A} OR ${B})${a.sucursalId ? ` AND ${al}.sucursal_id = $5` : ''}`,
    params: a.sucursalId ? [a.desde, a.hasta, b.desde, b.hasta, a.sucursalId] : [a.desde, a.hasta, b.desde, b.hasta],
  };
};

/** Los números de un período que se ponen lado a lado. */
const resumenComparable = async (c: PoolClient, f: Filtro) => {
  const [v, m, g] = await Promise.all([sumaVentas(c, f), sumaMargen(c, { ...f, tipo: null }), sumasPorClase(c, f)]);
  return {
    desde: f.desde, hasta: f.hasta,
    ventaNeta: v.ventaNeta, tickets: v.tickets, ticketPromedio: v.ticketPromedio, promedioPorDia: v.promedioPorDia,
    diasConVenta: v.diasConVenta, total: v.total, descuento: v.descuento, notas: v.notas,
    costo: m.costo, margen: m.margen, margenPct: m.margenPct, ventaSinCosto: r2(m.ventaNeta - m.ventaCosteada),
    ventaGranel: g.granel.ventaNeta, ventaEnteros: g.entero.ventaNeta, pctGranel: pct(g.granel.ventaNeta, g.total.ventaNeta),
    kilosGranel: g.granel.cantidadBase, unidadesEnteros: g.entero.unidades,
  };
};

/** Diferencia en $ y en % de B a A («A es un X % más que B»). */
const dif = (a: number, b: number) => ({ diferencia: r2(a - b), variacion: variacion(a, b) });

export async function reporteComparar(c: PoolClient, a: Filtro, b: Filtro, paso: Paso) {
  const trunc = PASOS[paso];
  const d = dosRangos(a, b, 'd');
  const f = dosRangos(a, b, 'f');
  const p = dosRangos(a, b, 'p');

  const [ra, rb, sa, sb, sucs, cats, prods, medios, semana] = await Promise.all([
    resumenComparable(c, a),
    resumenComparable(c, b),
    c.query(
      `SELECT to_char(date_trunc('${trunc}', f.dia), 'YYYY-MM-DD') AS periodo, ${SUMAS('f')}
       FROM metricas_venta_prod_dia f WHERE f.dia BETWEEN $1::date AND $2::date${a.sucursalId ? ' AND f.sucursal_id = $3' : ''} GROUP BY 1`,
      a.sucursalId ? [a.desde, a.hasta, a.sucursalId] : [a.desde, a.hasta]),
    c.query(
      `SELECT to_char(date_trunc('${trunc}', f.dia), 'YYYY-MM-DD') AS periodo, ${SUMAS('f')}
       FROM metricas_venta_prod_dia f WHERE f.dia BETWEEN $1::date AND $2::date${b.sucursalId ? ' AND f.sucursal_id = $3' : ''} GROUP BY 1`,
      b.sucursalId ? [b.desde, b.hasta, b.sucursalId] : [b.desde, b.hasta]),
    c.query(
      `SELECT d.sucursal_id, coalesce(s.nombre, 'Sin sucursal') AS nombre,
         coalesce(sum(d.venta_neta) FILTER (WHERE ${d.A}), 0) AS va, coalesce(sum(d.venta_neta) FILTER (WHERE ${d.B}), 0) AS vb,
         coalesce(sum(d.tickets) FILTER (WHERE ${d.A}), 0)::float8 AS ta, coalesce(sum(d.tickets) FILTER (WHERE ${d.B}), 0)::float8 AS tb
       FROM metricas_venta_dia d LEFT JOIN sucursales s ON s.id = d.sucursal_id
       WHERE ${d.sql} GROUP BY 1, 2`, d.params),
    c.query(
      `SELECT coalesce(pr.categoria_id, 0) AS clave, coalesce(cat.nombre, 'Sin categoría') AS nombre,
         coalesce(sum(f.venta_neta) FILTER (WHERE ${f.A}), 0) AS va, coalesce(sum(f.venta_neta) FILTER (WHERE ${f.B}), 0) AS vb,
         coalesce(sum(f.venta_costeada) FILTER (WHERE ${f.A}), 0) AS vca, coalesce(sum(f.venta_costeada) FILTER (WHERE ${f.B}), 0) AS vcb,
         coalesce(sum(f.costo) FILTER (WHERE ${f.A}), 0) AS ca, coalesce(sum(f.costo) FILTER (WHERE ${f.B}), 0) AS cb
       FROM metricas_venta_prod_dia f
         LEFT JOIN productos pr ON pr.id = f.producto_id LEFT JOIN categorias cat ON cat.id = pr.categoria_id
       WHERE ${f.sql} GROUP BY 1, 2`, f.params),
    // Los que más subieron y los que más bajaron (por la plata, no por el %: un producto de $100 que pasa a $300 no explica nada).
    c.query(
      `WITH x AS (
         SELECT f.producto_id,
           coalesce(sum(f.venta_neta) FILTER (WHERE ${f.A}), 0) AS va, coalesce(sum(f.venta_neta) FILTER (WHERE ${f.B}), 0) AS vb,
           coalesce(sum(f.cantidad_base) FILTER (WHERE ${f.A}), 0) AS qa, coalesce(sum(f.cantidad_base) FILTER (WHERE ${f.B}), 0) AS qb,
           bool_or(f.granel) AS granel
         FROM metricas_venta_prod_dia f WHERE ${f.sql} GROUP BY 1)
       (SELECT 'sube' AS lado, x.*, coalesce(p.nombre, 'Producto eliminado') AS nombre FROM x LEFT JOIN productos p ON p.id = x.producto_id
          WHERE x.va - x.vb > 0.005 ORDER BY x.va - x.vb DESC, x.producto_id LIMIT 10)
       UNION ALL
       (SELECT 'baja', x.*, coalesce(p.nombre, 'Producto eliminado') FROM x LEFT JOIN productos p ON p.id = x.producto_id
          WHERE x.va - x.vb < -0.005 ORDER BY x.va - x.vb ASC, x.producto_id LIMIT 10)`, f.params),
    c.query(
      `SELECT p.medio, coalesce(sum(p.importe) FILTER (WHERE ${p.A}), 0) AS va, coalesce(sum(p.importe) FILTER (WHERE ${p.B}), 0) AS vb
       FROM metricas_venta_pago_dia p WHERE ${p.sql} GROUP BY 1`, p.params),
    c.query(
      `SELECT extract(isodow FROM d.dia)::int AS dow,
         coalesce(sum(d.venta_neta) FILTER (WHERE ${d.A}), 0) AS va, coalesce(sum(d.venta_neta) FILTER (WHERE ${d.B}), 0) AS vb,
         (count(DISTINCT d.dia) FILTER (WHERE ${d.A} AND d.tickets > 0))::float8 AS da,
         (count(DISTINCT d.dia) FILTER (WHERE ${d.B} AND d.tickets > 0))::float8 AS db
       FROM metricas_venta_dia d WHERE ${d.sql} GROUP BY 1 ORDER BY 1`, d.params),
  ]);

  // La serie alineada por posición: el día 1 de A contra el día 1 de B, aunque los meses no tengan los mismos días.
  const serieDe = (rows: any[], rango: Filtro) => {
    const m = new Map(rows.map((x: any) => [x.periodo, x]));
    return periodos(rango.desde, rango.hasta, paso).map((per) => {
      const s = armarSuma(m.get(per));
      return { periodo: per, ventaNeta: s.ventaNeta, margen: s.margen };
    });
  };
  const serieA = serieDe(sa.rows, a); const serieB = serieDe(sb.rows, b);
  const largo = Math.max(serieA.length, serieB.length);

  const margenDe = (vc: unknown, cs: unknown) => { const m = r2(N(vc) - N(cs)); return { margen: m, margenPct: pct(m, r2(N(vc))) }; };

  return {
    paso,
    a: ra, b: rb,
    diferencias: {
      ventaNeta: dif(ra.ventaNeta, rb.ventaNeta), tickets: dif(ra.tickets, rb.tickets), ticketPromedio: dif(ra.ticketPromedio, rb.ticketPromedio),
      promedioPorDia: dif(ra.promedioPorDia, rb.promedioPorDia), margen: dif(ra.margen, rb.margen), total: dif(ra.total, rb.total),
      ventaGranel: dif(ra.ventaGranel, rb.ventaGranel), ventaEnteros: dif(ra.ventaEnteros, rb.ventaEnteros),
      /** Puntos de diferencia (no %): 42 % contra 38 % son +4 puntos. */
      margenPctPuntos: ra.margenPct != null && rb.margenPct != null ? r2(ra.margenPct - rb.margenPct) : null,
      pctGranelPuntos: ra.pctGranel != null && rb.pctGranel != null ? r2(ra.pctGranel - rb.pctGranel) : null,
    },
    serie: Array.from({ length: largo }, (_, i) => ({
      i, periodoA: serieA[i]?.periodo ?? null, periodoB: serieB[i]?.periodo ?? null,
      a: serieA[i]?.ventaNeta ?? null, b: serieB[i]?.ventaNeta ?? null,
      margenA: serieA[i]?.margen ?? null, margenB: serieB[i]?.margen ?? null,
    })),
    porSucursal: sucs.rows.map((x: any) => ({
      sucursalId: N(x.sucursal_id), nombre: x.nombre, a: r2(N(x.va)), b: r2(N(x.vb)), ticketsA: N(x.ta), ticketsB: N(x.tb), ...dif(N(x.va), N(x.vb)),
    })).sort((x, y) => y.a - x.a || y.b - x.b),
    porCategoria: cats.rows.map((x: any) => {
      const ma = margenDe(x.vca, x.ca); const mb = margenDe(x.vcb, x.cb);
      return {
        clave: N(x.clave), nombre: x.nombre, a: r2(N(x.va)), b: r2(N(x.vb)), ...dif(N(x.va), N(x.vb)),
        margenA: ma.margen, margenB: mb.margen, margenPctA: ma.margenPct, margenPctB: mb.margenPct,
      };
    }).sort((x, y) => Math.abs(y.diferencia) - Math.abs(x.diferencia) || y.a - x.a),
    productos: {
      suben: prods.rows.filter((x: any) => x.lado === 'sube').map(mapearMovimiento),
      bajan: prods.rows.filter((x: any) => x.lado === 'baja').map(mapearMovimiento),
    },
    porMedio: medios.rows.map((x: any) => ({ medio: x.medio, a: r2(N(x.va)), b: r2(N(x.vb)), ...dif(N(x.va), N(x.vb)) }))
      .sort((x, y) => y.a - x.a || y.b - x.b),
    porDiaSemana: [1, 2, 3, 4, 5, 6, 7].map((dw) => {
      const x = semana.rows.find((y: any) => N(y.dow) === dw);
      const pa = N(x?.da) > 0 ? r2(N(x.va) / N(x.da)) : 0; const pb = N(x?.db) > 0 ? r2(N(x.vb) / N(x.db)) : 0;
      return { dia: dw, a: pa, b: pb, diasA: N(x?.da), diasB: N(x?.db), ...dif(pa, pb) };
    }),
  };
}

const mapearMovimiento = (x: any) => ({
  productoId: N(x.producto_id), nombre: x.nombre as string, granel: !!x.granel,
  a: r2(N(x.va)), b: r2(N(x.vb)), cantidadA: Math.round(N(x.qa) * 1000) / 1000, cantidadB: Math.round(N(x.qb) * 1000) / 1000,
  ...dif(N(x.va), N(x.vb)),
});
