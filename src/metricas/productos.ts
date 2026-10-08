/**
 * MÉTRICAS › PRODUCTOS, CATEGORÍAS Y SUBCATEGORÍAS (2/10/2026)
 * ============================================================================
 * Pedido del dueño: ver lo vendido por producto y, a la vez, por categoría y
 * subcategoría. Se navega como un árbol:
 *
 *     Todas las categorías  →  una categoría (sus subcategorías)
 *                           →  una subcategoría (sus productos)
 *                           →  un producto (su detalle)
 *
 * En cada nivel: cuánto vendió cada parte, qué parte es del nivel y de TODO lo
 * vendido, contra el período anterior, el margen, cuántos productos vendieron
 * y cuántos activos NO vendieron nada (plata parada o un artículo que nadie
 * pide). «Todos los productos» lista los productos del nivel sin bajar.
 *
 * Igual que el resto del módulo, lee SOLO el resumen `metricas_venta_prod_dia`:
 * tarda lo mismo con un mes que con tres años. Los tres niveles salen de UNA
 * misma suma por producto, así la suma de las partes da siempre el total.
 *
 * La clasificación es la de HOY: si un producto se pasó de categoría, su
 * historia viaja con él (igual que «Por categoría» en Rentabilidad).
 *
 * POR MARCA (7/10/2026, pedido del dueño): el mismo reporte agrupado por la
 * marca de cada producto (`porMarca`): todas las marcas → los productos de
 * una marca → la ficha del producto. `0` = «Sin marca». Igual que con las
 * categorías, cuenta la marca que el producto tiene HOY.
 */
import type { PoolClient } from 'pg';
import {
  N, PASOS, SUMAS, armarSuma, donde, pct, periodoAnterior, periodos, r2, sumaMargen, variacion,
  type Filtro, type Paso, type TipoVenta,
} from './consultas';

/**
 * Dónde se está parado en el árbol. `0` es «Sin categoría» / «Sin subcategoría»:
 * un producto sin clasificar también se vende y tiene que poder encontrarse.
 * `plano`: todos los productos del nodo de una vez, sin bajar por subcategoría.
 */
export interface NodoProductos {
  categoriaId: number | null; subcategoriaId: number | null; productoId: number | null; plano: boolean;
  /** Recorrer por marca en vez de por categoría; `marcaId` = la marca abierta. */
  porMarca?: boolean; marcaId?: number | null;
}

/** Arma los parámetros posicionales sin contarlos a mano: `p(valor)` devuelve `$n`. */
const parametros = () => {
  const lista: unknown[] = [];
  return { lista, p: (v: unknown) => { lista.push(v); return `$${lista.length}`; } };
};

/** Granel por la marca del resumen (el tipo con que se sincronizó), igual que la pestaña Granel. */
const filtroTipo = (a: string, tipo?: TipoVenta | null) => (tipo ? ` AND ${tipo === 'granel' ? '' : 'NOT '}${a}.granel` : '');

/**
 * Lo vendido en el período (A) y en el anterior (B) POR PRODUCTO, en una sola
 * pasada sobre el resumen. Categorías, subcategorías y el nodo se arman sumando
 * estas filas.
 */
function cteProductos(f: Filtro, ant: Filtro, p: (v: unknown) => string) {
  const A = `f.dia BETWEEN ${p(f.desde)}::date AND ${p(f.hasta)}::date`;
  const B = `f.dia BETWEEN ${p(ant.desde)}::date AND ${p(ant.hasta)}::date`;
  const suc = f.sucursalId ? ` AND f.sucursal_id = ${p(f.sucursalId)}` : '';
  const sum = (col: string, r: string) => `coalesce(sum(f.${col}) FILTER (WHERE ${r}), 0)`;
  return `x AS (
    SELECT f.producto_id,
      ${sum('venta_neta', A)} AS va, ${sum('venta_costeada', A)} AS vca, ${sum('costo', A)} AS ca,
      ${sum('iva_absorbido', A)} AS ia, ${sum('unidades', A)} AS ua, ${sum('cantidad_base', A)} AS qa,
      ${sum('renglones', A)}::float8 AS ra, ${sum('con_costo', A)}::float8 AS cca,
      ${sum('venta_neta', B)} AS vb, ${sum('venta_costeada', B)} AS vcb, ${sum('costo', B)} AS cb,
      bool_or(f.granel) AS granel
    FROM metricas_venta_prod_dia f
    WHERE (${A} OR ${B})${suc}${filtroTipo('f', f.tipo)}
    GROUP BY f.producto_id)`;
}

