/**
 * LOS FLETES DE MERCADERÍA (0244, 24/11/2026)
 * ============================================================================
 * Un transporte (Expreso Demonte) trae mercadería de otros proveedores y factura
 * el viaje. La regla vive en la ficha del transporte (`proveedores.traeMercaderia`)
 * y cada renglón de su factura dice de dónde vino:
 *   · 'proveedor': de quién trajo y, cuando se sabe, de qué factura o remito suyo;
 *   · 'otro': algo que no es de un proveedor (un envío entre locales, una devolución).
 *
 * El papel del proveedor muchas veces llega DESPUÉS que el del transporte: por eso
 * el renglón guarda el número escrito (`fleteReferencia`) y se vincula al cargar
 * esa factura o remito en Compras. Si llegó antes, se elige de los ya cargados.
 *
 * Lo puro (sin base) va arriba y tiene tests; las consultas compartidas entre
 * Gastos y Compras, abajo.
 */
import { sql } from 'drizzle-orm';

export type FleteOrigen = 'proveedor' | 'otro';
export const ORIGENES_FLETE: FleteOrigen[] = ['proveedor', 'otro'];

/** Los papeles del proveedor que traen mercadería (y por eso pueden tener un flete). */
export const TIPOS_CON_FLETE = ['factura', 'remito', 'liquidacion'] as const;

/**
 * ¿El número escrito es el de este comprobante? Acepta "0003-00001234", "3-1234",
 * "FC A 0003-1234" o solo "1234" (sin punto de venta compara el número).
 */
export function coincideNumero(ref: string | null | undefined, c: { puntoVenta: string; numero: number | null }): boolean {
  if (!c.numero) return false;
  const t = String(ref ?? '').trim();
  const conPv = /^\D*0*(\d+)\s*[-/]\s*0*(\d+)\D*$/.exec(t);
  if (conPv) return Number(conPv[1]) === Number(c.puntoVenta) && Number(conPv[2]) === c.numero;
  const digitos = t.replace(/\D/g, '');
  return digitos !== '' && Number(digitos) === c.numero;
}

/* ------------------------- la sugerencia por nombre ------------------------- */

