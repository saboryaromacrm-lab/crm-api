/**
 * MÉTRICAS › OFERTAS Y DESCUENTOS (0189, 20/10/2026, pedido del dueño)
 * ============================================================================
 * Dos preguntas, con la plata medida como en el resto de Métricas (neto, sin
 * IVA; ganancia solo sobre renglones con costo congelado; las notas de crédito
 * restan; las anuladas no cuentan):
 *
 *   1. DEL PRECIO DE LISTA A LA VENTA NETA, en el período: cuánto se dejó en
 *      precios cambiados a mano, en descuentos con nombre, en el del cliente o a
 *      mano, y en cada oferta. Sale de `metricas_descuento_dia` y
 *      `metricas_oferta_dia`, al día cada 10 minutos.
 *
 *   2. ¿CADA OFERTA ES RENTABLE? Para las ofertas con ventas en el período o
 *      vigentes en él, DESDE QUE EMPEZARON: con cuánto stock arrancaron (la foto
 *      de la 0189), cuánto se vendió con ellas, la ganancia y lo que habría
 *      dejado ese mismo volumen a precio normal, y el ritmo de venta y de
 *      ganancia por día contra la misma cantidad de días antes de la oferta.
 *
 * El filtro de sucursal vale para todo (ventas, foto y stock de hoy).
 */
import type { PoolClient } from 'pg';
import { hoyAr, sumarDias } from '../cafeteria/cuenta';
import { MARGEN_AL_EMPEZAR_MS, cubreSucursal, estadoOferta, inicioOferta } from '../ofertas/alcance';
import { donde, N, pct, r2, type Filtro } from './consultas';
import {
  CERO, diasEntre, enUnidad, porDia, resultado, sumar, vecesMas, vendidoDelStock, veredicto,
  type Cantidades, type Vendido,
} from './ofertas-cuentas';

const ZONA = 'America/Argentina/Buenos_Aires';
const diaAr = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: ZONA });
/** El «antes» se compara con la misma cantidad de días, hasta dos meses. */
const MAX_DIAS_COMPARAR = 60;
/** Tope de ofertas por consulta: más que eso no se lee en una pantalla. */
const MAX_OFERTAS = 200;

const claveArt = (p: number, pr: number) => `${p}-${pr}`;
/** «500 g», «1,5 kg»: el paquete por su tamaño, como en Fraccionamiento. */
const tamPaquete = (kg: number) => (kg < 1 ? `${Math.round(kg * 1000)} g` : `${String(kg).replace('.', ',')} kg`);

/* ============================== 1. EL DESGLOSE ============================== */