/** Vendió en el período A: tuvo renglones o un importe (una devolución sola también cuenta). */
const VENDIO = '(x.ra > 0 OR abs(x.va) > 0.005)';

/** Las sumas de un grupo de filas de `x`. */
const SUMAS_X = `sum(x.va) AS va, sum(x.vca) AS vca, sum(x.ca) AS ca, sum(x.ia) AS ia,
  coalesce(sum(x.ua) FILTER (WHERE NOT x.granel), 0) AS u_enteros, coalesce(sum(x.qa) FILTER (WHERE x.granel), 0) AS kg_granel,
  sum(x.ra)::float8 AS ra, sum(x.cca)::float8 AS cca, sum(x.vb) AS vb, sum(x.vcb) AS vcb, sum(x.cb) AS cb,
  (count(*) FILTER (WHERE ${VENDIO}))::float8 AS productos`;

const CLAVES_SUMA = ['va', 'vca', 'ca', 'ia', 'u_enteros', 'kg_granel', 'ra', 'cca', 'vb', 'vcb', 'cb', 'productos'] as const;

/** Una fila de sumas → números con margen, variación y lo que no tiene costo. */
function armarGrupo(x: any) {
  const ventaNeta = r2(N(x?.va)); const ventaCosteada = r2(N(x?.vca)); const costo = r2(N(x?.ca));
  const margen = r2(ventaCosteada - costo);
  const ventaAnterior = r2(N(x?.vb)); const margenAnterior = r2(N(x?.vcb) - N(x?.cb));
  return {
    ventaNeta, ventaCosteada, costo, margen, margenPct: pct(margen, ventaCosteada),
    ivaAbsorbido: r2(N(x?.ia)), ventaSinCosto: r2(ventaNeta - ventaCosteada),
    unidadesEnteros: r2(N(x?.u_enteros)), kilosGranel: Math.round(N(x?.kg_granel) * 1000) / 1000,
    renglones: N(x?.ra), conCosto: N(x?.cca), productos: N(x?.productos),
    ventaAnterior, margenAnterior, margenPctAnterior: pct(margenAnterior, r2(N(x?.vcb))),
    diferencia: r2(ventaNeta - ventaAnterior), variacion: variacion(ventaNeta, ventaAnterior),
    variacionMargen: variacion(margen, margenAnterior),
  };
}

const CLAVE_CAT = 'coalesce(p.categoria_id, 0)';
const CLAVE_SUB = 'coalesce(p.subcategoria_id, 0)';
const CLAVE_MARCA = 'coalesce(p.marca_id, 0)';
const JOINS = `LEFT JOIN productos p ON p.id = x.producto_id LEFT JOIN categorias cat ON cat.id = p.categoria_id
  LEFT JOIN subcategorias sc ON sc.id = p.subcategoria_id LEFT JOIN marcas m ON m.id = p.marca_id`;

type Nivel = 'categoria' | 'subcategoria' | 'marca' | 'producto' | 'detalle';

