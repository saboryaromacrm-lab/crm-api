/**
 * ASESOR COMERCIAL · LO QUE MIRA (0193)
 * ============================================================================
 * Las cuentas propias del comercial (las comunes están en ../datos.ts). Todas
 * de solo lectura y cortas. Los productos van con su id: así una propuesta
 * dice EXACTAMENTE qué producto o paquete, y se puede crear la oferta sin
 * adivinar por el nombre.
 */
import type { PoolClient } from 'pg';
import { N, r2, pct, variacion } from '../../metricas/consultas';
import { filtroTienda } from '../../web/metricas-tienda';
import { hoyAr, sumarDias } from '../../cafeteria/cuenta';
import { type Fuentes, enSerie } from '../datos';
import { mismaFechaAnioAnterior, proximasFechas } from './calendario';
import { type Promo, claveArticulo, precioBase, simular } from './simular';

const ZONA = 'America/Argentina/Buenos_Aires';
const r0 = (n: number) => Math.round(Number(n) || 0);
const r1 = (n: number) => Math.round((Number(n) || 0) * 10) / 10;

/* ============================== FECHAS ============================== */

/**
 * Lo que viene en los próximos `dias`: las fechas comerciales (calculadas), los
 * feriados de la tabla y las fechas propias del dueño. Para las primeras
 * fechas comerciales, cómo se vendió la misma semana del año pasado contra
 * las cuatro anteriores (y qué categorías subieron): el «efecto fecha».
 */
export async function fechas(c: PoolClient, dias = 75) {
  const hoy = hoyAr(); const hasta = sumarDias(hoy, dias);
  const faltan = (d: string) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / 86_400_000);
  const [feriados, propias] = await enSerie(
    () => c.query(`SELECT to_char(fecha, 'YYYY-MM-DD') AS fecha, nombre, tipo FROM feriados WHERE fecha BETWEEN $1::date AND $2::date ORDER BY fecha`, [hoy, hasta]),
    () => /* Las anuales se proyectan al año que corresponde (este o el que viene). */
    c.query(`SELECT nombre, nota, CASE WHEN anual THEN
        CASE WHEN make_date(extract(year FROM $1::date)::int, extract(month FROM fecha)::int, least(extract(day FROM fecha)::int, 28)) >= $1::date
          THEN make_date(extract(year FROM $1::date)::int, extract(month FROM fecha)::int, extract(day FROM fecha)::int)
          ELSE make_date(extract(year FROM $1::date)::int + 1, extract(month FROM fecha)::int, extract(day FROM fecha)::int) END
        ELSE fecha END AS cuando
      FROM asesor_fechas`, [hoy]));
  const comerciales = proximasFechas(hoy, dias);
  /* El efecto del año pasado, solo para las tres primeras (cada una son dos consultas cortas sobre la tabla resumen). */
  const efecto: any[] = [];
  for (const x of comerciales.slice(0, 3)) efecto.push(await (async () => {
    const antes = mismaFechaAnioAnterior(x.nombre, Number(x.fecha.slice(0, 4)));
    if (!antes) return null;
    const semana = { desde: sumarDias(antes, -6), hasta: antes };
    const previas = { desde: sumarDias(antes, -34), hasta: sumarDias(antes, -7) };
    const [tot, cats] = await enSerie(
      () => c.query(`SELECT coalesce(sum(venta_neta) FILTER (WHERE dia BETWEEN $1::date AND $2::date), 0)::float8 AS semana,
          coalesce(sum(venta_neta) FILTER (WHERE dia BETWEEN $3::date AND $4::date), 0)::float8 / 4 AS normal
        FROM metricas_venta_dia WHERE dia BETWEEN $3::date AND $2::date`, [semana.desde, semana.hasta, previas.desde, previas.hasta]),
      () => c.query(`SELECT coalesce(cat.nombre, 'Sin categoría') AS categoria,
          coalesce(sum(f.venta_neta) FILTER (WHERE f.dia BETWEEN $1::date AND $2::date), 0)::float8 AS semana,
          coalesce(sum(f.venta_neta) FILTER (WHERE f.dia BETWEEN $3::date AND $4::date), 0)::float8 / 4 AS normal
        FROM metricas_venta_prod_dia f JOIN productos p ON p.id = f.producto_id LEFT JOIN categorias cat ON cat.id = p.categoria_id
        WHERE f.dia BETWEEN $3::date AND $2::date GROUP BY 1`, [semana.desde, semana.hasta, previas.desde, previas.hasta]));
    const t: any = tot.rows[0];
    if (!N(t?.semana) && !N(t?.normal)) return { fecha: x.nombre, anioAnterior: antes, sinDatos: true };
    return {
      fecha: x.nombre, anioAnterior: antes,
      ventaSemanaPrevia: r0(t.semana), ventaSemanaNormal: r0(t.normal), variacionPct: variacion(N(t.semana), N(t.normal)),
      categoriasQueSubieron: cats.rows.filter((r: any) => N(r.semana) > N(r.normal) * 1.15 && N(r.semana) - N(r.normal) > 0)
        .sort((a: any, b: any) => (N(b.semana) - N(b.normal)) - (N(a.semana) - N(a.normal))).slice(0, 6)
        .map((r: any) => ({ categoria: r.categoria, semana: r0(r.semana), normal: r0(r.normal), variacionPct: variacion(N(r.semana), N(r.normal)) })),
    };
  })());
  return {
    hoy,
    fechasComerciales: comerciales.map((x) => ({ fecha: x.fecha, faltan: x.faltan, nombre: x.nombre, ...(x.aprox ? { aprox: true } : {}), nota: x.nota })),
    feriados: feriados.rows.map((r: any) => ({ fecha: r.fecha, faltan: faltan(r.fecha), nombre: r.nombre, tipo: r.tipo })),
    fechasPropias: propias.rows.map((r: any) => ({ fecha: new Date(r.cuando).toISOString().slice(0, 10), nombre: r.nombre, nota: r.nota }))
      .filter((r) => r.fecha >= hoy && r.fecha <= hasta).map((r) => ({ ...r, faltan: faltan(r.fecha) })).sort((a, b) => a.faltan - b.faltan),
    comoSeVendioElAnioPasado: efecto.filter(Boolean),
  };
}

