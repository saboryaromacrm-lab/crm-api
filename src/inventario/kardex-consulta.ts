/**
 * LA FICHA DE MOVIMIENTOS Y LA REVISIÓN DE COHERENCIA, contra la base
 * (20/10/2026, pedido del dueño). La cuenta vive en `kardex.ts` (pura, con
 * pruebas); acá se leen el stock de hoy, los movimientos y el registro de
 * fraccionamiento, y se arma lo que muestra la pantalla.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../db/drizzle';
import { fechaLocal } from '../common/documentos';
import { claveSaldo, deltasDe, incoherencias, saldosHaciaAtras, type Delta, type ItemFraccion } from './kardex';

const ESTADOS = ['disponible', 'comprometido', 'en_transito', 'vencido', 'defectuoso', 'retenido'] as const;
/** Lo que se lista de un período: más que eso no se lee en una pantalla (el saldo se calcula igual con todo). */
const MAX_LISTA = 5000;
const r3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;
const filas = (r: any) => (r.rows ?? r) as any[];
const tamTexto = (kg: number) => (kg < 1 ? `${Math.round(kg * 1000)} g` : `${String(kg).replace('.', ',')} kg`);

/** Los deltas de cada movimiento, con el registro de fraccionamiento al lado. */
async function conDeltas(db: Database, movs: any[], tamPorPres: Map<number, number>) {
  const fracc = movs.filter((m) => m.tipo === 'fraccionamiento').map((m) => m.id);
  const items = new Map<number, ItemFraccion[]>();
  for (let i = 0; i < fracc.length; i += 5000) {
    const lote = fracc.slice(i, i + 5000);
    for (const it of filas(await db.execute(sql`
      SELECT movimiento_id, presentacion_id, paquetes, tam_kg FROM fraccionamiento_items WHERE movimiento_id IN ${lote}`))) {
      const l = items.get(Number(it.movimiento_id)) ?? [];
      l.push({ presentacionId: Number(it.presentacion_id), paquetes: Number(it.paquetes), tamKg: Number(it.tam_kg) });
      items.set(Number(it.movimiento_id), l);
    }
  }
  return movs.map((m) => {
    const r = deltasDe({
      id: m.id, tipo: m.tipo, sucursalId: m.sucursal_id, presentacionId: m.presentacion_id, signo: Number(m.signo),
      cantidad: Number(m.cantidad), estadoDesde: m.estado_desde, estadoHacia: m.estado_hacia,
    }, items.get(m.id) ?? [], (p) => tamPorPres.get(p) ?? null);
    return { ...m, deltas: r.deltas, estimado: r.estimado };
  });
}

/** El stock de hoy por clave (sucursal|paquete|estado). */
const mapaStock = (rows: any[]) => new Map(rows.map((s) => [
  claveSaldo({ sucursalId: Number(s.sucursal_id), presentacionId: Number(s.presentacion_id ?? 0), estado: s.estado }), r3(s.cantidad),
]));

/**
 * LA FICHA DE UN PRODUCTO: el stock de hoy, si cierra con sus movimientos, el
 * resumen del período (saldo al inicio, entradas y salidas por tipo, saldo al
 * final) y cada movimiento con lo que movió y el saldo que dejó.
 */
