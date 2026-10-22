/**
 * GERENCIA › ASESOR · LA FOTO DEL NEGOCIO (0193)
 * ============================================================================
 * Lo que la IA lee en cada análisis: unas pocas páginas de números ya
 * calculados. Tres ventanas fijas, para comparar siempre igual:
 *   · el MES en curso contra los mismos días del mes anterior;
 *   · los ÚLTIMOS 30 DÍAS contra los 30 de antes (lo que cambió último);
 *   · el mes anterior completo y el actual en Resultados.
 * Cada parte se arma por separado: si una falla, va su error y el resto sigue.
 */
import type { Fuentes } from '../datos';
import {
  caja, comparar, contexto, costosQueSubieron, fraccionado, gastos, granelYEnteros, mismosDiasMesAnterior, ofertas, paquetes, periodo,
  rentabilidad, resultados, seguro, stock, ultimosDias, ventas,
} from '../datos';
import { hoyAr } from '../../cafeteria/cuenta';


const mesDe = (d: string) => d.slice(0, 7);
const mesAntes = (m: string) => { const [y, mm] = m.split('-').map(Number); return mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, '0')}`; };
const ultimoDiaDe = (m: string) => { const [y, mm] = m.split('-').map(Number); return `${m}-${String(new Date(Date.UTC(y, mm, 0)).getUTCDate()).padStart(2, '0')}`; };

export async function armarFoto(f: Fuentes) {
  const hoy = hoyAr();
  const mes = periodo(`${hoy.slice(0, 8)}01`, hoy);
  const mesAnt = mismosDiasMesAnterior(mes);
  const { a: u30, b: p30 } = ultimosDias(30);
  const mesPasado = mesAntes(mesDe(hoy));

  /* Todo lo que lee las tablas resumen, en UNA conexión de solo lectura del pool de Métricas. */
  const sobreMetricas = await f.metricas.leer(async (c) => ({
    contexto: await contexto(c),
    ventasDelMes: await seguro(() => ventas(c, mes, mesAnt)),
    rentabilidad: {
      porSucursalDelMes: await seguro(() => rentabilidad(c, mes, mesAnt, 'sucursal', { limite: 10 })),
      porCategoria30Dias: await seguro(() => rentabilidad(c, u30, p30, 'categoria', { limite: 15 })),
      categoriasQueMasCayeronDeMargen30Dias: await seguro(() => rentabilidad(c, u30, p30, 'categoria', { orden: 'caida_margen', limite: 6 })),
      porMarca30Dias: await seguro(() => rentabilidad(c, u30, p30, 'marca', { limite: 12 })),
      porProveedor30Dias: await seguro(() => rentabilidad(c, u30, p30, 'proveedor', { limite: 12 })),
      porModalidadDelMes: await seguro(() => rentabilidad(c, mes, mesAnt, 'modalidad', { limite: 6 })),
      productosQueMasVenden30Dias: await seguro(() => rentabilidad(c, u30, p30, 'producto', { limite: 20 })),
      productosDePeorMargen30Dias: await seguro(() => rentabilidad(c, u30, p30, 'producto', { orden: 'margen_pct_menor', limite: 15 })),
      productosVendidosAPerdida30Dias: await seguro(() => rentabilidad(c, u30, p30, 'producto', { orden: 'perdida', limite: 15 })),
      productosQueMasCayeronDeMargen30Dias: await seguro(() => rentabilidad(c, u30, p30, 'producto', { orden: 'caida_margen', limite: 10 })),
    },
    granelYEnterosDelMes: await seguro(() => granelYEnteros(c, mes)),
    fraccionado30Dias: await seguro(() => fraccionado(c, u30)),
    paquetesDeGranel30Dias: await seguro(() => paquetes(c, 30, null)),
    queCambio30Dias: await seguro(() => comparar(c, u30, p30)),
    costosQueSubieron30Dias: await seguro(() => costosQueSubieron(c, 30)),
    caja30Dias: await seguro(() => caja(c, u30)),
    ofertasDelMes: await seguro(() => ofertas(c, mes)),
  }));

  /* Lo que va por sus propios servicios (Gastos usa la base principal; Resultados y el stock, el pool de Métricas). */
  const [stockHoy, gastosDelMes, gastosMesPasado, estado] = await Promise.all([
    seguro(() => stock(f, null)),
    seguro(() => gastos(f, mes.desde, mes.hasta, null)),
    seguro(() => gastos(f, `${mesPasado}-01`, ultimoDiaDe(mesPasado), null)),
    seguro(() => resultados(f, mesPasado, mesDe(hoy))),
  ]);

  const { contexto: ctx, ...resto } = sobreMetricas;
  return {
    generada: new Date().toISOString(),
    contexto: {
      ...ctx,
      ventanas: {
        mes: `${mes.desde} a ${mes.hasta} (comparado con ${mesAnt.desde} a ${mesAnt.hasta})`,
        ultimos30Dias: `${u30.desde} a ${u30.hasta} (comparado con ${p30.desde} a ${p30.hasta})`,
      },
      unidades: 'Importes en pesos argentinos, NETOS (sin IVA) salvo que diga «conIva». Granel en kg. Margen = venta − costo de lo vendido (solo renglones con costo cargado).',
    },
    ...resto,
    stockHoy,
    gastos: { delMes: gastosDelMes, mesPasadoCompleto: gastosMesPasado },
    resultados: estado,
  };
}

export type Foto = Awaited<ReturnType<typeof armarFoto>>;