/* ============================== VENCIMIENTOS ============================== */

/**
 * Los lotes cargados en Vencimientos que todavía no se procesaron y vencen en
 * `dias` (o ya vencieron): con el stock de hoy de ese artículo en esa sucursal,
 * lo que se vende por día (30 días) y si llega a venderse antes de vencer, y
 * la oferta que tiene atada (las automáticas de las reglas de vencimiento).
 */
export async function vencimientos(c: PoolClient, dias = 45, sucursalId: number | null = null) {
  const hoy = hoyAr(); const d30 = sumarDias(hoy, -29);
  const params: any[] = [dias, d30];
  const suc = sucursalId ? (params.push(sucursalId), ` AND v.sucursal_id = $${params.length}`) : '';
  const r = await c.query(
    `SELECT v.id, v.producto_id, coalesce(v.presentacion_id, 0) AS pres, v.sucursal_id, su.nombre AS sucursal, p.nombre AS producto,
       pr.tam_kg::float8 AS tam, to_char(v.fecha_vencimiento, 'YYYY-MM-DD') AS vence,
       (v.fecha_vencimiento - (now() AT TIME ZONE '${ZONA}')::date)::int AS dias,
       v.cantidad::float8 AS cargado, v.costo_unitario::float8 AS costo,
       coalesce((SELECT sum(s.cantidad) FROM stock s WHERE s.producto_id = v.producto_id AND s.sucursal_id = v.sucursal_id
         AND coalesce(s.presentacion_id, 0) = coalesce(v.presentacion_id, 0) AND s.estado = 'disponible'), 0)::float8 AS stock,
       coalesce((SELECT sum(m.unidades) FROM metricas_venta_prod_dia m WHERE m.producto_id = v.producto_id AND m.sucursal_id = v.sucursal_id
         AND coalesce(m.presentacion_id, 0) = coalesce(v.presentacion_id, 0) AND m.dia >= $2::date), 0)::float8 / 30 AS por_dia,
       o.nombre AS oferta, o.activa AS oferta_activa, o.auto_vencimiento AS oferta_auto
     FROM vencimientos v JOIN productos p ON p.id = v.producto_id JOIN sucursales su ON su.id = v.sucursal_id
     LEFT JOIN presentaciones pr ON pr.id = v.presentacion_id LEFT JOIN ofertas o ON o.id = v.oferta_id
     WHERE NOT v.procesado AND v.fecha_vencimiento <= (now() AT TIME ZONE '${ZONA}')::date + $1::int${suc}
     ORDER BY v.fecha_vencimiento, p.nombre LIMIT 80`, params);
  const lotes = r.rows.map((x: any) => {
    const quedan = Math.min(N(x.stock), N(x.cargado));
    const diasParaVender = N(x.por_dia) > 0 ? Math.round(quedan / N(x.por_dia)) : null;
    return {
      productoId: N(x.producto_id), presentacionId: N(x.pres), producto: x.producto, ...(x.tam ? { tamanoKg: N(x.tam) } : {}),
      sucursalId: N(x.sucursal_id), sucursal: x.sucursal, vence: x.vence, diasQueFaltan: N(x.dias),
      cargado: r1(x.cargado), stockHoy: r1(x.stock), vendePorDia: r1(x.por_dia), valorACosto: r0(quedan * N(x.costo)),
      diasParaVenderloAlRitmoDeHoy: diasParaVender,
      llegaAVenderse: N(x.dias) >= 0 && diasParaVender != null && diasParaVender <= N(x.dias),
      oferta: x.oferta ? { nombre: x.oferta, activa: !!x.oferta_activa, automatica: !!x.oferta_auto } : null,
    };
  }).filter((x) => x.stockHoy > 0);
  const enRiesgo = lotes.filter((x) => !x.llegaAVenderse);
  return {
    nota: 'Lotes cargados en Almacén › Vencimientos sin procesar. «llegaAVenderse»: con lo que se vende por día hoy, se termina antes de vencer. Las ofertas automáticas salen de las reglas de vencimiento (−25 % a 30 días, −40 % a 15, al costo a 7).',
    lotes: lotes.length, valorEnRiesgoACosto: r0(enRiesgo.reduce((s, x) => s + x.valorACosto, 0)),
    vencidosSinProcesar: lotes.filter((x) => x.diasQueFaltan < 0).length,
    detalle: lotes.slice(0, 40),
  };
}

