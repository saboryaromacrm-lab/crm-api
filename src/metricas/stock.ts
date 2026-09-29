/**
 * MÉTRICAS · STOCK QUE ROTA Y STOCK PARADO (0122, 29/9/2026)
 * ============================================================================
 * Cuánta plata hay en mercadería (a costo de HOY, con la misma cuenta que
 * Gerencia), qué se vende rápido, qué está por agotarse y qué no se vende hace
 * meses. El stock sale de la tabla de stock (es una foto de hoy, chica); lo
 * vendido, de la tabla resumen — nunca de las ventas una por una.
 *
 * TODO EN UNIDAD BASE: kg para el granel, unidades para lo entero. Un paquete
 * de 500 g suma 0,5. Así el stock y lo vendido hablan de lo mismo y los «días
 * de stock» no mezclan paquetes con kilos.
 *
 * LA MERCADERÍA DE COFFIT VA APARTE: los artículos de uso exclusivo de Coffit
 * están guardados acá pero su costo ya se le cargó a ella; sumarlos al valor de
 * Sabor y Aroma inflaría la plata «propia».
 */
import { and, gt, inArray, ne, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { Database } from '../db/drizzle';
import { marcas, categorias, presentaciones, productoProveedores, productos, stock, sucursales } from '../db/schema';
import { costosFormato, escalaPaquete, formatoDeCosto } from '../inventario/pricing';
import { hoyAr, sumarDias } from '../cafeteria/cuenta';

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const r3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;

/** Estados que siguen siendo mercadería propia (los defectuosos y vencidos ya son pérdida). */
const ESTADOS_PROPIOS = ['disponible', 'comprometido', 'retenido', 'en_transito'] as const;
export const UMBRALES = { agotarseDias: 7, sobrestockDias: 180, historiaDias: 730 } as const;

export async function reporteStock(
  db: Database, pool: Pool, q: { sucursalId: number | null; ventana: number },
) {
  const hoy = hoyAr();
  const ventana = [30, 60, 90].includes(q.ventana) ? q.ventana : 60;
  const desdeVentana = sumarDias(hoy, -(ventana - 1));
  const desdeHistoria = sumarDias(hoy, -UMBRALES.historiaDias);

  const cond = [gt(stock.cantidad, 1e-9), inArray(stock.estado, ESTADOS_PROPIOS as any)];
  if (q.sucursalId) cond.push(sql`${stock.sucursalId} = ${q.sucursalId}`);

  const [filas, prods, provs, marcasR, catsR, sucs, press, ventas] = await Promise.all([
    db.select().from(stock).where(and(...cond)),
    db.select().from(productos).where(ne(productos.estado, 'archivado' as any)),
    db.select().from(productoProveedores),
    db.select().from(marcas),
    db.select().from(categorias),
    db.select({ id: sucursales.id, nombre: sucursales.nombre }).from(sucursales),
    db.select({ id: presentaciones.id, tamKg: presentaciones.tamKg }).from(presentaciones),
    // Lo vendido, por producto, sobre la tabla resumen: unas pocas miles de filas por año.
    pool.query(
      `SELECT producto_id,
         coalesce(sum(cantidad_base) FILTER (WHERE dia >= $2::date), 0)::float8 AS vendido,
         coalesce(sum(cantidad_base) FILTER (WHERE dia >= $3::date), 0)::float8 AS vendido_ultimo,
         max(dia) FILTER (WHERE cantidad_base > 0)::text AS ultima_venta
       FROM metricas_venta_prod_dia
       WHERE dia >= $1::date ${q.sucursalId ? 'AND sucursal_id = $4' : ''}
       GROUP BY producto_id`,
      q.sucursalId ? [desdeHistoria, desdeVentana, sumarDias(hoy, -6), q.sucursalId] : [desdeHistoria, desdeVentana, sumarDias(hoy, -6)]),
  ]);

  const infoProd = new Map(prods.map((p: any) => [p.id, p]));
  const provsDe = new Map<number, any[]>();
  for (const f of provs) { const a = provsDe.get(f.productoId); if (a) a.push(f); else provsDe.set(f.productoId, [f]); }
  const tamDe = new Map(press.map((p: any) => [p.id, Number(p.tamKg)]));
  const nombreSuc = new Map(sucs.map((s: any) => [s.id, s.nombre]));
  const nombreMarca = new Map(marcasR.map((m: any) => [m.id, m.nombre]));
  const nombreCat = new Map(catsR.map((c: any) => [c.id, c.nombre]));
  const vendidoDe = new Map<number, { vendido: number; ultima: string | null }>(
    ventas.rows.map((x: any) => [Number(x.producto_id), { vendido: Number(x.vendido), ultima: x.ultima_venta ?? null }]));

  /** Costo de HOY por unidad base (neto, sin IVA), con la misma cuenta que Gerencia. */
  const costoDe = new Map<number, number>();
  const costo = (p: any) => {
    if (!costoDe.has(p.id)) costoDe.set(p.id, costosFormato(formatoDeCosto(p, provsDe.get(p.id) ?? []) as any, p.iva).costoNetoUnitario);
    return costoDe.get(p.id)!;
  };

  type Acum = { cant: number; valor: number; porSuc: Map<number, number> };
  const porProd = new Map<number, Acum>();
  const porSucursal = new Map<number, { valor: number; productos: Set<number> }>();
  for (const f of filas) {
    const p: any = infoProd.get(f.productoId);
    if (!p) continue; // archivado: ya no se maneja
    const tam = f.presentacionId ? (tamDe.get(f.presentacionId) ?? 0) : 1;
    const base = f.cantidad * (f.presentacionId ? tam : 1);
    const escala = f.presentacionId ? escalaPaquete(tam, Number(p.merma) || 0) : 1;
    const valor = f.cantidad * costo(p) * escala;
    const a = porProd.get(p.id) ?? { cant: 0, valor: 0, porSuc: new Map() };
    a.cant += base; a.valor += valor;
    a.porSuc.set(f.sucursalId, (a.porSuc.get(f.sucursalId) ?? 0) + base);
    porProd.set(p.id, a);
    if (!p.soloCafeteria) {
      const s = porSucursal.get(f.sucursalId) ?? { valor: 0, productos: new Set<number>() };
      s.valor += valor; s.productos.add(p.id);
      porSucursal.set(f.sucursalId, s);
    }
  }

  let valorPropio = 0; let valorCoffit = 0; let valorParado = 0; let productosParados = 0;
  let productosPorAgotarse = 0; let valorSobrestock = 0;
  const lista = [...porProd.entries()].map(([id, a]) => {
    const p: any = infoProd.get(id);
    const v = vendidoDe.get(id);
    const vendido = v?.vendido ?? 0;
    const porDia = vendido / ventana;
    const diasDeStock = porDia > 0 ? Math.round(a.cant / porDia) : null;
    const deCoffit = !!p.soloCafeteria;
    let estado: 'parado' | 'por_agotarse' | 'sobrestock' | 'ok' = 'ok';
    if (vendido <= 0) estado = 'parado';
    else if (diasDeStock != null && diasDeStock < UMBRALES.agotarseDias) estado = 'por_agotarse';
    else if (diasDeStock != null && diasDeStock > UMBRALES.sobrestockDias) estado = 'sobrestock';
    if (deCoffit) valorCoffit += a.valor;
    else {
      valorPropio += a.valor;
      if (estado === 'parado') { valorParado += a.valor; productosParados += 1; }
      if (estado === 'por_agotarse') productosPorAgotarse += 1;
      if (estado === 'sobrestock') valorSobrestock += a.valor;
    }
    return {
      productoId: id, nombre: p.nombre as string, categoria: nombreCat.get(p.categoriaId) ?? '', marca: nombreMarca.get(p.marcaId) ?? '',
      unidad: p.tipo === 'granel' ? 'kg' : 'u.', stock: r3(a.cant), valor: r2(a.valor), costoUnitario: r2(costo(p)),
      vendido: r3(vendido), promedioPorDia: r3(porDia), diasDeStock, ultimaVenta: v?.ultima ?? null,
      estado, deCoffit,
    };
  }).sort((x, y) => y.valor - x.valor);

  return {
    hoy, ventana, umbrales: UMBRALES,
    resumen: {
      valorPropio: r2(valorPropio), valorCoffit: r2(valorCoffit),
      productosConStock: lista.filter((x) => !x.deCoffit).length,
      valorParado: r2(valorParado), productosParados,
      porcentajeParado: valorPropio > 0 ? r2((valorParado / valorPropio) * 100) : null,
      productosPorAgotarse, valorSobrestock: r2(valorSobrestock),
    },
    porSucursal: [...porSucursal.entries()]
      .map(([id, s]) => ({ sucursalId: id, nombre: nombreSuc.get(id) ?? 'Sin sucursal', valor: r2(s.valor), productos: s.productos.size }))
      .sort((a, b) => b.valor - a.valor),
    /** Los 1.000 artículos que más plata tienen: alcanza para decidir, y el payload no crece con el catálogo. */
    filas: lista.slice(0, 1000),
    recortado: lista.length > 1000,
  };
}
