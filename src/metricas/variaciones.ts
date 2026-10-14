/**
 * VENTAS › VARIACIONES (14/10/2026, pedido del dueño)
 * ============================================================================
 * Cuánto subió o bajó lo vendido entre dos períodos: en cantidad (unidades los
 * enteros, kg el granel) y en plata neta. Sale de la tabla resumen de Métricas
 * (`metricas_venta_prod_dia`, al día cada 10 minutos): mostrador y tienda, con
 * las notas de crédito restando; los envíos a Coffit y los retiros no son
 * ventas. Sin costos ni margen.
 *
 * Devuelve una fila por (producto, sucursal, lista) con lo de cada período, y
 * los nombres para agrupar: la pantalla filtra y agrupa al instante (por
 * producto, marca, categoría, subcategoría, etiqueta, proveedor, sucursal o
 * lista) sin volver a pedir. Solo cambiar las fechas pide de nuevo.
 */
import type { PoolClient } from 'pg';
import { dosRangos, type Filtro } from './consultas';

const r2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
const r3 = (n: unknown) => Math.round((Number(n) || 0) * 1000) / 1000;

/** Las tablas de los nombres que la pantalla usa para agrupar y filtrar. */
const TABLAS = {
  marcas: 'marcas', categorias: 'categorias', subcategorias: 'subcategorias', etiquetas: 'etiquetas',
  proveedores: 'proveedores', sucursales: 'sucursales', listas: 'listas_venta',
} as const;
type Dic = keyof typeof TABLAS;

export async function reporteVariaciones(c: PoolClient, a: Filtro, b: Filtro) {
  const r = dosRangos(a, b, 'f');
  const [filas, estado] = await Promise.all([
    c.query(
      `SELECT f.producto_id AS p, f.sucursal_id AS s, f.lista_id AS l,
         coalesce(sum(f.cantidad_base) FILTER (WHERE ${r.A}), 0)::float8 AS qa,
         coalesce(sum(f.cantidad_base) FILTER (WHERE ${r.B}), 0)::float8 AS qb,
         coalesce(sum(f.venta_neta) FILTER (WHERE ${r.A}), 0)::float8 AS va,
         coalesce(sum(f.venta_neta) FILTER (WHERE ${r.B}), 0)::float8 AS vb
       FROM metricas_venta_prod_dia f
       WHERE ${r.sql}
       GROUP BY 1, 2, 3`, r.params),
    c.query('SELECT ultima_ok FROM metricas_estado WHERE id = 1'),
  ]);
  // Una venta y su devolución en el mismo período se anulan: esa fila no dice nada.
  const vivas = filas.rows.filter((x) => Math.abs(x.qa) + Math.abs(x.qb) + Math.abs(x.va) + Math.abs(x.vb) > 1e-6);

  const ids = [...new Set(vivas.map((x) => Number(x.p)))];
  const prods = ids.length ? (await c.query(
    `SELECT p.id, p.nombre, p.tipo = 'granel' AS granel, p.marca_id, p.categoria_id, p.subcategoria_id,
       (SELECT pp.proveedor_id FROM producto_proveedores pp WHERE pp.producto_id = p.id
         ORDER BY pp.usar_para_precio DESC, pp.id LIMIT 1) AS proveedor_id,
       coalesce((SELECT array_agg(pe.etiqueta_id ORDER BY pe.etiqueta_id) FROM producto_etiquetas pe WHERE pe.producto_id = p.id), '{}') AS etiquetas
     FROM productos p WHERE p.id = ANY($1::int[])`, [ids])).rows : [];

  /* Los nombres, solo de lo que aparece: una consulta para todos los diccionarios. */
  const usados: Record<Dic, Set<number>> = {
    marcas: new Set(), categorias: new Set(), subcategorias: new Set(), etiquetas: new Set(),
    proveedores: new Set(), sucursales: new Set(vivas.map((x) => Number(x.s))), listas: new Set(vivas.map((x) => Number(x.l))),
  };
  for (const p of prods) {
    if (p.marca_id) usados.marcas.add(p.marca_id);
    if (p.categoria_id) usados.categorias.add(p.categoria_id);
    if (p.subcategoria_id) usados.subcategorias.add(p.subcategoria_id);
    if (p.proveedor_id) usados.proveedores.add(p.proveedor_id);
    for (const e of p.etiquetas) usados.etiquetas.add(e);
  }
  const claves = Object.keys(TABLAS) as Dic[];
  const nombres = Object.fromEntries(claves.map((k) => [k, {} as Record<number, string>])) as Record<Dic, Record<number, string>>;
  const dic = await c.query(
    claves.map((k, i) => `SELECT '${k}' AS t, id, nombre FROM ${TABLAS[k]} WHERE id = ANY($${i + 1}::int[])`).join(' UNION ALL '),
    claves.map((k) => [...usados[k]]));
  for (const x of dic.rows) nombres[x.t as Dic][x.id] = x.nombre;

  return {
    a: { desde: a.desde, hasta: a.hasta },
    b: { desde: b.desde, hasta: b.hasta },
    actualizado: estado.rows[0]?.ultima_ok ?? null,
    /** [producto, sucursal, lista, cantidad A, cantidad B, plata A, plata B] — compacto: pueden ser miles. */
    filas: vivas.map((x) => [Number(x.p), Number(x.s), Number(x.l), r3(x.qa), r3(x.qb), r2(x.va), r2(x.vb)]),
    /** [id, nombre, granel, marca, categoría, subcategoría, proveedor que fija el precio, etiquetas] */
    productos: prods.map((p) => [p.id, p.nombre, p.granel, p.marca_id, p.categoria_id, p.subcategoria_id, p.proveedor_id, p.etiquetas]),
    nombres,
  };
}