/* ============================== OFERTAS ARMADAS ============================== */

/** Las ofertas activas que están corriendo o arrancan más adelante: lo que ya hay armado. */
export async function ofertasArmadas(c: PoolClient) {
  const r = await c.query(
    `SELECT o.id, o.nombre, o.tipo::text AS tipo, o.porcentaje::float8, o.precio::float8, o.lleva::float8, o.paga::float8, o.monto_minimo::float8 AS minimo,
       to_char(o.desde AT TIME ZONE '${ZONA}', 'YYYY-MM-DD') AS desde, to_char(o.hasta AT TIME ZONE '${ZONA}', 'YYYY-MM-DD') AS hasta,
       o.dias, o.auto_vencimiento AS auto, o.por_vencer,
       (SELECT count(*) FROM oferta_alcances a WHERE a.oferta_id = o.id)::int AS alcances,
       (SELECT count(*) FROM oferta_componentes k WHERE k.oferta_id = o.id)::int AS componentes
     FROM ofertas o WHERE o.activa AND (o.hasta IS NULL OR o.hasta >= now()) ORDER BY o.desde NULLS FIRST, o.id`);
  const hoy = hoyAr();
  return r.rows.map((o: any) => ({
    oferta: o.nombre, tipo: o.tipo, estado: o.desde && o.desde > hoy ? 'programada' : 'vigente',
    desde: o.desde, hasta: o.hasta, ...(o.dias && o.dias !== '1111111' ? { dias: o.dias } : {}),
    ...(o.porcentaje ? { porcentaje: o.porcentaje } : {}), ...(o.precio ? { precioFinal: o.precio } : {}),
    ...(o.lleva ? { lleva: o.lleva, paga: o.paga } : {}), ...(o.minimo ? { montoMinimo: o.minimo } : {}),
    ...(o.auto ? { automaticaPorVencimiento: true } : {}), alcanza: o.componentes ? `${o.componentes} productos (combo)` : `${o.alcances} artículo(s)/marca(s)/categoría(s)`,
  }));
}

/* ============================== LO QUE SE COMPRA JUNTO ============================== */