export async function reporteProductos(c: PoolClient, f: Filtro, paso: Paso, nodo: NodoProductos) {
  const ant = periodoAnterior(f);
  const trunc = PASOS[paso];

  /* ------------------------------ dónde estamos ------------------------------ */
  let prod: any = null;
  if (nodo.productoId) {
    prod = (await c.query(
      `SELECT p.id, p.nombre, p.tipo::text AS tipo, p.codigo_propio, p.codigo_barras, p.estado::text AS estado,
         coalesce(p.categoria_id, 0) AS categoria_id, coalesce(p.subcategoria_id, 0) AS subcategoria_id,
         coalesce(p.marca_id, 0) AS marca_id, coalesce(m.nombre, '') AS marca
       FROM productos p LEFT JOIN marcas m ON m.id = p.marca_id WHERE p.id = $1`, [nodo.productoId])).rows[0] ?? null;
  }
  const porMarca = !!nodo.porMarca;
  // El producto manda: su categoría, subcategoría y marca son las de HOY, las arma el detalle.
  const catId = prod ? N(prod.categoria_id) : porMarca ? null : nodo.categoriaId;
  const subId = prod ? N(prod.subcategoria_id) : porMarca ? null : (catId != null ? nodo.subcategoriaId : null);
  const marcaId = prod ? (porMarca ? N(prod.marca_id) : null) : porMarca ? (nodo.marcaId ?? null) : null;
  const [catRow, subRow, marcaRow] = await Promise.all([
    catId ? c.query('SELECT nombre FROM categorias WHERE id = $1', [catId]) : Promise.resolve({ rows: [] as any[] }),
    subId ? c.query('SELECT nombre FROM subcategorias WHERE id = $1', [subId]) : Promise.resolve({ rows: [] as any[] }),
    marcaId ? c.query('SELECT nombre FROM marcas WHERE id = $1', [marcaId]) : Promise.resolve({ rows: [] as any[] }),
  ]);
  const ruta = {
    categoria: catId == null ? null : { id: catId, nombre: catId === 0 ? 'Sin categoría' : catRow.rows[0]?.nombre ?? 'Categoría eliminada' },
    subcategoria: subId == null ? null : { id: subId, nombre: subId === 0 ? 'Sin subcategoría' : subRow.rows[0]?.nombre ?? 'Subcategoría eliminada' },
    marca: marcaId == null ? null : { id: marcaId, nombre: marcaId === 0 ? 'Sin marca' : marcaRow.rows[0]?.nombre ?? 'Marca eliminada' },
    producto: prod ? { id: N(prod.id), nombre: prod.nombre as string } : null,
  };

  /* Sin categoría elegida se listan las categorías; con categoría, sus
   * subcategorías; con las dos (o «todos los productos»), los productos.
   * Por marca: las marcas, y con una marca elegida, sus productos. */
  const nivel: Nivel = prod ? 'detalle'
    : porMarca ? (marcaId != null ? 'producto' : 'marca')
      : nodo.plano || (catId != null && subId != null) ? 'producto'
        : catId != null ? 'subcategoria' : 'categoria';

  /** El filtro del nodo sobre `productos p`. */
  const condNodo = (p: (v: unknown) => string) => [
    catId != null ? `${CLAVE_CAT} = ${p(catId)}` : '',
    subId != null ? `${CLAVE_SUB} = ${p(subId)}` : '',
    marcaId != null ? `${CLAVE_MARCA} = ${p(marcaId)}` : '',
  ].filter(Boolean).join(' AND ') || 'true';

  /* La serie del nodo (o del producto), período por período. */
  const we = donde(f, 'f', true);
  const qe = parametros();
  for (const v of we.params) qe.lista.push(v);
  const serieSql = `SELECT to_char(date_trunc('${trunc}', f.dia), 'YYYY-MM-DD') AS periodo, ${SUMAS('f')}
    FROM metricas_venta_prod_dia f LEFT JOIN productos p ON p.id = f.producto_id
    WHERE ${we.sql} AND ${prod ? `f.producto_id = ${qe.p(prod.id)}` : condNodo(qe.p)}
    GROUP BY 1 ORDER BY 1`;

  const [serieR, total] = await Promise.all([c.query(serieSql, qe.lista), sumaMargen(c, f)]);
  const porPeriodo = new Map(serieR.rows.map((x: any) => [x.periodo, x]));
  const base = {
    desde: f.desde, hasta: f.hasta, paso, tipo: f.tipo ?? null, nivel, plano: nivel === 'producto' && !porMarca && nodo.plano, porMarca, ruta,
    anterior: { desde: ant.desde, hasta: ant.hasta },
    totalGeneral: { ventaNeta: total.ventaNeta, margen: total.margen },
    serie: periodos(f.desde, f.hasta, paso).map((per) => {
      const s = armarSuma(porPeriodo.get(per));
      return { periodo: per, ventaNeta: s.ventaNeta, margen: s.margen, margenPct: s.margenPct };
    }),
  };

  if (nivel === 'detalle') return { ...base, ...(await detalleProducto(c, f, ant, prod, catId ?? 0, subId ?? 0, N(prod.marca_id), total.ventaNeta)) };
  const [arbol, modalidades] = await Promise.all([
    nivelArbol(c, f, ant, nivel, condNodo, total.ventaNeta),
    porMarca ? modalidadesPorMarca(c, f, condNodo) : Promise.resolve(null),
  ]);
  if (!modalidades) return { ...base, ...arbol };
  /* Por marca (8/10/2026, pedido del dueño): qué parte de lo vendido fue en cada modalidad, del nodo y de cada marca. */
  return {
    ...base, ...arbol,
    modalidades: { lista: modalidades.lista, nodo: modalidades.nodo },
    filas: nivel === 'marca' ? arbol.filas.map((x: any) => ({ ...x, modalidades: modalidades.porMarca.get(x.clave) ?? [] })) : arbol.filas,
  };
}

