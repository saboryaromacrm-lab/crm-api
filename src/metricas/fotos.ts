/**
 * GERENCIA › STOCK VALORIZADO · LA FOTO DE CADA NOCHE (0231, 17/11/2026)
 * ============================================================================
 * «¿Cuánta plata había en mercadería al 31/10?»: el stock de un día pasado a
 * costo de ese día NO se puede reconstruir (los costos cambian y los ajustes
 * se corrigen después). Por eso, cada madrugada el reloj de Métricas guarda el
 * stock valorizado del día que cerró —con la MISMA cuenta de la pantalla— y lo
 * deja como quedó. Nunca se rellena un día salteado: un día sin foto se ve así.
 *
 *  · Los totales (plata propia, por local, parado, Coffit) quedan para siempre:
 *    son unos bytes por día.
 *  · El detalle artículo por artículo y local por local (lo que pide el contador
 *    para el inventario de cierre) queda de la última foto de cada mes y de los
 *    últimos 62 días; el resto se borra.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { Database } from '../db/drizzle';
import { sumarDias } from '../cafeteria/cuenta';
import { valorizarStock } from './stock';

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const r3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;
const DIAS_CON_DETALLE = 62;

/** Saca y guarda la foto de `dia` (si ya estaba, la deja: es la de esa noche). Devuelve si la guardó. */
export async function tomarFoto(db: Database, pool: Pool, dia: string): Promise<boolean> {
  const { lista, porProdSuc } = await valorizarStock(db, pool, { sucursalId: null, ventana: 60 });
  let valor = 0; let coffit = 0; let parado = 0; let articulos = 0;
  const porSucursal: Record<number, number> = {};
  /** `[productoId, sucursalId, cantidad base, plata]`: solo lo propio, como el total. */
  const detalle: [number, number, number, number][] = [];
  for (const x of lista) {
    if (x.deCoffit) { coffit += x.valor; continue; }
    valor += x.valor; articulos += 1;
    if (x.estado === 'parado') parado += x.valor;
    for (const [suc, v] of porProdSuc.get(x.productoId) ?? []) {
      porSucursal[suc] = (porSucursal[suc] ?? 0) + v.valor;
      detalle.push([x.productoId, suc, r3(v.cant), r2(v.valor)]);
    }
  }
  const r = await pool.query(
    `INSERT INTO stock_fotos (dia, valor, valor_coffit, valor_parado, articulos, por_sucursal, detalle)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (dia) DO NOTHING`,
    [dia, r2(valor), r2(coffit), r2(parado), articulos,
      JSON.stringify(Object.fromEntries(Object.entries(porSucursal).map(([k, v]) => [k, r2(v)]))), JSON.stringify(detalle)]);
  // El detalle viejo se borra, salvo el de la última foto de cada mes.
  await pool.query(
    `UPDATE stock_fotos f SET detalle = NULL
      WHERE f.detalle IS NOT NULL AND f.dia < $1::date
        AND f.dia < (SELECT max(g.dia) FROM stock_fotos g WHERE date_trunc('month', g.dia) = date_trunc('month', f.dia))`,
    [sumarDias(dia, -DIAS_CON_DETALLE)]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Las fotos de fin de mes de los últimos 13 meses (la última de cada mes; la
 * del mes en curso es la de anoche). Con `sucursalId`, la plata de ese local
 * (lo parado y los artículos se guardan solo del total).
 */
export async function fotosDeFinDeMes(c: PoolClient, sucursalId: number | null) {
  const { rows } = await c.query(
    `SELECT DISTINCT ON (date_trunc('month', dia)) dia::text AS dia, hecha_en, detalle IS NOT NULL AS con_detalle,
            CASE WHEN $1::int IS NULL THEN articulos END AS articulos,
            CASE WHEN $1::int IS NULL THEN valor ELSE coalesce((por_sucursal ->> $1::text)::numeric, 0) END::float8 AS valor,
            CASE WHEN $1::int IS NULL THEN valor_parado END::float8 AS valor_parado
       FROM stock_fotos WHERE dia >= (current_date - 400)
      ORDER BY date_trunc('month', dia) DESC, dia DESC`,
    [sucursalId]);
  const ultima = await c.query('SELECT dia::text AS dia, hecha_en FROM stock_fotos ORDER BY dia DESC LIMIT 1');
  return {
    ultima: ultima.rows[0] ?? null,
    meses: rows.slice(0, 13).map((x) => ({
      mes: x.dia.slice(0, 7), dia: x.dia, hechaEn: x.hecha_en, valor: r2(x.valor), valorParado: x.valor_parado == null ? null : r2(x.valor_parado),
      articulos: x.articulos, conDetalle: x.con_detalle,
    })),
  };
}

/** El detalle de una foto con los nombres de HOY (el inventario de cierre para el contador). */
export async function detalleDeFoto(c: PoolClient, dia: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) throw new BadRequestException('Fecha inválida.');
  const { rows } = await c.query('SELECT dia::text AS dia, hecha_en, detalle FROM stock_fotos WHERE dia = $1', [dia]);
  const foto = rows[0];
  if (!foto) throw new NotFoundException('No hay foto de ese día.');
  if (!foto.detalle) throw new NotFoundException('De esa foto quedan solo los totales: el detalle se guarda del último día de cada mes y de los últimos dos meses.');
  const det: [number, number, number, number][] = foto.detalle;
  const { rows: nombres } = await c.query(
    `SELECT p.id, p.nombre, p.tipo, m.nombre AS marca, cat.nombre AS categoria
       FROM productos p LEFT JOIN marcas m ON m.id = p.marca_id LEFT JOIN categorias cat ON cat.id = p.categoria_id
      WHERE p.id = ANY($1::int[])`,
    [[...new Set(det.map((x) => x[0]))]]);
  const { rows: sucs } = await c.query('SELECT id, nombre FROM sucursales');
  const prod = new Map(nombres.map((p) => [p.id, p]));
  const suc = new Map(sucs.map((s) => [s.id, s.nombre]));
  return {
    dia: foto.dia, hechaEn: foto.hecha_en,
    filas: det.map(([productoId, sucursalId, cantidad, valor]) => {
      const p = prod.get(productoId);
      return {
        productoId, nombre: p?.nombre ?? `#${productoId}`, marca: p?.marca ?? '', categoria: p?.categoria ?? '',
        unidad: p?.tipo === 'granel' ? 'kg' : 'u.', sucursalId, sucursal: suc.get(sucursalId) ?? '', cantidad, valor,
      };
    }).sort((a, b) => b.valor - a.valor),
  };
}