export async function kardexProducto(db: Database, productoId: number, o: { sucursalId?: number | null; desde?: string; hasta?: string; tipo?: string }) {
  const suc = o.sucursalId ?? null;
  const [prod] = filas(await db.execute(sql`SELECT id, nombre, tipo::text AS tipo FROM productos WHERE id = ${productoId}`));
  if (!prod) return null;
  const [pres, stockRows, movRows, sucs, usrs] = await Promise.all([
    db.execute(sql`SELECT id, tam_kg FROM presentaciones WHERE producto_id = ${productoId}`),
    db.execute(sql`SELECT sucursal_id, presentacion_id, estado::text AS estado, cantidad FROM stock
      WHERE producto_id = ${productoId}${suc ? sql` AND sucursal_id = ${suc}` : sql``}`),
    db.execute(sql`SELECT id, fecha, tipo::text AS tipo, sucursal_id, presentacion_id, signo, cantidad, unidad,
        estado_desde::text AS estado_desde, estado_hacia::text AS estado_hacia, sucursal_destino_id, motivo, descripcion,
        pres_label, costo_unitario, proveedor_nombre, usuario_id, ref_transferencia_id, ref_incidencia_id
      FROM movimientos WHERE producto_id = ${productoId}${suc ? sql` AND sucursal_id = ${suc}` : sql``} ORDER BY id`),
    db.execute(sql`SELECT id, nombre FROM sucursales`),
    db.execute(sql`SELECT id, nombre FROM usuarios`),
  ]);
  const tamPorPres = new Map(filas(pres).map((p) => [Number(p.id), Number(p.tam_kg)]));
  const nombrePres = (id: number) => (id ? `${prod.nombre} · ${tamPorPres.has(id) ? tamTexto(tamPorPres.get(id)!) : `paquete ${id}`}` : prod.nombre);
  const unidadDe = (id: number) => (id === 0 && prod.tipo === 'granel' ? 'kg' : 'u');
  const sucNombre = new Map(filas(sucs).map((s) => [Number(s.id), s.nombre]));
  const usrNombre = new Map(filas(usrs).map((u) => [Number(u.id), u.nombre]));

  const movs = await conDeltas(db, filas(movRows), tamPorPres);
  const hoy = mapaStock(filas(stockRows));
  const { despues, inicial } = saldosHaciaAtras(movs, hoy);

  /* Los artículos de la ficha: todo lo que tiene stock o se movió. */
  const articulos = new Map<string, { sucursalId: number; presentacionId: number }>();
  const marcar = (k: string) => { const [s, p] = k.split('|'); articulos.set(`${s}|${p}`, { sucursalId: Number(s), presentacionId: Number(p) }); };
  for (const k of hoy.keys()) marcar(k);
  for (const k of inicial.keys()) marcar(k);
  const saldoDe = (m: Map<string, number>, s: number, p: number) => Object.fromEntries(ESTADOS.map((e) => [e, r3(m.get(`${s}|${p}|${e}`) ?? 0)]));

  /* El período: por día argentino, como el resto del historial. */
  const desde = fechaLocal(o.desde);
  const hasta = o.hasta ? new Date(`${o.hasta}T23:59:59-03:00`) : null;
  const enRango = (m: any) => (!desde || new Date(m.fecha) >= desde) && (!hasta || new Date(m.fecha) <= hasta);
  /* El saldo al empezar el período: la carga inicial más todo lo anterior a «desde». */
  const alInicio = new Map(inicial);
  for (const m of movs) {
    if (!desde || new Date(m.fecha) >= desde) continue;
    for (const d of m.deltas) alInicio.set(claveSaldo(d), r3((alInicio.get(claveSaldo(d)) ?? 0) + d.delta));
  }
  const delPeriodo = movs.filter(enRango);
  const alFinal = new Map(alInicio);
  const resumen = new Map<string, { entradas: Record<string, number>; salidas: Record<string, number>; cambios: number }>();
  for (const m of delPeriodo) {
    for (const d of m.deltas) alFinal.set(claveSaldo(d), r3((alFinal.get(claveSaldo(d)) ?? 0) + d.delta));
    /* Entrada o salida del artículo: lo que cambió en total (sumando estados). Un cambio de estado da 0. */
    const porArt = new Map<string, number>();
    for (const d of m.deltas) porArt.set(`${d.sucursalId}|${d.presentacionId}`, (porArt.get(`${d.sucursalId}|${d.presentacionId}`) ?? 0) + d.delta);
    for (const [a, neto] of porArt) {
      const r = resumen.get(a) ?? { entradas: {}, salidas: {}, cambios: 0 };
      if (neto > 0.0005) r.entradas[m.tipo] = r3((r.entradas[m.tipo] ?? 0) + neto);
      else if (neto < -0.0005) r.salidas[m.tipo] = r3((r.salidas[m.tipo] ?? 0) - neto);
      else r.cambios += 1;
      resumen.set(a, r);
    }
  }

  const lista = (o.tipo ? delPeriodo.filter((m) => m.tipo === o.tipo) : delPeriodo).slice(-MAX_LISTA).reverse();
  const orden = (a: { sucursalId: number; presentacionId: number }, b: { sucursalId: number; presentacionId: number }) => a.sucursalId - b.sucursalId || a.presentacionId - b.presentacionId;
  return {
    producto: { id: prod.id, nombre: prod.nombre, tipo: prod.tipo },
    /** Todo el stock de hoy se explica con los movimientos más la carga inicial (lo que había antes del primero). */
    incoherencias: incoherencias(inicial).map((x) => ({ ...x, articulo: nombrePres(x.presentacionId), sucursal: sucNombre.get(x.sucursalId) ?? '—', unidad: unidadDe(x.presentacionId) })),
    totalMovimientos: movs.length,
    estimados: movs.filter((m) => m.estimado).length,
    articulos: [...articulos.values()].sort(orden).map((a) => ({
      ...a, articulo: nombrePres(a.presentacionId), sucursal: sucNombre.get(a.sucursalId) ?? '—', unidad: unidadDe(a.presentacionId),
      hoy: saldoDe(hoy, a.sucursalId, a.presentacionId),
      cargaInicial: saldoDe(inicial, a.sucursalId, a.presentacionId),
      alInicio: saldoDe(alInicio, a.sucursalId, a.presentacionId),
      alFinal: saldoDe(alFinal, a.sucursalId, a.presentacionId),
      ...(resumen.get(`${a.sucursalId}|${a.presentacionId}`) ?? { entradas: {}, salidas: {}, cambios: 0 }),
    })),
    periodo: { desde: o.desde ?? null, hasta: o.hasta ?? null, movimientos: delPeriodo.length, recortado: lista.length >= MAX_LISTA },
    movimientos: lista.map((m) => ({
      id: m.id, fecha: m.fecha, tipo: m.tipo, signo: Number(m.signo), cantidad: Number(m.cantidad), unidad: m.unidad,
      sucursal: sucNombre.get(Number(m.sucursal_id)) ?? '—', destino: m.sucursal_destino_id ? sucNombre.get(Number(m.sucursal_destino_id)) ?? '—' : null,
      detalle: m.descripcion || m.motivo || '', presLabel: m.pres_label, proveedor: m.proveedor_nombre,
      usuario: m.usuario_id ? usrNombre.get(Number(m.usuario_id)) ?? '—' : '—',
      valor: Number(m.costo_unitario) > 0 ? r3(Number(m.cantidad) * Number(m.costo_unitario)) : null,
      refTransferenciaId: m.ref_transferencia_id, refIncidenciaId: m.ref_incidencia_id, estimado: m.estimado,
      movio: m.deltas.map((d: Delta) => {
        const desp = despues.get(m.id)?.get(claveSaldo(d)) ?? 0;
        return {
          articulo: nombrePres(d.presentacionId), sucursal: sucNombre.get(d.sucursalId) ?? '—', unidad: unidadDe(d.presentacionId),
          estado: d.estado, delta: r3(d.delta), saldo: r3(desp),
        };
      }),
    })),
  };
}