/** Palabras que no identifican a nadie: formas societarias, artículos, unidades del flete. */
const SIN_PESO = new Set([
  's', 'a', 'r', 'l', 'sa', 'srl', 'sas', 'sociedad', 'anonima', 'resp', 'cia', 'y', 'de', 'del', 'la', 'el', 'los', 'las',
  'sin', 'con', 'bulto', 'bultos', 'pallet', 'pallets', 'caja', 'cajas', 'kg', 'kgs', 'unidades', 'u',
]);
const palabras = (t: string) => String(t ?? '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .split(/[^a-z0-9]+/).filter((p) => p && !/^\d+$/.test(p) && !SIN_PESO.has(p));
/** La misma palabra, o una el comienzo de la otra si las dos son largas ("tutuca" ↔ "tutucas"). */
const parecidas = (a: string, b: string) => a === b || (a.length >= 5 && b.length >= 5 && (a.startsWith(b) || b.startsWith(a)));

/**
 * DE QUIÉN PARECE QUE TRAJO, por lo escrito en el renglón ("DONINAS - 5 BULTOS" →
 * DONINAS S.A.S.). Gana el que comparte más palabras con el renglón —una igual vale
 * más que una que solo empieza igual: "VILLARES" es ALIMENTOS VILLARES, no LA VILLA—
 * y, a igualdad, el que tiene menos palabras de más ("REAL FOOD" antes que "REAL NATURA FOOD").
 * Solo sugiere si hay UN ganador claro: un empate no es una sugerencia.
 */
export function sugerirProveedor<P extends { id: number; nombre: string }>(concepto: string, proveedores: P[]): P | null {
  const delRenglon = palabras(concepto);
  if (!delRenglon.length) return null;
  const puntajes = proveedores.map((p) => {
    const suyas = palabras(p.nombre);
    const iguales = suyas.filter((s) => delRenglon.includes(s)).length;
    const parecidasN = suyas.filter((s) => !delRenglon.includes(s) && delRenglon.some((r) => parecidas(r, s))).length;
    const usadas = iguales + parecidasN;
    return { p, puntos: usadas ? iguales * 10 + parecidasN * 6 - (suyas.length - usadas) : 0 };
  }).filter((x) => x.puntos > 0).sort((a, b) => b.puntos - a.puntos);
  if (!puntajes.length || (puntajes[1] && puntajes[1].puntos === puntajes[0].puntos)) return null;
  return puntajes[0].p;
}

/**
 * DE QUÉ PAPEL PARECE QUE FUE el flete de una carga vieja: la factura o el remito del
 * proveedor con la fecha más cercana a la del transporte, desde 15 días antes hasta
 * 3 después (el transporte factura cuando entrega, el proveedor factura al despachar).
 * Dos del mismo día son la misma entrega (factura A + liquidación): va la factura.
 */
export function papelMasCercano<P extends { fecha: Date | string; tipo?: string }>(fecha: Date | string, papeles: P[]): P | null {
  const DIA = 86_400_000;
  const ORDEN = ['factura', 'remito', 'liquidacion'];
  const t = new Date(fecha).getTime();
  const cerca = papeles
    .map((p) => ({ p, d: new Date(p.fecha).getTime() - t }))
    .filter((x) => x.d >= -15 * DIA && x.d <= 3 * DIA)
    .sort((a, b) => Math.abs(a.d) - Math.abs(b.d) || ORDEN.indexOf(a.p.tipo ?? '') - ORDEN.indexOf(b.p.tipo ?? ''));
  /* Dos igual de cerca pero de días distintos (uno antes, otro después): no se sabe cuál. Del mismo día son la misma entrega. */
  if (!cerca.length || (cerca[1] && Math.abs(cerca[1].d) === Math.abs(cerca[0].d) && cerca[1].d !== cerca[0].d)) return null;
  return cerca[0].p;
}

/* ------------------------- consultas compartidas ------------------------- */

type Ejecutor = { execute: (q: any) => Promise<any> };
const filas = (r: any) => (r?.rows ?? r) as any[];

/**
 * LO QUE UN RENGLÓN DE FLETE CUESTA SIN IVA: su parte del neto del gasto. Sirve
 * para los dos modos de carga (renglones netos de factura A o finales con el IVA
 * adentro): neto del gasto × monto del renglón / suma de los renglones.
 */
export const NETO_DEL_RENGLON = sql.raw(`(i.monto * g.neto / nullif((select sum(x.monto) from gasto_items x where x.gasto_id = g.id), 0))`);

/**
 * LA ENTREGA de un papel `c`: todos los papeles de ese proveedor de ese mismo día. El
 * proveedor mitad y mitad manda la factura A y la liquidación juntas, y el flete trae
 * las dos: el % del flete se mide contra la entrega, no contra una mitad (mismo
 * criterio que «esta compra vino distinta»: los papeles de ese día).
 */
export const NETO_DE_LA_ENTREGA = sql.raw(`(select sum(e.subtotal_neto) from comprobantes e
  where e.proveedor_id = c.proveedor_id and e.estado = 'confirmado' and e.tipo in ('factura', 'remito', 'liquidacion')
    and e.fecha::date = c.fecha::date)`);
export const PAPELES_DE_LA_ENTREGA = sql.raw(`(select count(*)::int from comprobantes e
  where e.proveedor_id = c.proveedor_id and e.estado = 'confirmado' and e.tipo in ('factura', 'remito', 'liquidacion')
    and e.fecha::date = c.fecha::date)`);

/** Los fletes de este proveedor que todavía no tienen su factura o remito vinculado. */
export async function fletesSinPapel(db: Ejecutor, proveedorId: number) {
  const r = await db.execute(sql`
    select i.id, i.concepto, i.cantidad, i.flete_referencia as referencia, ${NETO_DEL_RENGLON} as neto,
           g.id as gasto_id, g.fecha, g.letra, g.numero, coalesce(t.nombre, g.proveedor_texto) as transporte
      from gasto_items i
      join gastos g on g.id = i.gasto_id
      left join proveedores t on t.id = g.proveedor_id
     where i.flete_origen = 'proveedor' and i.flete_proveedor_id = ${proveedorId}
       and i.flete_comprobante_id is null and g.estado <> 'anulado'
     order by g.fecha desc, i.id desc
     limit 50`);
  return filas(r).map((x) => ({
    id: Number(x.id), concepto: String(x.concepto), cantidad: x.cantidad == null ? null : Number(x.cantidad),
    referencia: String(x.referencia ?? ''), neto: Math.round(Number(x.neto) * 100) / 100,
    gastoId: Number(x.gasto_id), fecha: x.fecha, letra: x.letra, numero: String(x.numero ?? ''), transporte: String(x.transporte ?? ''),
  }));
}

/**
 * VINCULAR al cargar la factura o el remito en Compras: solo renglones de flete de
 * ESTE proveedor que sigan sin papel (lo demás se ignora: pudo vincularlo otro).
 */
export async function vincularFletes(tx: Ejecutor, comprobanteId: number, proveedorId: number, itemIds: number[]) {
  if (!itemIds.length) return 0;
  const r = await tx.execute(sql`
    update gasto_items set flete_comprobante_id = ${comprobanteId}
     where id in (${sql.join(itemIds.map((id) => sql`${id}`), sql`, `)})
       and flete_origen = 'proveedor' and flete_proveedor_id = ${proveedorId} and flete_comprobante_id is null
    returning id`);
  return filas(r).length;
}

/** Al ANULAR la factura o el remito, sus fletes vuelven a esperar papel (se vinculan al recargarla). */
export async function desvincularFletes(tx: Ejecutor, comprobanteId: number) {
  await tx.execute(sql`update gasto_items set flete_comprobante_id = null where flete_comprobante_id = ${comprobanteId}`);
}

/**
 * Los fletes de la ENTREGA de un comprobante (sus fletes y los de los otros papeles del
 * proveedor de ese día), para su detalle: con el neto de la entrega se mide el %.
 */
export async function fletesDelComprobante(db: Ejecutor, comprobanteId: number) {
  const [entrega] = filas(await db.execute(sql`
    select ${NETO_DE_LA_ENTREGA} as neto, ${PAPELES_DE_LA_ENTREGA} as papeles from comprobantes c where c.id = ${comprobanteId}`));
  const r = await db.execute(sql`
    select i.id, i.concepto, ${NETO_DEL_RENGLON} as neto, g.id as gasto_id, g.fecha, g.letra, g.numero,
           coalesce(t.nombre, g.proveedor_texto) as transporte
      from gasto_items i join gastos g on g.id = i.gasto_id left join proveedores t on t.id = g.proveedor_id
      join comprobantes p on p.id = i.flete_comprobante_id
      join comprobantes c on c.id = ${comprobanteId}
     where p.proveedor_id = c.proveedor_id and p.fecha::date = c.fecha::date and p.estado = 'confirmado' and g.estado <> 'anulado'
     order by g.fecha, i.id`);
  return {
    netoEntrega: Math.round(Number(entrega?.neto ?? 0) * 100) / 100,
    papelesEntrega: Number(entrega?.papeles ?? 0),
    fletes: filas(r).map((x) => ({
      id: Number(x.id), concepto: String(x.concepto), neto: Math.round(Number(x.neto) * 100) / 100,
      gastoId: Number(x.gasto_id), fecha: x.fecha, letra: x.letra, numero: String(x.numero ?? ''), transporte: String(x.transporte ?? ''),
    })),
  };
}
