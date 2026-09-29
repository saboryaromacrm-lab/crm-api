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

export interface Filtro { desde: string; hasta: string; sucursalId: number | null }

const N = (x: unknown) => Number(x ?? 0) || 0;
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (parte: number, base: number) => (base > 0 ? r2((parte / base) * 100) : null);
const variacion = (ahora: number, antes: number) => (antes > 0 ? r2(((ahora - antes) / antes) * 100) : null);

const MS_DIA = 86_400_000;
const diasEntre = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MS_DIA);

/** El período inmediatamente anterior, del mismo largo: contra qué se compara. */
export function periodoAnterior(f: Filtro): Filtro {
  const n = diasEntre(f.desde, f.hasta) + 1;
  return { desde: sumarDias(f.desde, -n), hasta: sumarDias(f.desde, -1), sucursalId: f.sucursalId };
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

/** Parámetros y filtro de sucursal ($3 solo si hay). `a` es el alias de la tabla. */
const donde = (f: Filtro, a: string) => ({
  sql: `${a}.dia BETWEEN $1::date AND $2::date${f.sucursalId ? ` AND ${a}.sucursal_id = $3` : ''}`,
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

const sumaMargen = async (c: PoolClient, f: Filtro) => {
  const w = donde(f, 'f');
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

const SUMAS = (a: string) => `sum(${a}.venta_neta) AS venta_neta, sum(${a}.venta_costeada) AS venta_costeada, sum(${a}.costo) AS costo,
  sum(${a}.iva_absorbido) AS iva_absorbido, sum(${a}.renglones)::float8 AS renglones, sum(${a}.con_costo)::float8 AS con_costo`;

export async function reporteMargenes(c: PoolClient, f: Filtro, paso: Paso, lente: Lente) {
  const w = donde(f, 'f');
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
    desde: f.desde, hasta: f.hasta, paso, lente,
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