/**
 * QUÉ PARTE DE LA VENTA FUE EN CADA MODALIDAD (Minorista, Mayorista…), por
 * marca. La modalidad es la de la lista con la que se vendió cada renglón; una
 * sola lectura de la tabla resumen, del mismo período y filtro que el resto.
 * Las modalidades van en el mismo orden en todas las filas (el de la venta del
 * nodo), para poder compararlas de un vistazo.
 */
async function modalidadesPorMarca(c: PoolClient, f: Filtro, condNodo: (p: (v: unknown) => string) => string) {
  const we = donde(f, 'f', true);
  const q = parametros();
  for (const v of we.params) q.lista.push(v);
  const r = await c.query(
    `SELECT ${CLAVE_MARCA} AS marca, coalesce(lv.modalidad_id, 0) AS modalidad, coalesce(mv.nombre, 'Sin modalidad') AS nombre,
       sum(f.venta_neta) AS venta
     FROM metricas_venta_prod_dia f
     LEFT JOIN productos p ON p.id = f.producto_id
     LEFT JOIN listas_venta lv ON lv.id = f.lista_id
     LEFT JOIN modalidades_venta mv ON mv.id = lv.modalidad_id
     WHERE ${we.sql} AND ${condNodo(q.p)}
     GROUP BY 1, 2, 3`, q.lista);
  const nombreDe = new Map<number, string>();
  const totalMod = new Map<number, number>();
  const porMarcaMod = new Map<number, Map<number, number>>();
  for (const x of r.rows as any[]) {
    const mod = N(x.modalidad); const marca = N(x.marca); const v = N(x.venta);
    nombreDe.set(mod, x.nombre);
    totalMod.set(mod, (totalMod.get(mod) ?? 0) + v);
    const m = porMarcaMod.get(marca) ?? new Map<number, number>();
    m.set(mod, (m.get(mod) ?? 0) + v);
    porMarcaMod.set(marca, m);
  }
  const orden = [...totalMod.keys()].sort((a, b) => (totalMod.get(b) ?? 0) - (totalMod.get(a) ?? 0));
  const reparto = (m: Map<number, number>) => {
    const total = [...m.values()].reduce((s, v) => s + v, 0);
    return orden.filter((id) => Math.abs(m.get(id) ?? 0) > 0.005)
      .map((id) => ({ id, ventaNeta: r2(m.get(id) ?? 0), participacion: pct(m.get(id) ?? 0, total) }));
  };
  return {
    lista: orden.map((id) => ({ id, nombre: nombreDe.get(id) ?? 'Sin modalidad' })),
    nodo: reparto(totalMod),
    porMarca: new Map([...porMarcaMod].map(([marca, m]) => [marca, reparto(m)])),
  };
}