async function desglose(c: PoolClient, f: Filtro) {
  const w = donde(f, 'd');
  const wo = donde(f, 'o');
  const [conceptos, ofertas] = await Promise.all([
    c.query(
      `SELECT d.concepto, d.ref_id, max(d.nombre) AS nombre, sum(d.importe)::float8 AS importe, sum(d.renglones)::int AS renglones
       FROM metricas_descuento_dia d WHERE ${w.sql} GROUP BY 1, 2`, w.params),
    c.query(
      `SELECT o.oferta_id, coalesce(of.nombre, 'Oferta borrada') AS nombre, sum(o.descuento)::float8 AS importe,
         sum(o.renglones)::int AS renglones, sum(o.venta_neta)::float8 AS neto
       FROM metricas_oferta_dia o LEFT JOIN ofertas of ON of.id = o.oferta_id
       WHERE ${wo.sql} GROUP BY 1, 2 HAVING sum(o.descuento) <> 0 OR sum(o.venta_neta) <> 0 ORDER BY 3 DESC`, wo.params),
  ]);
  const de = (concepto: string) => conceptos.rows.filter((x) => x.concepto === concepto);
  const suma = (concepto: string) => r2(de(concepto).reduce((a, x) => a + N(x.importe), 0));
  const lista = suma('lista');
  const precio = suma('precio');
  const nombrados = de('nombrado').map((x) => ({ id: Number(x.ref_id), nombre: x.nombre || 'Descuento', importe: r2(N(x.importe)), renglones: N(x.renglones) }))
    .sort((a, b) => b.importe - a.importe);
  const cliente = suma('cliente');
  const cupones = de('cupon').map((x) => ({ id: Number(x.ref_id), nombre: x.nombre || 'Cupón', importe: r2(N(x.importe)), renglones: N(x.renglones) }))
    .sort((a, b) => b.importe - a.importe);
  const enCupones = r2(cupones.reduce((a, x) => a + x.importe, 0));
  const porOferta = ofertas.rows.map((x) => ({ id: Number(x.oferta_id), nombre: x.nombre, importe: r2(N(x.importe)), renglones: N(x.renglones), neto: r2(N(x.neto)) }));
  const enOfertas = r2(porOferta.reduce((a, x) => a + x.importe, 0));
  const enNombrados = r2(nombrados.reduce((a, x) => a + x.importe, 0));
  const neto = suma('neto');
  const extra = suma('extra');
  const costeado = suma('costeado');
  const costo = suma('costo');
  const descuentos = r2(precio + enNombrados + cliente + enCupones + enOfertas);
  return {
    lista,
    precio,
    nombrados,
    cliente,
    /** Los cupones de la tienda minorista (0190), uno por uno. */
    cupones,
    enCupones,
    ofertas: porOferta,
    enOfertas,
    enNombrados,
    /** Todo lo que se dejó de cobrar sobre el precio de lista. */
    descuentos,
    pctDescuentos: pct(descuentos, lista),
    neto,
    /** Lo que no cierra entre lista y neto: el redondeo al centavo de cada renglón. */
    redondeo: r2(lista - descuentos - neto),
    extra,
    /** Igual a la «Venta neta» de la pestaña Ventas: productos + cargos aparte. */
    ventaNeta: r2(neto + extra),
    costeado,
    costo,
    ganancia: r2(costeado - costo),
    /** Lo vendido sin costo cargado: queda afuera de la ganancia. */
    sinCosto: r2(neto - costeado),
  };
}

/* ============================== 2. CADA OFERTA ============================== */

