/**
 * ALMACÉN › PRODUCTOS SIN MOVIMIENTO (7/10/2026, pedido del dueño)
 * ============================================================================
 * Qué mercadería está quieta: productos con stock DISPONIBLE en un local que no
 * se venden ahí hace más de N días (7, 14, 21 o 30), con la plata que hay
 * parada (a costo de hoy).
 *
 * QUÉ ES «MOVERSE»:
 *   · vender (mostrador y tienda: los dos descuentan con `venta_granel` /
 *     `venta_fraccionada`) o mandarlo a Coffit (`envio_cafeteria`): sale del
 *     local para no volver;
 *   · y SOLO SI SE PIDE (`pases`), un pase entre locales que entró o salió
 *     del local (`transferencia` con signo; las de signo 0 son reservas y
 *     despachos dentro del mismo local, no un movimiento de verdad).
 *
 * LO QUE RECIÉN LLEGÓ NO ES «QUIETO»: si un producto nunca se vendió en el
 * local, el reloj corre desde su primer ingreso ahí (compra, fraccionado,
 * ajuste… y el pase si se cuentan los pases). Un producto que entró hace 3
 * días no aparece en «más de 7». Sin ningún registro en el local (stock
 * cargado de entrada), aparece como «sin registro».
 *
 * RÁPIDO A PROPÓSITO (el dueño: «que no ralentice nada»):
 *   · UNA consulta de solo lectura; nada se calcula dentro de una venta.
 *   · Parte de la tabla `stock` (una foto chica: una fila por producto,
 *     local, paquete y estado), no de las ventas.
 *   · El corte «vendió en los últimos N días» es un NOT EXISTS que el índice
 *     `ix_mov_prod_fecha` (producto, fecha desc) resuelve leyendo solo lo
 *     reciente de cada producto. Las búsquedas caras (última venta de toda la
 *     historia, primer ingreso, en qué otro local se vende) corren SOLO sobre
 *     los que quedaron, que son los quietos.
 */
import { inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/drizzle';
import { presentaciones, productoProveedores, productos } from '../db/schema';
import { costosFormato, escalaPaquete, formatoDeCosto } from './pricing';

export const DIAS_SIN_MOVIMIENTO = [7, 14, 21, 30] as const;

const VENTAS = sql`('venta_granel', 'venta_fraccionada', 'envio_cafeteria')`;
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const r3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;
const DIA_MS = 86_400_000;

export interface FiltroSinMovimiento {
  sucursalId: number | null;
  dias: number;
  /** ¿Un pase entre locales cuenta como movimiento? */
  pases: boolean;
  /** Sin la llave de costos: la plata parada no viaja. */
  verCosto: boolean;
}

export async function productosSinMovimiento(db: Database, f: FiltroSinMovimiento) {
  const dias = (DIAS_SIN_MOVIMIENTO as readonly number[]).includes(f.dias) ? f.dias : 7;
  const ahora = Date.now();
  const corte = new Date(ahora - dias * DIA_MS);
  const suc = f.sucursalId ? sql`AND s.sucursal_id = ${f.sucursalId}` : sql``;
  /* Movimientos que «despiertan» al producto en el local: ventas y, si se pide, pases con signo. */
  const mueve = f.pases
    ? sql`(m.tipo IN ${VENTAS} OR (m.tipo = 'transferencia' AND m.signo <> 0))`
    : sql`m.tipo IN ${VENTAS}`;
  /* El primer ingreso al local: cualquier movimiento, salvo los pases cuando no cuentan. */
  const ingreso = f.pases ? sql`true` : sql`m.tipo <> 'transferencia'`;

  const r: any = await db.execute(sql`
    WITH st AS (
      SELECT s.producto_id, s.sucursal_id,
             json_agg(json_build_array(s.presentacion_id, s.cantidad)) AS filas
        FROM stock s
       WHERE s.estado = 'disponible' AND s.cantidad > 1e-9 ${suc}
       GROUP BY s.producto_id, s.sucursal_id
    ),
    -- Los que NO se movieron en el período: el índice lee solo lo reciente de cada producto.
    quietos AS (
      SELECT st.* FROM st
       WHERE NOT EXISTS (
         SELECT 1 FROM movimientos m
          WHERE m.producto_id = st.producto_id AND m.fecha >= ${corte}
            AND m.sucursal_id = st.sucursal_id AND ${mueve})
    )
    SELECT q.producto_id, q.sucursal_id, q.filas,
           uv.fecha AS ultima_venta, up.fecha AS ultimo_pase, pi.fecha AS primer_ingreso,
           ov.sucursal_id AS se_vende_en
      FROM quietos q
      JOIN productos p ON p.id = q.producto_id AND p.estado <> 'archivado'
      -- La última venta de toda la historia en el local (para decir «hace 45 días»).
      LEFT JOIN LATERAL (
        SELECT m.fecha FROM movimientos m
         WHERE m.producto_id = q.producto_id AND m.sucursal_id = q.sucursal_id AND m.tipo IN ${VENTAS}
         ORDER BY m.fecha DESC LIMIT 1) uv ON true
      -- El último pase que entró o salió del local (se muestra siempre; cuenta solo si se pide).
      LEFT JOIN LATERAL (
        SELECT m.fecha FROM movimientos m
         WHERE m.producto_id = q.producto_id AND m.sucursal_id = q.sucursal_id
           AND m.tipo = 'transferencia' AND m.signo <> 0
         ORDER BY m.fecha DESC LIMIT 1) up ON true
      -- Nunca se vendió ahí: desde cuándo está. Sin venta, el filtro corta antes de leer nada.
      LEFT JOIN LATERAL (
        SELECT m.fecha FROM movimientos m
         WHERE uv.fecha IS NULL AND m.producto_id = q.producto_id AND m.sucursal_id = q.sucursal_id AND ${ingreso}
         ORDER BY m.fecha ASC LIMIT 1) pi ON true
      -- ¿Se vende en OTRO local? Es la pista para mandarlo para allá.
      LEFT JOIN LATERAL (
        SELECT m.sucursal_id FROM movimientos m
         WHERE m.producto_id = q.producto_id AND m.fecha >= ${corte}
           AND m.sucursal_id <> q.sucursal_id AND m.tipo IN ('venta_granel', 'venta_fraccionada')
         ORDER BY m.fecha DESC LIMIT 1) ov ON true
  `);
  const crudas: any[] = r.rows ?? r;

  /* Desde cuándo está quieto: la última venta (o el último pase, si cuenta);
   * sin ninguna, su primer ingreso al local. Lo que entró después del corte no va. */
  const filasQuietas = crudas.map((x) => {
    const t = (v: unknown) => (v ? new Date(v as string).getTime() : null);
    const venta = t(x.ultima_venta); const pase = t(x.ultimo_pase); const primero = t(x.primer_ingreso);
    const mov = Math.max(venta ?? 0, f.pases ? pase ?? 0 : 0) || null;
    const desde = mov ?? primero;
    return { x, venta, pase, desde };
  }).filter(({ desde }) => desde == null || desde < corte.getTime());

  const ids = [...new Set(filasQuietas.map(({ x }) => Number(x.producto_id)))];
  const [prods, provs, sucs, press, marcasR, catsR] = ids.length ? await Promise.all([
    db.select().from(productos).where(inArray(productos.id, ids)),
    f.verCosto ? db.select().from(productoProveedores).where(inArray(productoProveedores.productoId, ids)) : Promise.resolve([] as any[]),
    db.execute(sql`SELECT id, nombre FROM sucursales`),
    db.select({ id: presentaciones.id, tamKg: presentaciones.tamKg }).from(presentaciones).where(inArray(presentaciones.productoId, ids)),
    db.execute(sql`SELECT id, nombre FROM marcas`),
    db.execute(sql`SELECT id, nombre FROM categorias`),
  ]) : [[], [], { rows: [] }, [], { rows: [] }, { rows: [] }] as any[];

  const filasDe = (q: any) => (q.rows ?? q) as any[];
  const prodDe = new Map<number, any>(prods.map((p: any) => [p.id, p]));
  const provsDe = new Map<number, any[]>();
  for (const pv of provs as any[]) { const a = provsDe.get(pv.productoId); if (a) a.push(pv); else provsDe.set(pv.productoId, [pv]); }
  const tamDe = new Map<number, number>(press.map((p: any) => [p.id, Number(p.tamKg)]));
  const nombreSuc = new Map<number, string>(filasDe(sucs).map((s: any) => [Number(s.id), s.nombre]));
  const nombreMarca = new Map<number, string>(filasDe(marcasR).map((m: any) => [Number(m.id), m.nombre]));
  const nombreCat = new Map<number, string>(filasDe(catsR).map((c: any) => [Number(c.id), c.nombre]));
  const costoDe = new Map<number, number>();
  const costo = (p: any) => {
    if (!costoDe.has(p.id)) costoDe.set(p.id, costosFormato(formatoDeCosto(p, provsDe.get(p.id) ?? []) as any, p.iva).costoNetoUnitario);
    return costoDe.get(p.id)!;
  };

  const filas = filasQuietas.map(({ x, venta, pase, desde }) => {
    const p = prodDe.get(Number(x.producto_id));
    if (!p) return null;
    const granel = p.tipo === 'granel';
    let suelto = 0; let paquetes = 0; let base = 0; let valor = 0;
    for (const [presId, cant] of x.filas as [number | null, number][]) {
      const c = Number(cant) || 0;
      if (presId) {
        const tam = tamDe.get(presId) ?? 0;
        paquetes += c; base += c * tam;
        if (f.verCosto) valor += c * costo(p) * escalaPaquete(tam, Number(p.merma) || 0);
      } else {
        suelto += c; base += c;
        if (f.verCosto) valor += c * costo(p);
      }
    }
    const sucursalId = Number(x.sucursal_id);
    return {
      productoId: p.id as number, nombre: p.nombre as string, codigo: (p.codigoPropio || p.codigoBarras || '') as string,
      /* Marca, categoría y local van por id: los nombres viajan UNA vez abajo (con miles de renglones, pesa). */
      marcaId: (p.marcaId ?? 0) as number, categoriaId: (p.categoriaId ?? 0) as number,
      granel, deCoffit: !!p.soloCafeteria, sucursalId,
      /** Stock en unidad base (kg el granel, unidades lo entero) y, en granel, cómo está. */
      stock: r3(base), suelto: r3(suelto), paquetes: r3(paquetes),
      valor: f.verCosto ? r2(valor) : null,
      ultimaVenta: venta ? new Date(venta).toISOString() : null,
      ultimoPase: pase ? new Date(pase).toISOString() : null,
      /** Desde cuándo está quieto (null = sin ningún registro en el local). */
      desde: desde ? new Date(desde).toISOString() : null,
      /** Por qué cuenta desde ahí: la venta, el pase o su llegada. */
      motivo: desde == null ? 'sin_registro' : desde === venta ? 'venta' : f.pases && desde === pase ? 'pase' : 'ingreso',
      dias: desde ? Math.floor((ahora - desde) / DIA_MS) : null,
      seVendeEn: x.se_vende_en ? Number(x.se_vende_en) : null,
    };
  }).filter(Boolean) as any[];

  // Lo más quieto primero; «sin registro» (no se sabe cuánto hace) al final.
  filas.sort((a, b) => (b.dias ?? -1) - (a.dias ?? -1) || (b.valor ?? 0) - (a.valor ?? 0) || a.nombre.localeCompare(b.nombre, 'es'));

  const porSucursal = new Map<number, { sucursalId: number; sucursal: string; productos: number; valor: number }>();
  for (const x of filas) {
    const a = porSucursal.get(x.sucursalId) ?? { sucursalId: x.sucursalId, sucursal: nombreSuc.get(x.sucursalId) ?? '—', productos: 0, valor: 0 };
    a.productos += 1; a.valor += x.valor ?? 0;
    porSucursal.set(x.sucursalId, a);
  }
  /* Cuánto hace, en tramos que arrancan en el corte elegido: con 21 días, «22 a 30», «31 a 60», «más de 60». */
  const valorDe = (de: any[]) => (f.verCosto ? r2(de.reduce((s, x) => s + (x.valor ?? 0), 0)) : null);
  const tramos: { clave: string; etiqueta: string; desde: number | null; hasta: number | null; productos: number; valor: number | null }[] = [];
  let inicio = dias + 1;
  for (const tope of [14, 30, 60, Infinity]) {
    if (tope < inicio) continue;
    const de = filas.filter((x) => x.dias != null && x.dias >= inicio && x.dias <= tope);
    tramos.push({ clave: `d${inicio}`, etiqueta: tope === Infinity ? `Más de ${inicio - 1} días` : `${inicio} a ${tope} días`, desde: inicio, hasta: tope === Infinity ? null : tope, productos: de.length, valor: valorDe(de) });
    inicio = tope + 1;
  }
  const sinRegistro = filas.filter((x) => x.dias == null);
  tramos.push({ clave: 'sin_registro', etiqueta: 'Sin ningún registro', desde: null, hasta: null, productos: sinRegistro.length, valor: valorDe(sinRegistro) });

  /** Los nombres, una sola vez: solo los que aparecen. */
  const nombres = (ids: Iterable<number>, de: Map<number, string>, vacio: string) => Object.fromEntries([...new Set(ids)].map((id) => [id, de.get(id) ?? vacio]));
  return {
    dias, pases: f.pases, sucursalId: f.sucursalId, verCosto: f.verCosto, corte: corte.toISOString(),
    nombres: {
      sucursales: nombres(filas.flatMap((x) => (x.seVendeEn ? [x.sucursalId, x.seVendeEn] : [x.sucursalId])), nombreSuc, '—'),
      marcas: nombres(filas.map((x) => x.marcaId), nombreMarca, ''),
      categorias: nombres(filas.map((x) => x.categoriaId), nombreCat, ''),
    },
    resumen: {
      renglones: filas.length,
      productos: new Set(filas.map((x) => x.productoId)).size,
      valor: f.verCosto ? r2(filas.reduce((s, x) => s + (x.valor ?? 0), 0)) : null,
      seVendenEnOtroLocal: filas.filter((x) => x.seVendeEn).length,
    },
    porSucursal: [...porSucursal.values()].map((a) => ({ ...a, valor: f.verCosto ? r2(a.valor) : null })).sort((a, b) => b.productos - a.productos),
    tramos,
    filas,
  };
}