/* ============================== UN NIVEL DEL ÁRBOL ============================== */
async function nivelArbol(
  c: PoolClient, f: Filtro, ant: Filtro, nivel: Exclude<Nivel, 'detalle'>,
  condNodo: (p: (v: unknown) => string) => string, totalGeneral: number,
) {
  const DEF = {
    categoria: { sel: `${CLAVE_CAT} AS clave, coalesce(cat.nombre, 'Sin categoría') AS nombre`, grupo: `${CLAVE_CAT}, coalesce(cat.nombre, 'Sin categoría')` },
    subcategoria: { sel: `${CLAVE_SUB} AS clave, coalesce(sc.nombre, 'Sin subcategoría') AS nombre`, grupo: `${CLAVE_SUB}, coalesce(sc.nombre, 'Sin subcategoría')` },
    marca: { sel: `${CLAVE_MARCA} AS clave, coalesce(m.nombre, 'Sin marca') AS nombre`, grupo: `${CLAVE_MARCA}, coalesce(m.nombre, 'Sin marca')` },
    producto: {
      sel: `x.producto_id AS clave, coalesce(p.nombre, 'Producto eliminado') AS nombre, bool_or(x.granel) AS granel,
        max(coalesce(m.nombre, '')) AS marca, max(coalesce(cat.nombre, 'Sin categoría')) AS categoria,
        max(coalesce(sc.nombre, 'Sin subcategoría')) AS subcategoria`,
      grupo: `x.producto_id, coalesce(p.nombre, 'Producto eliminado')`,
    },
  }[nivel];

  const qf = parametros();
  const filasSql = `WITH ${cteProductos(f, ant, qf.p)}
    SELECT ${DEF.sel}, ${SUMAS_X}
    FROM x ${JOINS}
    WHERE ${condNodo(qf.p)}
    GROUP BY ${DEF.grupo}
    HAVING sum(x.ra) > 0 OR abs(sum(x.va)) > 0.005 OR abs(sum(x.vb)) > 0.005`;

  /* Lo que NO se vendió: productos ACTIVOS del nodo sin una sola venta en el
   * período (los de solo cafetería no se venden en el mostrador: afuera). */
  const qs = parametros();
  const cteS = cteProductos(f, ant, qs.p);
  const tipoProd = f.tipo ? ` AND p.tipo::text ${f.tipo === 'granel' ? '=' : '<>'} 'granel'` : '';
  const esProd = nivel === 'producto';
  const sinVentaSql = `WITH ${cteS}
    SELECT ${nivel === 'categoria' ? CLAVE_CAT : nivel === 'subcategoria' ? CLAVE_SUB : nivel === 'marca' ? CLAVE_MARCA : 'p.id'} AS clave,
      ${esProd ? 'p.nombre AS nombre, p.tipo::text AS tipo,' : ''} count(*)::float8 AS n
    FROM productos p
    WHERE p.estado::text = 'activo' AND NOT p.solo_cafeteria AND ${condNodo(qs.p)}${tipoProd}
      AND NOT EXISTS (SELECT 1 FROM x WHERE x.producto_id = p.id AND ${VENDIO})
    GROUP BY 1${esProd ? ', p.nombre, p.tipo ORDER BY p.nombre LIMIT 301' : ''}`;

  const [filasR, sinVentaR] = await Promise.all([c.query(filasSql, qf.lista), c.query(sinVentaSql, qs.lista)]);

  // El nodo es la SUMA de sus filas: nunca puede no cerrar con ellas.
  const grupos = filasR.rows.map((x: any) => ({ x, g: armarGrupo(x) }));
  const suma: Record<string, number> = {};
  for (const k of CLAVES_SUMA) suma[k] = grupos.reduce((s, { x }) => s + N(x[k]), 0);
  const nodoTot = armarGrupo(suma);

  const sinVentaDe = new Map<number, number>(esProd ? [] : sinVentaR.rows.map((x: any) => [N(x.clave), N(x.n)]));
  const filas: any[] = grupos.map(({ x, g }) => ({
    clave: N(x.clave), nombre: x.nombre as string,
    ...(esProd ? { granel: !!x.granel, marca: x.marca || '', categoria: x.categoria, subcategoria: x.subcategoria } : {}),
    ...g,
    /** Qué parte del nivel que se está mirando es (de la categoría, si se mira una categoría). */
    participacion: pct(g.ventaNeta, nodoTot.ventaNeta),
    /** Qué parte de TODO lo vendido. */
    participacionTotal: pct(g.ventaNeta, totalGeneral),
    /** Qué parte de la ganancia del nivel deja: si es más que su parte de la venta, rinde más que el promedio. */
    participacionMargen: nodoTot.margen > 0 ? pct(g.margen, nodoTot.margen) : null,
    sinVenta: esProd ? 0 : sinVentaDe.get(N(x.clave)) ?? 0,
  }));

  // Una categoría, subcategoría o marca que no vendió nada pero tiene productos activos también va, en cero: si no, «desaparece».
  if (!esProd) {
    const vistos = new Set(filas.map((x) => x.clave));
    const faltan = [...sinVentaDe.keys()].filter((k) => !vistos.has(k));
    if (faltan.length) {
      const tabla = { categoria: 'categorias', subcategoria: 'subcategorias', marca: 'marcas' }[nivel];
      const sinNombre = { categoria: 'Sin categoría', subcategoria: 'Sin subcategoría', marca: 'Sin marca' }[nivel];
      const nombres = await c.query(`SELECT id, nombre FROM ${tabla} WHERE id = ANY($1::int[])`, [faltan]);
      const nom = new Map(nombres.rows.map((x: any) => [N(x.id), x.nombre as string]));
      for (const k of faltan) {
        filas.push({
          clave: k, nombre: k === 0 ? sinNombre : nom.get(k) ?? '—',
          ...armarGrupo(null), participacion: null, participacionTotal: null, participacionMargen: null, sinVenta: sinVentaDe.get(k) ?? 0,
        });
      }
    }
  }
  filas.sort((a, b) => b.ventaNeta - a.ventaNeta || a.nombre.localeCompare(b.nombre, 'es'));

  const sinVentas = esProd ? sinVentaR.rows.slice(0, 300).map((x: any) => ({ productoId: N(x.clave), nombre: x.nombre as string, granel: x.tipo === 'granel' })) : [];
  return {
    nodo: {
      ...nodoTot,
      /** Qué parte de todo lo vendido es este nivel (100 % arriba de todo). */
      participacionTotal: pct(nodoTot.ventaNeta, totalGeneral),
      /** Productos activos del nivel que no vendieron nada en el período. */
      sinVenta: esProd ? sinVentaR.rows.length : [...sinVentaDe.values()].reduce((s, n) => s + n, 0),
    },
    filas,
    sinVentas,
    sinVentasRecortado: esProd && sinVentaR.rows.length > 300,
  };
}

