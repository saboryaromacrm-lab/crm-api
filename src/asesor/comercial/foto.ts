/**
 * ASESOR COMERCIAL · LA FOTO (0193)
 * ============================================================================
 * Lo que lee en cada análisis, armado por el sistema: lo que viene (fechas),
 * lo que vence, lo que ya hay armado (ofertas) y cómo rindieron, lo que más se
 * vende y lo que crece o cae, lo que se compra junto (combos), lo que no se
 * mueve (stock parado y paquetes sobrefraccionados), cómo se vende en cada
 * día y hora, la tienda online y los cupones.
 */
import type { Fuentes } from '../datos';
import { comparar, contexto, mismosDiasMesAnterior, ofertas, paquetes, periodo, rentabilidad, seguro, stock, ultimosDias, ventas } from '../datos';
import { compradosJuntos, cupones, fechas, ofertasArmadas, preciosDeHoy, tiendaOnline, vencimientos } from './datos';
import { hoyAr } from '../../cafeteria/cuenta';

export async function armarFoto(f: Fuentes) {
  const hoy = hoyAr();
  const mes = periodo(`${hoy.slice(0, 8)}01`, hoy);
  const mesAnt = mismosDiasMesAnterior(mes);
  const { a: u30, b: p30 } = ultimosDias(30);
  const { a: u60 } = ultimosDias(60);

  /* Lo que lee las tablas resumen y las tablas chicas, en UNA conexión de solo lectura del pool de Métricas. */
  const sobreMetricas = await f.metricas.leer(async (c) => {
    const paq = await seguro(() => paquetes(c, 30, null));
    const cambio = await seguro(() => comparar(c, u30, p30));
    return {
      contexto: await contexto(c),
      queViene: await seguro(() => fechas(c, 75)),
      porVencer: await seguro(() => vencimientos(c, 45)),
      ofertasActivasHoy: await seguro(() => ofertasArmadas(c)),
      comoRindieronLasOfertas60Dias: await seguro(() => ofertas(c, u60)),
      ventasDelMes: await seguro(() => ventas(c, mes, mesAnt)),
      productosQueMasVenden30Dias: await seguro(() => rentabilidad(c, u30, p30, 'producto', { limite: 20 })),
      productosQueMasCrecenYCaen30Dias: 'error' in cambio ? cambio : { suben: cambio.productosQueSuben, bajan: cambio.productosQueBajan, porCategoria: cambio.porCategoria },
      compradosJuntos60Dias: await seguro(() => compradosJuntos(c, 60, null, 20)),
      paquetesSobrefraccionados: 'error' in paq ? paq : paq.sobrefraccionado,
    };
  });

  const [stockHoy, tienda, cup] = await Promise.all([
    seguro(() => stock(f, null, null, 12)),
    seguro(() => tiendaOnline(f, 30)),
    seguro(() => cupones(f, u60.desde, u60.hasta)),
  ]);

  const { contexto: ctx, ...resto } = sobreMetricas;
  const parado = 'error' in stockHoy ? stockHoy : { resumen: stockHoy.resumen, parado: stockHoy.parado, sobrestock: stockHoy.sobrestock };
  const precios = await seguro(() => preciosDeHoy(f, articulosDe([resto, parado])));
  return {
    generada: new Date().toISOString(),
    contexto: {
      ...ctx,
      ventanas: { mes: `${mes.desde} a ${mes.hasta} (comparado con ${mesAnt.desde} a ${mesAnt.hasta})`, ultimos30Dias: `${u30.desde} a ${u30.hasta}` },
      unidades: 'Importes NETOS (sin IVA) salvo los que dicen «conIva» y los de la tienda online (pedidos con IVA). Los precios de las ofertas son FINALES (con IVA). Granel en kg.',
    },
    ...resto,
    stockQueNoSeMueve: parado,
    tiendaOnline30Dias: tienda,
    cupones60Dias: cup,
    preciosDeHoy: Array.isArray(precios)
      ? { nota: 'Precio de hoy de la lista base (FINAL, con IVA) y costo (NETO) de cada artículo que aparece arriba: armá las promociones sobre estos precios.', articulos: precios }
      : precios,
  };
}

/** Cada {productoId, presentacionId?} que aparece en la foto (en cualquier nivel). */
function articulosDe(partes: unknown[]) {
  const out: { productoId: number; presentacionId?: number }[] = [];
  const recorrer = (v: any) => {
    if (Array.isArray(v)) v.forEach(recorrer);
    else if (v && typeof v === 'object') {
      if (Number(v.productoId) > 0) out.push({ productoId: Number(v.productoId), presentacionId: Number(v.presentacionId) || 0 });
      Object.values(v).forEach(recorrer);
    }
  };
  partes.forEach(recorrer);
  return out;
}
