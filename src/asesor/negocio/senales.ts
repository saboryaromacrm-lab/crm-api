/**
 * GERENCIA › ASESOR · LAS SEÑALES (0193)
 * ============================================================================
 * Lo raro que el SISTEMA detecta solo, con reglas fijas, sobre la foto: no
 * gasta IA, se ve aunque la IA no esté configurada, y la IA lo recibe como
 * punto de partida (no tiene que «descubrirlo», tiene que explicarlo).
 * Funciones puras: se prueban sin base (senales.test.ts).
 */
import type { Nivel, Senal } from '../nucleo/especialidad';

/** Los umbrales, juntos y con nombre: si el dueño quiere más o menos sensibilidad, se toca acá. */
export const UMBRALES = {
  ventaCaeUrgentePct: -20, ventaCaeMirarPct: -10, ventaSubeDatoPct: 15, sucursalCaePct: -20, sucursalMinParticipacionPct: 5,
  ticketPromedioCaePct: -10,
  margenCaeUrgentePp: 3, margenCaeMirarPp: 1.5, ventaSinCostoPct: 3, categoriaCaePp: 3,
  faltantesFraccionadoPct: 2, stockParadoPct: 25, agotarseDias: 3,
  cajaFaltantesVeces: 3, cajaFaltantesSuma: -20000, otroEgresoPct: 20,
  metricasViejasHoras: 2, minDiasDelMes: 3,
};