/* ============================== EL DETALLE DE UN PRODUCTO ============================== */
async function detalleProducto(c: PoolClient, f: Filtro, ant: Filtro, prod: any, catId: number, subId: number, marcaId: number, totalGeneral: number) {
  const wd = donde(f, 'f', true);
  const desglose = (sel: string, join: string, grupo: string) => {
    const q = parametros();
    for (const v of wd.params) q.lista.push(v);
    return c.query(
      `SELECT ${sel}, ${SUMAS('f')}, sum(f.unidades) AS unidades, sum(f.cantidad_base) AS cantidad_base
       FROM metricas_venta_prod_dia f ${join}
       WHERE ${wd.sql} AND f.producto_id = ${q.p(prod.id)} GROUP BY ${grupo} ORDER BY sum(f.venta_neta) DESC`, q.lista);
  };

  // El puesto dentro de su subcategoría, su categoría y todo: «el 3.º más vendido de 45».
  const qr = parametros();
  const cteR = cteProductos(f, ant, qr.p);
  const pcat = qr.p(catId); const psub = qr.p(subId); const pprod = qr.p(prod.id); const pmarca = qr.p(marcaId);
  const qm = parametros();
  const cteM = cteProductos(f, ant, qm.p);

  const [mio, sucs, pres, lists, rank] = await Promise.all([
    c.query(`WITH ${cteM} SELECT ${SUMAS_X} FROM x WHERE x.producto_id = ${qm.p(prod.id)}`, qm.lista),
    desglose(`f.sucursal_id AS clave, coalesce(s.nombre, 'Sin sucursal') AS nombre`, 'LEFT JOIN sucursales s ON s.id = f.sucursal_id', `f.sucursal_id, coalesce(s.nombre, 'Sin sucursal')`),
    desglose('f.presentacion_id AS clave, max(pr.tam_kg) AS tam_kg', 'LEFT JOIN presentaciones pr ON pr.id = f.presentacion_id', 'f.presentacion_id'),
    desglose(`f.lista_id AS clave, coalesce(lv.nombre, 'Sin lista') AS nombre`, 'LEFT JOIN listas_venta lv ON lv.id = f.lista_id', `f.lista_id, coalesce(lv.nombre, 'Sin lista')`),
    c.query(
      `WITH ${cteR},
       t AS (SELECT x.producto_id, x.va, ${CLAVE_CAT} AS cat, ${CLAVE_SUB} AS sub, ${CLAVE_MARCA} AS marca
             FROM x LEFT JOIN productos p ON p.id = x.producto_id WHERE ${VENDIO}),
       yo AS (SELECT coalesce(max(t.va), 0) AS va FROM t WHERE t.producto_id = ${pprod})
       SELECT
         count(*) FILTER (WHERE t.cat = ${pcat})::float8 AS en_cat,
         count(*) FILTER (WHERE t.cat = ${pcat} AND t.va > yo.va)::float8 AS antes_cat,
         coalesce(sum(t.va) FILTER (WHERE t.cat = ${pcat}), 0) AS venta_cat,
         count(*) FILTER (WHERE t.cat = ${pcat} AND t.sub = ${psub})::float8 AS en_sub,
         count(*) FILTER (WHERE t.cat = ${pcat} AND t.sub = ${psub} AND t.va > yo.va)::float8 AS antes_sub,
         coalesce(sum(t.va) FILTER (WHERE t.cat = ${pcat} AND t.sub = ${psub}), 0) AS venta_sub,
         count(*) FILTER (WHERE t.marca = ${pmarca})::float8 AS en_marca,
         count(*) FILTER (WHERE t.marca = ${pmarca} AND t.va > yo.va)::float8 AS antes_marca,
         coalesce(sum(t.va) FILTER (WHERE t.marca = ${pmarca}), 0) AS venta_marca,
         count(*)::float8 AS en_total,
         count(*) FILTER (WHERE t.va > yo.va)::float8 AS antes_total
       FROM t CROSS JOIN yo GROUP BY yo.va`,
      qr.lista),
  ]);

  const g = armarGrupo(mio.rows[0]);
  const vendio = g.renglones > 0 || Math.abs(g.ventaNeta) > 0.005;
  const rk = rank.rows[0] ?? {};
  const puesto = (antes: unknown, de: unknown) => (vendio && N(de) > 0 ? { puesto: N(antes) + 1, de: N(de) } : null);
  const esGranel = prod.tipo === 'granel';
  const desgl = (rows: any[], nombre: (x: any) => string) => rows.map((x: any) => {
    const s = armarSuma(x);
    return {
      clave: N(x.clave), nombre: nombre(x), ventaNeta: s.ventaNeta, margen: s.margen, margenPct: s.margenPct,
      unidades: s.unidades, cantidadBase: s.cantidadBase, participacion: pct(s.ventaNeta, g.ventaNeta),
    };
  });
  const nombrePres = (x: any) => {
    if (!N(x.clave)) return esGranel ? 'Suelto, al peso' : 'Por unidad';
    const t = N(x.tam_kg);
    return t > 0 ? `Paquete de ${t < 1 ? `${Math.round(t * 1000)} g` : `${t.toLocaleString('es-AR')} kg`}` : 'Presentación eliminada';
  };

  return {
    producto: {
      id: N(prod.id), nombre: prod.nombre as string, granel: esGranel, marca: prod.marca as string, estado: prod.estado as string,
      codigo: (prod.codigo_propio || prod.codigo_barras || '') as string,
    },
    nodo: {
      ...g,
      participacionTotal: pct(g.ventaNeta, totalGeneral),
      participacionCategoria: pct(g.ventaNeta, N(rk.venta_cat)),
      participacionSubcategoria: pct(g.ventaNeta, N(rk.venta_sub)),
      participacionMarca: pct(g.ventaNeta, N(rk.venta_marca)),
      /** Precio promedio cobrado (sin IVA): por kg en granel, por unidad en enteros. */
      precioPromedio: esGranel
        ? (g.kilosGranel > 0 ? r2(g.ventaNeta / g.kilosGranel) : null)
        : (g.unidadesEnteros > 0 ? r2(g.ventaNeta / g.unidadesEnteros) : null),
    },
    puesto: { subcategoria: puesto(rk.antes_sub, rk.en_sub), categoria: puesto(rk.antes_cat, rk.en_cat), marca: puesto(rk.antes_marca, rk.en_marca), total: puesto(rk.antes_total, rk.en_total) },
    /** La marca de HOY del producto (para «el 2.º de Cachafaz»). */
    marca: { id: marcaId, nombre: marcaId ? (prod.marca as string) || 'Marca eliminada' : 'Sin marca' },
    porSucursal: desgl(sucs.rows, (x) => x.nombre),
    porPresentacion: desgl(pres.rows, nombrePres),
    porLista: desgl(lists.rows, (x) => x.nombre),
  };
}
