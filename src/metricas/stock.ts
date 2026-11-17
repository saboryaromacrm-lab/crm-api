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
 *
 * A PRECIO DE VENTA (17/11/2026): el mismo stock al precio de mostrador (el
 * piso: la lista base o, si el producto no la tiene, la última), neto de IVA y
 * con la misma función que la ficha, el POS y el historial de precios. El granel
 * que se vende solo fraccionado vale lo que deja envasado (ver `precioKg`). Lo
 * que no tiene formato de venta queda SIN precio (null), no en cero: no se puede cobrar.
 */
import { and, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { Database } from '../db/drizzle';
import {
  marcas, categorias, listasVenta, presentaciones, productoListas, productoProveedores, productos, proveedores, stock, sucursales,
} from '../db/schema';
import { costosFormato, escalaPaquete, formatoDeCosto, precioVentaFila } from '../inventario/pricing';
import { VENTAS_DEFAULTS } from '../configuracion/configuracion.module';
import { hoyAr, sumarDias } from '../cafeteria/cuenta';

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const r3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;

/** Estados que siguen siendo mercadería propia (los defectuosos y vencidos ya son pérdida). */
const ESTADOS_PROPIOS = ['disponible', 'comprometido', 'retenido', 'en_transito'] as const;
export const UMBRALES = { agotarseDias: 7, sobrestockDias: 180, historiaDias: 730 } as const;

/** El piso: la fila de la lista base o, si no la tiene, la última por orden (la de mostrador). La regla de la ficha y el POS. */
function filaPiso<T extends { listaId: number }>(filas: T[], ordenDe: Map<number, number>, baseId: number | null): T | null {
  const suyas = filas.filter((f) => ordenDe.has(f.listaId)).sort((a, b) => ordenDe.get(a.listaId)! - ordenDe.get(b.listaId)!);
  return suyas.find((f) => f.listaId === baseId) ?? suyas[suyas.length - 1] ?? null;
}

/**
 * UNA FILA POR PRODUCTO CON STOCK, VALUADA A COSTO DE HOY (14/10/2026): la
 * cuenta de esta pantalla, separada para que Proveedores › Montos use LA MISMA
 * (así los dos números nunca difieren). Cada fila trae además el proveedor que
 * fija el precio, el tipo, la categoría y la marca, para agrupar y filtrar.
 */
export async function valorizarStock(
  db: Database, pool: Pool, q: { sucursalId: number | null; ventana: number },
) {
  const hoy = hoyAr();
  const ventana = [30, 60, 90].includes(q.ventana) ? q.ventana : 60;
  const desdeVentana = sumarDias(hoy, -(ventana - 1));
  const desdeHistoria = sumarDias(hoy, -UMBRALES.historiaDias);
  const desdeAnio = sumarDias(hoy, -364);

  const cond = [gt(stock.cantidad, 1e-9), inArray(stock.estado, ESTADOS_PROPIOS as any)];
  if (q.sucursalId) cond.push(sql`${stock.sucursalId} = ${q.sucursalId}`);

  const [filas, prods, provs, marcasR, catsR, sucs, press, formatosVenta, listas, cfgVentas, ventas] = await Promise.all([
    db.select().from(stock).where(and(...cond)),
    db.select().from(productos).where(ne(productos.estado, 'archivado' as any)),
    db.select().from(productoProveedores),
    db.select().from(marcas),
    db.select().from(categorias),
    db.select({ id: sucursales.id, nombre: sucursales.nombre }).from(sucursales),
    db.select({ id: presentaciones.id, productoId: presentaciones.productoId, tamKg: presentaciones.tamKg }).from(presentaciones),
    db.select().from(productoListas),
    db.select({ id: listasVenta.id, orden: listasVenta.orden }).from(listasVenta).where(eq(listasVenta.activa, true)),
    pool.query(`SELECT valor FROM configuracion WHERE clave = 'ventas'`),
    // Lo vendido, por producto, sobre la tabla resumen: unas pocas miles de filas por año.
    // El margen y el costo de lo vendido del último año (los de Rentabilidad: solo
    // renglones con costo congelado) miden cuánto rinde cada peso de stock.
    pool.query(
      `SELECT producto_id,
         coalesce(sum(cantidad_base) FILTER (WHERE dia >= $2::date), 0)::float8 AS vendido,
         coalesce(sum(venta_costeada - costo) FILTER (WHERE dia >= $3::date), 0)::float8 AS margen_anio,
         coalesce(sum(costo) FILTER (WHERE dia >= $3::date), 0)::float8 AS costo_anio,
         max(dia) FILTER (WHERE cantidad_base > 0)::text AS ultima_venta
       FROM metricas_venta_prod_dia
       WHERE dia >= $1::date ${q.sucursalId ? 'AND sucursal_id = $4' : ''}
       GROUP BY producto_id`,
      q.sucursalId ? [desdeHistoria, desdeVentana, desdeAnio, q.sucursalId] : [desdeHistoria, desdeVentana, desdeAnio]),
  ]);

  const infoProd = new Map(prods.map((p: any) => [p.id, p]));
  const provsDe = new Map<number, any[]>();
  for (const f of provs) { const a = provsDe.get(f.productoId); if (a) a.push(f); else provsDe.set(f.productoId, [f]); }
  const tamDe = new Map(press.map((p) => [p.id, Number(p.tamKg)]));
  const paquetesDe = new Map<number, number[]>();
  for (const pr of press) { const a = paquetesDe.get(pr.productoId); if (a) a.push(pr.id); else paquetesDe.set(pr.productoId, [pr.id]); }
  const nombreSuc = new Map(sucs.map((s: any) => [s.id, s.nombre]));
  const nombreMarca = new Map(marcasR.map((m: any) => [m.id, m.nombre]));
  const nombreCat = new Map(catsR.map((c: any) => [c.id, c.nombre]));
  const vendidoDe = new Map<number, { vendido: number; margenAnio: number; costoAnio: number; ultima: string | null }>(
    ventas.rows.map((x: any) => [Number(x.producto_id), {
      vendido: Number(x.vendido), margenAnio: Number(x.margen_anio), costoAnio: Number(x.costo_anio), ultima: x.ultima_venta ?? null,
    }]));

  /** Costo de HOY por unidad base (neto, sin IVA) con la misma cuenta que Gerencia, la base del precio (0072) y el proveedor de ese formato. */
  const costoDe = new Map<number, { costo: number; costoPrecio: number; proveedorId: number | null }>();
  const costo = (p: any) => {
    let c = costoDe.get(p.id);
    if (!c) {
      const formato: any = formatoDeCosto(p, provsDe.get(p.id) ?? []);
      const cf = costosFormato(formato, p.iva);
      c = { costo: cf.costoNetoUnitario, costoPrecio: cf.costoPrecioUnitario, proveedorId: formato?.proveedorId ?? null };
      costoDe.set(p.id, c);
    }
    return c;
  };

  /* El precio de mostrador, neto, por unidad (un paquete: por paquete). */
  const cfg = { ...VENTAS_DEFAULTS, ...(cfgVentas.rows[0]?.valor ?? {}) };
  const ordenDe = new Map([...listas].sort((a, b) => a.orden - b.orden || a.id - b.id).map((l, i) => [l.id, i]));
  const baseId = ordenDe.has(cfg.listaBaseId) ? cfg.listaBaseId : ([...ordenDe.keys()][0] ?? null);
  const formatosDe = new Map<string, (typeof formatosVenta)[number][]>();
  for (const f of formatosVenta) {
    const k = `${f.productoId}:${f.presentacionId ?? ''}`;
    const a = formatosDe.get(k); if (a) a.push(f); else formatosDe.set(k, [f]);
  }
  const precioDe = new Map<string, number | null>();
  /** `escala`: lo que el paquete consume del kilo (1 = suelto). null = sin formato de venta: no se puede cobrar. */
  const precio = (p: any, presentacionId: number | null, escala: number) => {
    const k = `${p.id}:${presentacionId ?? ''}`;
    if (!precioDe.has(k)) {
      const fila = filaPiso(formatosDe.get(k) ?? [], ordenDe, baseId);
      const neto = fila
        ? precioVentaFila(costo(p).costoPrecio * escala, fila as any, { iva: p.iva, redondeo: p.redondeo ?? cfg.redondeoPrecio }).netoUnitario
        : 0;
      precioDe.set(k, neto > 0 ? neto : null);
    }
    return precioDe.get(k)!;
  };
  /**
   * Un kilo de granel SUELTO: a su precio suelto o, si el granel se vende solo
   * fraccionado (no tiene formato suelto), a lo que deja ese kilo envasado en el
   * paquete que MENOS rinde por kilo (precio del paquete ÷ lo que consume con la
   * merma). Lo conservador: no se infla el valor suponiendo la bolsa más chica.
   */
  const precioKg = (p: any) => {
    const suelto = precio(p, null, 1);
    if (suelto != null || p.tipo !== 'granel') return suelto;
    const porKg = (paquetesDe.get(p.id) ?? []).map((id) => {
      const escala = escalaPaquete(tamDe.get(id) ?? 0, Number(p.merma) || 0);
      const pv = escala > 0 ? precio(p, id, escala) : null;
      return pv == null ? null : pv / escala;
    }).filter((x): x is number => x != null);
    return porKg.length ? Math.min(...porKg) : null;
  };

  type Acum = { cant: number; valor: number; venta: number; sinPrecio: boolean };
  const porProd = new Map<number, Acum>();
  const porSucursal = new Map<number, { valor: number; productos: Set<number> }>();
  /** Cantidad y plata de cada producto en cada local: Stock valorizado la reparte según sus filtros y la foto diaria la guarda. */
  const porProdSuc = new Map<number, Map<number, { cant: number; valor: number }>>();
  for (const f of filas) {
    const p: any = infoProd.get(f.productoId);
    if (!p) continue; // archivado: ya no se maneja
    const tam = f.presentacionId ? (tamDe.get(f.presentacionId) ?? 0) : 1;
    const base = f.cantidad * (f.presentacionId ? tam : 1);
    const escala = f.presentacionId ? escalaPaquete(tam, Number(p.merma) || 0) : 1;
    const valor = f.cantidad * costo(p).costo * escala;
    const pv = f.presentacionId ? precio(p, f.presentacionId, escala) : precioKg(p);
    const a = porProd.get(p.id) ?? { cant: 0, valor: 0, venta: 0, sinPrecio: false };
    a.cant += base; a.valor += valor;
    if (pv == null) a.sinPrecio = true; else a.venta += f.cantidad * pv;
    porProd.set(p.id, a);
    const enSuc = porProdSuc.get(p.id) ?? new Map<number, { cant: number; valor: number }>();
    const x = enSuc.get(f.sucursalId) ?? { cant: 0, valor: 0 };
    x.cant += base; x.valor += valor;
    enSuc.set(f.sucursalId, x);
    porProdSuc.set(p.id, enSuc);
    if (!p.soloCafeteria) {
      const s = porSucursal.get(f.sucursalId) ?? { valor: 0, productos: new Set<number>() };
      s.valor += valor; s.productos.add(p.id);
      porSucursal.set(f.sucursalId, s);
    }
  }

  const lista = [...porProd.entries()].map(([id, a]) => {
    const p: any = infoProd.get(id);
    const v = vendidoDe.get(id);
    const vendido = v?.vendido ?? 0;
    const porDia = vendido / ventana;
    const diasDeStock = porDia > 0 ? Math.round(a.cant / porDia) : null;
    let estado: 'parado' | 'por_agotarse' | 'sobrestock' | 'ok' = 'ok';
    if (vendido <= 0) estado = 'parado';
    else if (diasDeStock != null && diasDeStock < UMBRALES.agotarseDias) estado = 'por_agotarse';
    else if (diasDeStock != null && diasDeStock > UMBRALES.sobrestockDias) estado = 'sobrestock';
    const { costo: costoUnit, proveedorId } = costo(p);
    return {
      productoId: id, nombre: p.nombre as string, categoria: nombreCat.get(p.categoriaId) ?? '', marca: nombreMarca.get(p.marcaId) ?? '',
      unidad: p.tipo === 'granel' ? 'kg' : 'u.', stock: r3(a.cant), valor: r2(a.valor), costoUnitario: r2(costoUnit),
      vendido: r3(vendido), promedioPorDia: r3(porDia), diasDeStock, ultimaVenta: v?.ultima ?? null,
      estado, deCoffit: !!p.soloCafeteria,
      /** A precio de mostrador, neto. null: el suelto o algún paquete no tiene formato de venta. */
      valorVenta: a.sinPrecio ? null : r2(a.venta),
      /** Margen y costo de lo vendido en los últimos 365 días: la rotación y el rendimiento del stock. */
      margenAnio: r2(v?.margenAnio ?? 0), costoVendidoAnio: r2(v?.costoAnio ?? 0),
      proveedorId, tipo: p.tipo as string, categoriaId: (p.categoriaId ?? null) as number | null, marcaId: (p.marcaId ?? null) as number | null,
    };
  }).sort((x, y) => y.valor - x.valor);

  return { hoy, ventana, lista, porSucursal, porProdSuc, nombreSuc, nombreCat, nombreMarca };
}

/**
 * GERENCIA › STOCK VALORIZADO (17/11/2026, pedido del dueño: antes era la
 * pestaña Stock de Métricas). Viajan TODOS los artículos con stock —unos pocos
 * miles como mucho— con su proveedor, su marca, su categoría y su plata en cada
 * local, así la pantalla filtra, ordena y vuelve a sumar al instante sin
 * volver a preguntar. Los totales de arriba son los de todo el stock.
 */
export async function reporteStock(
  db: Database, pool: Pool, q: { sucursalId: number | null; ventana: number },
) {
  const { hoy, ventana, lista, porSucursal, porProdSuc, nombreSuc } = await valorizarStock(db, pool, q);
  const idsProv = [...new Set(lista.map((x) => x.proveedorId).filter((id): id is number => id != null))];
  const provs = idsProv.length
    ? await db.select({ id: proveedores.id, nombre: proveedores.nombre }).from(proveedores).where(inArray(proveedores.id, idsProv))
    : [];
  const nombreProv = new Map(provs.map((p) => [p.id, p.nombre]));

  let valorPropio = 0; let valorCoffit = 0; let valorParado = 0; let productosParados = 0;
  let productosPorAgotarse = 0; let valorSobrestock = 0;
  for (const x of lista) {
    if (x.deCoffit) { valorCoffit += x.valor; continue; }
    valorPropio += x.valor;
    if (x.estado === 'parado') { valorParado += x.valor; productosParados += 1; }
    if (x.estado === 'por_agotarse') productosPorAgotarse += 1;
    if (x.estado === 'sobrestock') valorSobrestock += x.valor;
  }

  return {
    hoy, ventana, umbrales: UMBRALES,
    resumen: {
      valorPropio: r2(valorPropio), valorCoffit: r2(valorCoffit),
      productosConStock: lista.filter((x) => !x.deCoffit).length,
      valorParado: r2(valorParado), productosParados,
      porcentajeParado: valorPropio > 0 ? r2((valorParado / valorPropio) * 100) : null,
      productosPorAgotarse, valorSobrestock: r2(valorSobrestock),
    },
    /** Lo usa también la Vista profesional. */
    porSucursal: [...porSucursal.entries()]
      .map(([id, s]) => ({ sucursalId: id, nombre: nombreSuc.get(id) ?? 'Sin sucursal', valor: r2(s.valor), productos: s.productos.size }))
      .sort((a, b) => b.valor - a.valor),
    filas: lista.map((x) => ({
      ...x,
      proveedor: x.proveedorId != null ? (nombreProv.get(x.proveedorId) ?? '') : '',
      /** `{ sucursalId: plata }`: solo lo propio, como el total por sucursal. */
      locales: x.deCoffit ? {} : Object.fromEntries([...(porProdSuc.get(x.productoId) ?? [])].map(([id, v]) => [id, r2(v.valor)])),
    })),
  };
}