const ok = (x: any) => x && typeof x === 'object' && !('error' in x);
const $ = (n: number) => `$${Math.round(n).toLocaleString('es-AR')}`;
const nombres = (xs: any[], k: string, n = 4) => xs.slice(0, n).map((x) => x[k]).join(', ') + (xs.length > n ? ` y ${xs.length - n} más` : '');
const dia = (iso: string) => Number(iso.slice(8, 10));
const diasDelMes = (iso: string) => { const [y, m] = iso.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

/** Los números de ventas (Métricas) sin sincronizar hace horas: lo de hoy puede faltar. La usan los dos especialistas. */
export function metricasViejas(foto: any, ahora = new Date()): Senal | null {
  const al = foto?.contexto?.metricasAl ? new Date(foto.contexto.metricasAl).getTime() : null;
  if (al != null && ahora.getTime() - al <= UMBRALES.metricasViejasHoras * 3600_000) return null;
  return { nivel: 'dato', area: 'datos', titulo: 'Los números de ventas no están al día', detalle: 'Métricas no se sincronizó en las últimas horas: lo de hoy puede faltar. Apretá «Sincronizar» en Gerencia › Métricas.' };
}

export function detectar(foto: any, ahora = new Date()): Senal[] {
  const s: Senal[] = [];
  const U = UMBRALES;
  const hoy: string = foto?.contexto?.hoy ?? ahora.toISOString().slice(0, 10);

  /* Datos */
  const viejas = metricasViejas(foto, ahora);
  if (viejas) s.push(viejas);

  /* Ventas del mes */
  const v = foto?.ventasDelMes;
  if (ok(v) && v.diasConVenta >= U.minDiasDelMes && v.variacionVentaPct != null) {
    if (v.variacionVentaPct <= U.ventaCaeUrgentePct) s.push({ nivel: 'urgente', area: 'ventas', titulo: `Las ventas del mes caen ${Math.abs(v.variacionVentaPct)} %`, detalle: `${$(v.ventaNeta)} contra ${$(v.antes.ventaNeta)} los mismos días del mes pasado.` });
    else if (v.variacionVentaPct <= U.ventaCaeMirarPct) s.push({ nivel: 'mirar', area: 'ventas', titulo: `Las ventas del mes bajan ${Math.abs(v.variacionVentaPct)} %`, detalle: `${$(v.ventaNeta)} contra ${$(v.antes.ventaNeta)} los mismos días del mes pasado.` });
    else if (v.variacionVentaPct >= U.ventaSubeDatoPct) s.push({ nivel: 'dato', area: 'ventas', titulo: `Las ventas del mes suben ${v.variacionVentaPct} %`, detalle: `${$(v.ventaNeta)} contra ${$(v.antes.ventaNeta)} los mismos días del mes pasado.` });
    if (v.variacionTicketPromedioPct != null && v.variacionTicketPromedioPct <= U.ticketPromedioCaePct) {
      s.push({ nivel: 'mirar', area: 'ventas', titulo: `El ticket promedio baja ${Math.abs(v.variacionTicketPromedioPct)} %`, detalle: `${$(v.ticketPromedio)} contra ${$(v.antes.ticketPromedio)}.` });
    }
    for (const x of v.porSucursal ?? []) {
      if ((x.participacionPct ?? 0) >= U.sucursalMinParticipacionPct && x.variacionVentaPct != null && x.variacionVentaPct <= U.sucursalCaePct) {
        s.push({ nivel: 'mirar', area: 'ventas', titulo: `${x.sucursal}: ventas ${x.variacionVentaPct} %`, detalle: `Vendió ${$(x.ventaNeta)} en el mes, contra los mismos días del mes pasado.` });
      }
    }
  }

  /* Rentabilidad */
  const r = foto?.rentabilidad ?? {};
  const t = ok(r.porSucursalDelMes) ? r.porSucursalDelMes.totales : null;
  if (t && t.margenPct != null && t.margenPctAntes != null && ok(v) && v.diasConVenta >= U.minDiasDelMes) {
    const cae = Math.round((t.margenPctAntes - t.margenPct) * 10) / 10;
    if (cae >= U.margenCaeUrgentePp) s.push({ nivel: 'urgente', area: 'rentabilidad', titulo: `El margen del mes cae ${cae} puntos`, detalle: `${t.margenPct} % contra ${t.margenPctAntes} % los mismos días del mes pasado.` });
    else if (cae >= U.margenCaeMirarPp) s.push({ nivel: 'mirar', area: 'rentabilidad', titulo: `El margen del mes baja ${cae} puntos`, detalle: `${t.margenPct} % contra ${t.margenPctAntes} %.` });
  }
  if (t && t.ventaNeta > 0 && (t.ventaSinCosto / t.ventaNeta) * 100 >= U.ventaSinCostoPct) {
    s.push({ nivel: 'dato', area: 'datos', titulo: 'Hay ventas sin costo cargado', detalle: `${$(t.ventaSinCosto)} del mes no tienen costo: no entran al margen y el margen real puede ser otro.` });
  }
  const perdida = ok(r.productosVendidosAPerdida30Dias) ? r.productosVendidosAPerdida30Dias.filas : [];
  if (perdida.length) {
    const total = perdida.reduce((a: number, x: any) => a + x.margen, 0);
    s.push({ nivel: 'urgente', area: 'rentabilidad', titulo: `${perdida.length} producto(s) se vendieron a pérdida en 30 días`, detalle: `${nombres(perdida, 'nombre')}: entre todos, ${$(total)}.` });
  }
  const catCae = ok(r.categoriasQueMasCayeronDeMargen30Dias) ? r.categoriasQueMasCayeronDeMargen30Dias.filas : [];
  for (const x of catCae) {
    const cae = x.margenPctAntes != null && x.margenPct != null ? Math.round((x.margenPctAntes - x.margenPct) * 10) / 10 : 0;
    if (cae >= U.categoriaCaePp) s.push({ nivel: 'mirar', area: 'rentabilidad', titulo: `${x.nombre}: el margen cae ${cae} puntos`, detalle: `${x.margenPct} % contra ${x.margenPctAntes} % los 30 días anteriores.` });
  }

  /* Costos */
  const cs = foto?.costosQueSubieron30Dias;
  if (ok(cs) && cs.sinTrasladar?.length) {
    s.push({ nivel: 'urgente', area: 'precios', titulo: `${cs.sinTrasladar.length} producto(s) con precio fijo no siguieron la suba del costo`, detalle: `${nombres(cs.sinTrasladar, 'producto')}: el costo subió y el precio fijo quedó igual.` });
  }

  /* Granel y fraccionado */
  const p = foto?.paquetesDeGranel30Dias;
  if (ok(p)) {
    if (p.sinGranelParaFraccionar?.length) s.push({ nivel: 'mirar', area: 'granel', titulo: `${p.sinGranelParaFraccionar.length} paquete(s) se terminan y no hay granel para fraccionar`, detalle: `${nombres(p.sinGranelParaFraccionar, 'producto')}: hay que pedirlo al proveedor.` });
    if (p.aFraccionar?.length) s.push({ nivel: 'dato', area: 'granel', titulo: `${p.aFraccionar.length} paquete(s) para fraccionar esta semana`, detalle: `Alcanzan para menos de 7 días: ${nombres(p.aFraccionar, 'producto')}.` });
    if (p.precioPorKgIncoherente?.length) s.push({ nivel: 'mirar', area: 'granel', titulo: `${p.precioPorKgIncoherente.length} granel(es) con el paquete chico más barato por kg que el grande`, detalle: `${nombres(p.precioPorKgIncoherente, 'producto')}: revisá el precio de cada tamaño.` });
    if (p.sobrefraccionado?.length) {
      const kg = p.sobrefraccionado.reduce((a: number, x: any) => a + x.kgEnPaquetes, 0);
      s.push({ nivel: 'mirar', area: 'granel', titulo: `${Math.round(kg)} kg en paquetes que no rotan`, detalle: `Más de 90 días de stock o sin ventas: ${nombres(p.sobrefraccionado, 'producto')}.` });
    }
  }
  const fr = foto?.fraccionado30Dias;
  if (ok(fr) && fr.faltantesPctDeLoFraccionado != null && fr.faltantesPctDeLoFraccionado >= U.faltantesFraccionadoPct) {
    s.push({ nivel: 'mirar', area: 'granel', titulo: `Faltaron ${fr.faltantesPctDeLoFraccionado} % de los paquetes fraccionados`, detalle: `${fr.kgFaltantesAlCorregir} kg dados de baja al corregir, sobre ${fr.kgFraccionados} kg fraccionados en 30 días.` });
  }

  /* Stock */
  const st = foto?.stockHoy;
  if (ok(st)) {
    if ((st.resumen?.pctParado ?? 0) >= U.stockParadoPct) s.push({ nivel: 'mirar', area: 'stock', titulo: `${st.resumen.pctParado} % del stock no se vendió en 30 días`, detalle: `${$(st.resumen.valorParado)} a costo, parados.` });
    const ya = (st.porAgotarse ?? []).filter((x: any) => x.diasDeStock != null && x.diasDeStock <= U.agotarseDias);
    if (ya.length) s.push({ nivel: 'mirar', area: 'stock', titulo: `${ya.length} producto(s) que se venden se terminan en ${U.agotarseDias} días o menos`, detalle: nombres(ya, 'producto') });
  }

  /* Caja */
  const cj = foto?.caja30Dias;
  if (ok(cj)) {
    for (const x of cj.porCajero ?? []) {
      if (x.faltantes >= U.cajaFaltantesVeces || x.sumaFaltantes <= U.cajaFaltantesSuma) {
        s.push({ nivel: 'mirar', area: 'caja', titulo: `${x.nombre}: ${x.faltantes} cierre(s) con faltante en 30 días`, detalle: `Faltantes por ${$(Math.abs(x.sumaFaltantes))} en ${x.turnos} turno(s); neto ${$(x.neto)}.` });
      }
    }
    const otro = (cj.egresosPorConcepto ?? []).find((x: any) => x.que === 'Otro egreso');
    if (otro && (otro.pct ?? 0) >= U.otroEgresoPct) s.push({ nivel: 'dato', area: 'caja', titulo: `«Otro egreso» es el ${otro.pct} % de lo que sale de las cajas`, detalle: 'Conviene crear conceptos para lo que más se repite: así se puede seguir.' });
  }

  /* Gastos: un rubro que en lo que va del mes ya superó todo el mes pasado */
  const g = foto?.gastos;
  if (ok(g?.delMes) && ok(g?.mesPasadoCompleto)) {
    const antes = new Map((g.mesPasadoCompleto.porRubro ?? []).map((x: any) => [x.rubro, x.total]));
    for (const x of g.delMes.porRubro ?? []) {
      const a = Number(antes.get(x.rubro) ?? 0);
      if (a > 0 && x.total > a * 1.1 && x.total - a >= 50000) s.push({ nivel: 'mirar', area: 'gastos', titulo: `${x.rubro}: el mes ya gastó más que todo el mes pasado`, detalle: `${$(x.total)} contra ${$(a)} (con IVA).` });
    }
  }

  /* Resultados */
  const rs = foto?.resultados;
  if (ok(rs)) {
    const pasado = (rs.meses ?? []).find((m: any) => !m.enCurso);
    if (pasado && pasado.resultadoOperativo < 0) s.push({ nivel: 'urgente', area: 'resultados', titulo: `${pasado.mes} cerró con resultado operativo negativo`, detalle: `${$(pasado.resultadoOperativo)}: las ventas no cubrieron los gastos fijos.` });
    const actual = (rs.meses ?? []).find((m: any) => m.enCurso);
    if (actual && dia(hoy) >= 7) {
      const proyectado = (actual.ventasNetas / dia(hoy)) * diasDelMes(hoy);
      if (actual.puntoDeEquilibrio && proyectado < actual.puntoDeEquilibrio) {
        s.push({ nivel: 'mirar', area: 'resultados', titulo: 'Al ritmo de hoy, el mes no llega al punto de equilibrio', detalle: `Proyección de ventas ${$(proyectado)}; equilibrio ${$(actual.puntoDeEquilibrio)}.` });
      }
      if (actual.objetivoVenta && proyectado < actual.objetivoVenta * 0.9) {
        s.push({ nivel: 'mirar', area: 'resultados', titulo: 'Al ritmo de hoy, el mes queda lejos del objetivo', detalle: `Proyección ${$(proyectado)}; objetivo ${$(actual.objetivoVenta)}.` });
      }
    }
  }

  /* Ofertas */
  const of = foto?.ofertasDelMes;
  if (ok(of)) {
    const pierden = (of.ofertas ?? []).filter((x: any) => x.veredicto === 'pierde');
    if (pierden.length) s.push({ nivel: 'mirar', area: 'ofertas', titulo: `${pierden.length} oferta(s) pierden plata`, detalle: nombres(pierden, 'oferta') });
  }

  const orden: Record<Nivel, number> = { urgente: 0, mirar: 1, dato: 2 };
  return s.sort((a, b) => orden[a.nivel] - orden[b.nivel]);
}