export async function reporteOfertas(c: PoolClient, f: Filtro) {
  const hoy = hoyAr();
  const ahora = new Date();
  const desg = await desglose(c, f);

  /* Las ofertas a medir: con ventas en el período, o activas y corriendo en algún día del período. */
  const wo = donde(f, 'o');
  const conVentas = (await c.query(
    `SELECT DISTINCT o.oferta_id FROM metricas_oferta_dia o WHERE ${wo.sql} AND o.oferta_id > 0`, wo.params,
  )).rows.map((x) => Number(x.oferta_id));
  const todas = (await c.query(
    `SELECT id, nombre, tipo, porcentaje, precio, lleva, paga, monto_minimo, desde, hasta, sucursales, listas,
       activa, por_vencer, auto_vencimiento, creado_en, foto_stock_en
     FROM ofertas WHERE id = ANY($1::int[]) OR activa ORDER BY id DESC`, [conVentas],
  )).rows.map((o) => ({
    ...o, montoMinimo: o.monto_minimo, porVencer: o.por_vencer, auto: o.auto_vencimiento, creadoEn: o.creado_en,
  }));
  const elegidas = todas.filter((o) => {
    if (conVentas.includes(o.id)) return true;
    if (f.sucursalId && !cubreSucursal(o, f.sucursalId)) return false;
    const inicio = inicioOferta(o);
    if (!inicio || diaAr(inicio) > f.hasta) return false;
    return !o.hasta || diaAr(new Date(o.hasta)) >= f.desde;
  }).slice(0, MAX_OFERTAS);
  if (!elegidas.length) return { desde: f.desde, hasta: f.hasta, desglose: desg, ofertas: [], recortadas: false };
  const ids = elegidas.map((o) => o.id);
  const conSuc = f.sucursalId ? ' AND sucursal_id = $2' : '';
  const pSuc = (x: unknown[]) => (f.sucursalId ? [...x, f.sucursalId] : x);

  /* Lo vendido con cada oferta DESDE QUE EMPEZÓ (no solo en el período), por artículo. */
  const [vend, enPeriodo, fotos] = await Promise.all([
    c.query(
      `SELECT oferta_id, producto_id, presentacion_id, sum(unidades)::float8 AS unidades, sum(venta_neta)::float8 AS neto,
         sum(venta_costeada)::float8 AS costeado, sum(costo)::float8 AS costo, sum(descuento)::float8 AS descuento,
         sum(descuento_costeado)::float8 AS descuento_costeado, sum(renglones)::int AS renglones, sum(sin_costo)::int AS sin_costo,
         max(dia)::text AS ultimo
       FROM metricas_oferta_dia WHERE oferta_id = ANY($1::int[])${conSuc} GROUP BY 1, 2, 3`, pSuc([ids])),
    c.query(
      `SELECT o.oferta_id, sum(o.venta_neta)::float8 AS neto, sum(o.descuento)::float8 AS descuento
       FROM metricas_oferta_dia o WHERE ${wo.sql} AND o.oferta_id = ANY($${wo.params.length + 1}::int[]) GROUP BY 1`, [...wo.params, ids]),
    c.query(
      `SELECT oferta_id, producto_id, presentacion_id, sum(cantidad)::float8 AS cantidad, bool_and(al_empezar) AS al_empezar,
         min(tomado_en) AS tomado_en
       FROM oferta_stock_inicial WHERE oferta_id = ANY($1::int[])${conSuc} GROUP BY 1, 2, 3`, pSuc([ids])),
  ]);

  /* Los artículos que aparecen: nombre, si es granel suelto (kg) y el stock de hoy por sucursal. */
  const arts = new Map<string, { p: number; pr: number }>();
  for (const x of [...vend.rows, ...fotos.rows]) arts.set(claveArt(x.producto_id, x.presentacion_id), { p: Number(x.producto_id), pr: Number(x.presentacion_id) });
  const prodIds = [...new Set([...arts.values()].map((a) => a.p))];
  const [nombres, stockHoy] = prodIds.length ? await Promise.all([
    c.query(
      `SELECT p.id, p.nombre, p.tipo::text = 'granel' AS granel, pr.id AS pres_id, pr.tam_kg
       FROM productos p LEFT JOIN presentaciones pr ON pr.producto_id = p.id WHERE p.id = ANY($1::int[])`, [prodIds]),
    c.query(
      `SELECT producto_id, coalesce(presentacion_id, 0) AS presentacion_id, sucursal_id, sum(cantidad)::float8 AS cantidad
       FROM stock WHERE estado = 'disponible' AND producto_id = ANY($1::int[]) GROUP BY 1, 2, 3`, [prodIds]),
  ]) : [{ rows: [] as any[] }, { rows: [] as any[] }];
  const infoProd = new Map<number, { nombre: string; granel: boolean; pres: Map<number, string> }>();
  for (const x of nombres.rows) {
    const i = infoProd.get(x.id) ?? { nombre: x.nombre, granel: !!x.granel, pres: new Map() };
    if (x.pres_id) i.pres.set(Number(x.pres_id), tamPaquete(N(x.tam_kg)));
    infoProd.set(x.id, i);
  }
  const unidadDe = (p: number, pr: number): 'u' | 'kg' => (pr === 0 && infoProd.get(p)?.granel ? 'kg' : 'u');
  const nombreDe = (p: number, pr: number) => {
    const i = infoProd.get(p);
    return `${i?.nombre ?? `Producto ${p}`}${pr ? ` · ${i?.pres.get(pr) ?? `paquete ${pr}`}` : ''}`;
  };

  const salida: Record<string, unknown>[] = [];
  for (const o of elegidas) {
    const inicio = inicioOferta(o);
    const estado = estadoOferta(o, ahora);
    const susVentas = vend.rows.filter((x) => Number(x.oferta_id) === o.id);
    const susFotos = fotos.rows.filter((x) => Number(x.oferta_id) === o.id);
    const sucsOferta = (s: number) => cubreSucursal(o, s) && (!f.sucursalId || s === f.sucursalId);

    /* Por artículo: la foto, lo vendido con la oferta y el stock de hoy. */
    const porArt = new Map<string, any>();
    const fila = (p: number, pr: number) => {
      const k = claveArt(p, pr);
      if (!porArt.has(k)) {
        const hoyStock = stockHoy.rows.filter((s) => Number(s.producto_id) === p && Number(s.presentacion_id) === pr && sucsOferta(Number(s.sucursal_id)))
          .reduce((a, s) => a + N(s.cantidad), 0);
        porArt.set(k, {
          productoId: p, presentacionId: pr, nombre: nombreDe(p, pr), unidad: unidadDe(p, pr),
          stockInicial: null as number | null, alEmpezar: false, stockHoy: r2(hoyStock),
          vendido: 0, neto: 0, ganancia: 0, descuento: 0, sinCosto: 0,
        });
      }
      return porArt.get(k);
    };
    for (const x of susFotos) {
      const a = fila(Number(x.producto_id), Number(x.presentacion_id));
      a.stockInicial = r2(N(x.cantidad));
      a.alEmpezar = !!x.al_empezar;
    }
    const tot: Vendido = { neto: 0, costeado: 0, costo: 0, descuento: 0, descuentoCosteado: 0, renglones: 0, sinCosto: 0 };
    let cantVendida: Cantidades = CERO;
    let ultimoDia: string | null = null;
    for (const x of susVentas) {
      const a = fila(Number(x.producto_id), Number(x.presentacion_id));
      a.vendido = r2(a.vendido + N(x.unidades));
      a.neto = r2(a.neto + N(x.neto));
      a.ganancia = r2(a.ganancia + N(x.costeado) - N(x.costo));
      a.descuento = r2(a.descuento + N(x.descuento));
      a.sinCosto += N(x.sin_costo);
      cantVendida = sumar(cantVendida, enUnidad(a.unidad, N(x.unidades)));
      tot.neto += N(x.neto); tot.costeado += N(x.costeado); tot.costo += N(x.costo);
      tot.descuento += N(x.descuento); tot.descuentoCosteado += N(x.descuento_costeado);
      tot.renglones += N(x.renglones); tot.sinCosto += N(x.sin_costo);
      if (!ultimoDia || x.ultimo > ultimoDia) ultimoDia = x.ultimo;
    }
    const articulos = [...porArt.values()].sort((a, b) => b.neto - a.neto || a.nombre.localeCompare(b.nombre));

    /* La foto: con cuánto empezó (solo lo fotografiado) y cuánto hay hoy de lo mismo. */
    const conFoto = articulos.filter((a) => a.stockInicial != null);
    const stockInicial = conFoto.reduce((acc, a) => sumar(acc, enUnidad(a.unidad, a.stockInicial)), CERO);
    const vendidoDeLoFotografiado = conFoto.reduce((acc, a) => sumar(acc, enUnidad(a.unidad, a.vendido)), CERO);
    const hoyDeLoFotografiado = conFoto.reduce((acc, a) => sumar(acc, enUnidad(a.unidad, a.stockHoy)), CERO);

    /* El ritmo: lo vendido de esos artículos (con o sin oferta) por día, durante y antes. */
    const diaInicio = inicio ? diaAr(inicio) : null;
    const finCorrida = estado === 'vigente' ? hoy
      : o.hasta && diaAr(new Date(o.hasta)) < hoy ? diaAr(new Date(o.hasta)) : ultimoDia ?? hoy;
    let ritmo: Record<string, unknown> | null = null;
    if (diaInicio && finCorrida >= diaInicio && porArt.size) {
      const dias = diasEntre(diaInicio, finCorrida);
      const diasAntes = Math.min(dias, MAX_DIAS_COMPARAR);
      const antesDesde = sumarDias(diaInicio, -diasAntes);
      const antesHasta = sumarDias(diaInicio, -1);
      const prods = articulos.map((a) => a.productoId);
      const press = articulos.map((a) => a.presentacionId);
      const r = await c.query(
        `SELECT m.producto_id, m.presentacion_id, m.sucursal_id, (m.dia >= $3::date) AS durante,
           sum(m.unidades)::float8 AS unidades, sum(m.venta_neta)::float8 AS neto,
           sum(m.venta_costeada - m.costo)::float8 AS ganancia
         FROM metricas_venta_prod_dia m
           JOIN unnest($1::int[], $2::int[]) AS a(p, pr) ON a.p = m.producto_id AND a.pr = m.presentacion_id
         WHERE m.dia BETWEEN $4::date AND $5::date
         GROUP BY 1, 2, 3, 4`, [prods, press, diaInicio, antesDesde, finCorrida]);
      const tramo = (durante: boolean) => r.rows.filter((x) => x.durante === durante && sucsOferta(Number(x.sucursal_id)))
        .reduce((acc, x) => ({
          cant: sumar(acc.cant, enUnidad(unidadDe(Number(x.producto_id), Number(x.presentacion_id)), N(x.unidades))),
          neto: acc.neto + N(x.neto), ganancia: acc.ganancia + N(x.ganancia),
        }), { cant: CERO, neto: 0, ganancia: 0 });
      const antes = porDia(tramo(false), diasAntes);
      const durante = porDia(tramo(true), dias);
      ritmo = {
        dias, diasAntes, antesDesde, antesHasta, desde: diaInicio, hasta: finCorrida, antes, durante,
        vecesUnidades: vecesMas(antes.u + antes.kg, durante.u + durante.kg),
        difGananciaDia: r2(durante.ganancia - antes.ganancia),
      };
    }

    const per = enPeriodo.rows.find((x) => Number(x.oferta_id) === o.id);
    salida.push({
      id: o.id, nombre: o.nombre, tipo: o.tipo, porcentaje: o.porcentaje, precio: o.precio, lleva: o.lleva, paga: o.paga,
      montoMinimo: o.montoMinimo, desde: o.desde, hasta: o.hasta, inicio, estado, porVencer: o.porVencer, auto: o.auto,
      sucursales: o.sucursales,
      vendido: {
        cantidades: { u: r2(cantVendida.u), kg: r2(cantVendida.kg) },
        neto: r2(tot.neto), costeado: r2(tot.costeado), costo: r2(tot.costo),
        descuento: r2(tot.descuento), renglones: tot.renglones, sinCosto: tot.sinCosto,
        ...resultado(tot),
      },
      veredicto: veredicto(tot),
      enPeriodo: { neto: r2(N(per?.neto)), descuento: r2(N(per?.descuento)) },
      stock: {
        /* Sacada (aunque no haya dado filas: entonces empezó sin stock de lo que alcanza). */
        conFoto: !!o.foto_stock_en,
        fotografiados: conFoto.length,
        alEmpezar: !!o.foto_stock_en && !!inicio && new Date(o.foto_stock_en).getTime() - inicio.getTime() <= MARGEN_AL_EMPEZAR_MS
          && conFoto.every((a) => a.alEmpezar),
        tomadoEn: o.foto_stock_en,
        inicial: { u: r2(stockInicial.u), kg: r2(stockInicial.kg) },
        vendido: { u: r2(vendidoDeLoFotografiado.u), kg: r2(vendidoDeLoFotografiado.kg) },
        hoy: { u: r2(hoyDeLoFotografiado.u), kg: r2(hoyDeLoFotografiado.kg) },
        pctVendido: vendidoDelStock(stockInicial, vendidoDeLoFotografiado),
      },
      ritmo,
      articulos,
    });
  }
  return { desde: f.desde, hasta: f.hasta, desglose: desg, ofertas: salida, recortadas: elegidas.length === MAX_OFERTAS };
}