/**
 * Los pares de productos que más aparecen en el MISMO ticket (`dias` atrás):
 * la base de un combo. `lift` > 1 = se compran juntos más de lo que tocaría
 * por azar (2 = el doble). Sobre las ventas confirmadas (índices por fecha y
 * por venta); los pares con menos de 3 tickets no cuentan.
 */
export async function compradosJuntos(c: PoolClient, dias = 60, sucursalId: number | null = null, limite = 25) {
  const params: any[] = [dias];
  const suc = sucursalId ? (params.push(sucursalId), ` AND v.sucursal_id = $${params.length}`) : '';
  const r = await c.query(
    `WITH it AS (
       SELECT DISTINCT vi.venta_id, vi.producto_id
       FROM ventas v JOIN venta_items vi ON vi.venta_id = v.id
       WHERE v.fecha >= now() - ($1::int * interval '1 day') AND v.estado IN ('confirmada', 'pendiente_cae')
         AND v.tipo::text NOT LIKE 'nota_credito%'${suc}),
     tot AS (SELECT count(DISTINCT venta_id)::float8 AS n FROM it),
     f AS (SELECT producto_id, count(*)::float8 AS c FROM it GROUP BY 1),
     p AS (SELECT a.producto_id AS x, b.producto_id AS y, count(*)::float8 AS c
           FROM it a JOIN it b ON a.venta_id = b.venta_id AND a.producto_id < b.producto_id
           GROUP BY 1, 2 HAVING count(*) >= 3)
     SELECT p.x, p.y, p.c, fx.c AS cx, fy.c AS cy, tot.n, px.nombre AS nx, py.nombre AS ny
     FROM p JOIN f fx ON fx.producto_id = p.x JOIN f fy ON fy.producto_id = p.y CROSS JOIN tot
     JOIN productos px ON px.id = p.x JOIN productos py ON py.id = p.y
     ORDER BY p.c DESC LIMIT 200`, params);
  const n = N(r.rows[0]?.n);
  return {
    ultimosDias: dias, tickets: r0(n),
    pares: r.rows.map((x: any) => ({
      productoA: { productoId: N(x.x), nombre: x.nx }, productoB: { productoId: N(x.y), nombre: x.ny },
      ticketsJuntos: r0(x.c), pctDeLosTicketsDeA: pct(N(x.c), N(x.cx)), lift: N(x.cx) && N(x.cy) ? r2((N(x.c) * n) / (N(x.cx) * N(x.cy))) : null,
    })).filter((x) => (x.lift ?? 0) >= 1.2).slice(0, Math.min(Math.max(limite, 1), 60)),
  };
}

/* ============================== TIENDA ONLINE ============================== */

/** Cómo viene cada tienda (minorista y mayorista) en `dias` contra los anteriores: tráfico, embudo, qué se mira y no se compra. */
export async function tiendaOnline(f: Fuentes, dias = 30) {
  const hoy = hoyAr();
  const lado = async (modo: 'minorista' | 'mayorista') => {
    const m: any = await f.tienda.metricas(filtroTienda({ modo, desde: sumarDias(hoy, -(dias - 1)), hasta: hoy, paso: 'dia' }));
    const res = Object.fromEntries(Object.entries(m.resumen ?? {}).map(([k, v]: [string, any]) => [k, { ahora: v?.ahora ?? null, antes: v?.antes ?? null, variacionPct: v?.variacion ?? null }]));
    const ranking: any[] = m.productos?.ranking ?? [];
    return {
      resumen: res,
      embudo: m.embudo,
      masVistos: ranking.slice().sort((a, b) => b.vistas - a.vistas).slice(0, 12)
        .map((x) => ({ productoId: x.id, producto: x.nombre, vistas: x.vistas, alCarrito: x.carrito, pedidos: x.pedidos, total: r0(x.total) })),
      /* Mucho interés y poca compra: candidatos a revisar precio, foto o a ponerles oferta. */
      seMiranYNoSeCompran: ranking.filter((x) => x.vistas >= 20 && x.pedidos <= Math.max(1, x.vistas * 0.02)).sort((a, b) => b.vistas - a.vistas).slice(0, 10)
        .map((x) => ({ productoId: x.id, producto: x.nombre, vistas: x.vistas, alCarrito: x.carrito, pedidos: x.pedidos })),
      busquedasMasHechas: (m.productos?.busquedas ?? []).slice(0, 20),
      ofertasEnLaTienda: (m.ofertas?.lista ?? []).slice(0, 12).map((o: any) => ({
        oferta: o.nombre, estado: o.estado, vistas: o.vistas, alCarrito: o.carrito, pedidos: o.pedidos, total: r0(o.total), descuento: r0(o.descuento),
      })),
    };
  };
  const [minorista, mayorista] = await Promise.all([lado('minorista'), lado('mayorista')]);
  return {
    ultimosDias: dias,
    nota: 'Importes de pedidos con IVA. «sesiones» = visitantes. Los pedidos se cierran (se cobran) en la caja: «cerrados» es lo que terminó en venta.',
    minorista, mayorista,
  };
}