/**
 * LA REVISIÓN DE TODO EL STOCK: producto por producto, ¿el stock de hoy se
 * explica con sus movimientos? Devuelve lo que no cierra (ver `incoherencias`)
 * con nombre, sucursal y cantidad. Lee todos los movimientos: es a pedido.
 */
export async function coherenciaStock(db: Database, sucursalId: number | null) {
  const filtroSuc = sucursalId ? sql` AND sucursal_id = ${sucursalId}` : sql``;
  const [prods, pres, stockRows, movRows, sucs] = await Promise.all([
    db.execute(sql`SELECT id, nombre, tipo::text AS tipo FROM productos`),
    db.execute(sql`SELECT id, producto_id, tam_kg FROM presentaciones`),
    db.execute(sql`SELECT producto_id, sucursal_id, presentacion_id, estado::text AS estado, cantidad FROM stock WHERE true${filtroSuc}`),
    db.execute(sql`SELECT id, producto_id, tipo::text AS tipo, sucursal_id, presentacion_id, signo, cantidad,
        estado_desde::text AS estado_desde, estado_hacia::text AS estado_hacia
      FROM movimientos WHERE producto_id IS NOT NULL${filtroSuc} ORDER BY id`),
    db.execute(sql`SELECT id, nombre FROM sucursales`),
  ]);
  const tam = new Map(filas(pres).map((p) => [Number(p.id), Number(p.tam_kg)]));
  const prodDe = new Map(filas(prods).map((p) => [Number(p.id), p]));
  const sucNombre = new Map(filas(sucs).map((s) => [Number(s.id), s.nombre]));
  const movs = await conDeltas(db, filas(movRows), tam);

  /* Por producto: stock de hoy menos todo lo que movieron sus movimientos = la carga inicial. */
  const porProd = new Map<number, Map<string, number>>();
  const base = (pid: number) => { if (!porProd.has(pid)) porProd.set(pid, new Map()); return porProd.get(pid)!; };
  for (const s of filas(stockRows)) {
    base(Number(s.producto_id)).set(claveSaldo({ sucursalId: Number(s.sucursal_id), presentacionId: Number(s.presentacion_id ?? 0), estado: s.estado }), Number(s.cantidad));
  }
  for (const m of movs) {
    const mapa = base(Number(m.producto_id));
    for (const d of m.deltas) mapa.set(claveSaldo(d), (mapa.get(claveSaldo(d)) ?? 0) - d.delta);
  }
  const problemas: any[] = [];
  for (const [pid, inicial] of porProd) {
    const p = prodDe.get(pid);
    for (const x of incoherencias(inicial)) {
      problemas.push({
        productoId: pid, producto: p?.nombre ?? `Producto ${pid}`,
        articulo: x.presentacionId ? `${p?.nombre ?? ''} · ${tam.has(x.presentacionId) ? tamTexto(tam.get(x.presentacionId)!) : `paquete ${x.presentacionId}`}` : p?.nombre ?? '',
        sucursalId: x.sucursalId, sucursal: sucNombre.get(x.sucursalId) ?? '—', estado: x.estado,
        cantidad: x.cantidad, unidad: x.presentacionId === 0 && p?.tipo === 'granel' ? 'kg' : 'u', motivo: x.motivo,
      });
    }
  }
  problemas.sort((a, b) => a.producto.localeCompare(b.producto) || a.sucursalId - b.sucursalId);
  return {
    revisados: porProd.size,
    movimientos: movs.length,
    estimados: movs.filter((m) => m.estimado).length,
    problemas,
  };
}