/* ============================== CUPONES ============================== */

export async function cupones(f: Fuentes, desde: string, hasta: string) {
  const r: any = await f.cupones.listar(desde, hasta);
  return {
    periodo: `${desde} a ${hasta}`, ticketPromedioSinCupon: r.referencia?.ticketPromedioSinCupon ?? null,
    cupones: (r.cupones ?? []).filter((x: any) => x.activo || x.usos?.total).slice(0, 15).map((x: any) => ({
      codigo: x.codigo, activo: x.activo, usos: x.usos?.total ?? 0, clientesNuevos: x.usos?.clientesNuevos ?? 0,
      ventaNeta: r0(x.ventas?.ventaNeta), descuento: r0(x.ventas?.descuentoCupon), ganancia: r0(x.ventas?.gananciaFinal),
      ticketPromedio: r0(x.ventas?.ticketPromedio),
    })),
  };
}

/* ============================== SIMULAR ============================== */

/** Cuánto deja una promoción, con los precios y costos de hoy (ver simular.ts). */
export async function simularPromo(f: Fuentes, c: PoolClient, p: Promo) {
  const items = p.productos.map((x) => ({ productoId: x.productoId, presentacionId: x.presentacionId > 0 ? x.presentacionId : null }));
  const [articulos, nombres] = await Promise.all([f.precios.articulos(items), nombresDe(c, p.productos)]);
  return simular(p, articulos, nombres);
}

/**
 * El precio de hoy (final, de la lista base) y el costo (neto) de los artículos
 * que aparecen en la foto: para que la IA arme cada promoción sobre el precio
 * real y no sobre un promedio de lo vendido. Una sola consulta en lote.
 */
export async function preciosDeHoy(f: Fuentes, items: { productoId: number; presentacionId?: number | null }[]) {
  const unicos = [...new Map(items.filter((x) => x.productoId > 0).map((x) => [claveArticulo(x.productoId, x.presentacionId), x])).values()].slice(0, 120);
  if (!unicos.length) return [];
  const arts = await f.precios.articulos(unicos.map((x) => ({ productoId: x.productoId, presentacionId: x.presentacionId || null })));
  return unicos.flatMap((x) => {
    const a = arts.get(claveArticulo(x.productoId, x.presentacionId));
    const precio = a ? precioBase(a) : null;
    return a && precio != null
      ? [{ productoId: x.productoId, ...(x.presentacionId ? { presentacionId: x.presentacionId } : {}), precioFinal: r2(precio), costoSinIva: r2(a.costoReal), ivaPct: a.iva }]
      : [];
  });
}

/** «Nombre» o «Nombre · 0,25 kg» de cada artículo, para que la simulación hable claro. */
export async function nombresDe(c: PoolClient, items: { productoId: number; presentacionId: number }[]) {
  const out = new Map<string, string>();
  if (!items.length) return out;
  const r = await c.query(
    `SELECT p.id, p.nombre, pr.id AS pres, pr.tam_kg::float8 AS tam FROM productos p
     LEFT JOIN presentaciones pr ON pr.producto_id = p.id AND pr.id = ANY($2) WHERE p.id = ANY($1)`,
    [[...new Set(items.map((x) => x.productoId))], items.map((x) => x.presentacionId).filter((x) => x > 0)]);
  for (const x of r.rows as any[]) {
    out.set(claveArticulo(N(x.id), 0), x.nombre);
    if (x.pres) out.set(claveArticulo(N(x.id), N(x.pres)), `${x.nombre} · ${String(x.tam).replace('.', ',')} kg`);
  }
  return out;
}
