/**
 * GERENCIA › INDICADORES — los números del negocio SOLO EN PORCENTAJES (1/11/2026)
 * ============================================================================
 * Pedido del dueño: «mostrarle datos a mi encargada pero sin montos, solo
 * porcentajes». Todo se calcula ACÁ, en el servidor, y la respuesta lleva
 * únicamente %, puntos y cantidades de cierres o artículos: ni un peso. Así
 * no alcanza con abrir la consola del navegador para ver la plata.
 *
 * Lee las mismas tablas resumen que Métricas (con su pool propio y en solo
 * lectura): abrir esta pantalla no frena a ninguna caja.
 */
import type { PoolClient } from 'pg';
import { N, donde, pct, periodoAnterior, r2, reporteGranel, reporteMargenes, variacion, type Filtro } from '../metricas/consultas';
import { leerActividad, porDiaAbierto } from '../metricas/actividad';
import { desglose } from '../metricas/ofertas';

const MS_DIA = 86_400_000;
const sumarDias = (p: string, n: number) => new Date(Date.parse(`${p}T00:00:00Z`) + n * MS_DIA).toISOString().slice(0, 10);

/** Hace un año, en los mismos días de la semana (364 días): un sábado contra un sábado. */
const haceUnAnio = (f: Filtro): Filtro => ({ ...f, desde: sumarDias(f.desde, -364), hasta: sumarDias(f.hasta, -364) });

/** Puntos de diferencia entre dos %: 32 % contra 30 % son +2 pts. */
const puntos = (a: number | null, b: number | null) => (a == null || b == null ? null : r2(a - b));

async function ventasYTickets(c: PoolClient, f: Filtro) {
  const w = donde(f, 'd');
  const r = await c.query(
    `SELECT coalesce(sum(d.venta_neta), 0)::float8 AS venta, coalesce(sum(d.tickets), 0)::float8 AS tickets,
       coalesce(sum(d.notas), 0)::float8 AS notas
     FROM metricas_venta_dia d WHERE ${w.sql}`, w.params);
  const x = r.rows[0];
  return { venta: N(x.venta), tickets: N(x.tickets), notas: N(x.notas) };
}

async function participacionSucursales(c: PoolClient, f: Filtro) {
  // Siempre todas las sucursales: qué parte es cada una del total, aunque arriba se haya elegido un local.
  const w = donde({ ...f, sucursalId: null }, 'd');
  const r = await c.query(
    `SELECT d.sucursal_id, coalesce(s.nombre, 'Sin sucursal') AS nombre, sum(d.venta_neta)::float8 AS venta
     FROM metricas_venta_dia d LEFT JOIN sucursales s ON s.id = d.sucursal_id
     WHERE ${w.sql} GROUP BY 1, 2`, w.params);
  const total = r.rows.reduce((a, x) => a + N(x.venta), 0);
  return new Map<number, { nombre: string; pct: number | null }>(r.rows.map((x) => [N(x.sucursal_id), { nombre: x.nombre, pct: pct(N(x.venta), total) }]));
}

/**
 * Cierres de caja del período (por el día del cierre, hora argentina) y cuántos
 * tuvieron una diferencia que IMPORTA: la que pasa el mismo tope de «Cajas a
 * controlar» (Cash Flow, $5.000 por defecto). Las monedas no se cuentan al
 * cerrar, así que casi todo turno tiene unos pesos de diferencia: contarlos
 * daría «100 % con diferencia» y el indicador no diría nada.
 */
async function cierres(c: PoolClient, f: Filtro) {
  const params: unknown[] = [f.desde, f.hasta];
  if (f.sucursalId) params.push(f.sucursalId);
  const r = await c.query(
    `SELECT count(*)::float8 AS cierres,
       count(*) FILTER (WHERE abs(cs.diferencia) > coalesce((SELECT umbral_controlar FROM cashflow_caja ORDER BY id LIMIT 1), 5000))::float8 AS con_diferencia
     FROM caja_sesiones cs
     WHERE cs.estado = 'cerrada' AND cs.cierre IS NOT NULL
       AND (cs.cierre AT TIME ZONE 'America/Argentina/Buenos_Aires')::date BETWEEN $1::date AND $2::date
       ${f.sucursalId ? 'AND cs.sucursal_id = $3' : ''}`, params);
  return { cierres: N(r.rows[0].cierres), conDiferencia: N(r.rows[0].con_diferencia) };
}

/** Qué parte de la venta con costo se vendió por debajo de ese costo (renglón resumido por producto, día y local). */
async function bajoCosto(c: PoolClient, f: Filtro) {
  const w = donde(f, 'p');
  const r = await c.query(
    `SELECT coalesce(sum(p.venta_costeada), 0)::float8 AS costeada,
       coalesce(sum(p.venta_costeada) FILTER (WHERE p.costo > p.venta_costeada + 0.01), 0)::float8 AS bajo
     FROM metricas_venta_prod_dia p WHERE ${w.sql}`, w.params);
  return pct(N(r.rows[0].bajo), N(r.rows[0].costeada));
}

export async function calcularIndicadores(c: PoolClient, f: Filtro) {
  const ant = periodoAnterior(f);
  const anio = haceUnAnio(f);
  const wh = donde(f, 'h');
  const wd = donde(f, 'd');
  const wp = donde(f, 'p');
  const [ahora, antes, anioPasado, sucs, sucsAnt, horas, semana, medios, mCat, mSuc, granel, desc, caja, bajo, abrioAhora, abrioAntes] = await Promise.all([
    ventasYTickets(c, f),
    ventasYTickets(c, ant),
    ventasYTickets(c, anio),
    participacionSucursales(c, f),
    participacionSucursales(c, ant),
    c.query(`SELECT h.hora::int AS hora, sum(h.tickets)::float8 AS tickets FROM metricas_venta_hora h WHERE ${wh.sql} GROUP BY 1 ORDER BY 1`, wh.params),
    c.query(
      `SELECT extract(isodow FROM d.dia)::int AS dow, sum(d.venta_neta)::float8 AS venta, count(DISTINCT d.dia)::float8 AS dias
       FROM metricas_venta_dia d WHERE ${wd.sql} GROUP BY 1 ORDER BY 1`, wd.params),
    c.query(`SELECT p.medio, sum(p.importe)::float8 AS importe FROM metricas_venta_pago_dia p WHERE ${wp.sql} GROUP BY 1`, wp.params),
    reporteMargenes(c, f, 'mes', 'categoria'),
    reporteMargenes(c, { ...f, sucursalId: null }, 'mes', 'sucursal'),
    reporteGranel(c, f, 'mes'),
    desglose(c, f),
    cierres(c, f),
    bajoCosto(c, f),
    leerActividad(c, f),
    leerActividad(c, ant),
  ]);

  const tp = (x: { venta: number; tickets: number }) => (x.tickets > 0 ? x.venta / x.tickets : 0);
  const totTickets = horas.rows.reduce((a, x) => a + N(x.tickets), 0);
  // Día de la semana: el PROMEDIO por día de cada uno, para que no pese que el mes tenga más lunes.
  const promedios = semana.rows.map((x) => ({ dia: N(x.dow), prom: N(x.dias) > 0 ? N(x.venta) / N(x.dias) : 0 }));
  const totProm = promedios.reduce((a, x) => a + x.prom, 0);
  const totMedios = medios.rows.reduce((a, x) => a + N(x.importe), 0);
  const credito = medios.rows.find((x) => x.medio === 'tarjeta_credito');

  return {
    desde: f.desde, hasta: f.hasta, sucursalId: f.sucursalId,
    anterior: { desde: ant.desde, hasta: ant.hasta }, comparar: f.comparar === 'mes' ? 'mes' : 'anterior',
    anioPasado: { desde: anio.desde, hasta: anio.hasta },
    valores: {
      crecimiento: variacion(ahora.venta, antes.venta),
      /* Por día abierto (9/11/2026): un período con feriados no parece una caída. */
      crecimientoPorDia: variacion(porDiaAbierto(ahora.venta, abrioAhora) ?? 0, porDiaAbierto(antes.venta, abrioAntes) ?? 0),
      crecimientoAnual: variacion(ahora.venta, anioPasado.venta),
      tickets: variacion(ahora.tickets, antes.tickets),
      ticketPromedio: variacion(tp(ahora), tp(antes)),
      credito: totMedios > 0 ? pct(N(credito?.importe), totMedios) : null,
      margen: mCat.totales.margenPct,
      granel: granel.granel.participacion ?? null,
      descuentos: desc.pctDescuentos,
      bajoCosto: bajo,
      notas: pct(ahora.notas, ahora.tickets),
      cierresDiferencia: pct(caja.conDiferencia, caja.cierres),
    },
    /** El mismo valor en el período anterior (para la flecha), cuando tiene sentido. */
    previos: {
      margen: mCat.anterior.margenPct,
      granel: granel.anterior.pctGranel ?? null,
      notas: pct(antes.notas, antes.tickets),
    },
    detalle: {
      cierres: caja.cierres,
      granelMargen: granel.granel.margenPct,
      enterosMargen: granel.entero.margenPct,
      anioPasadoSinDatos: anioPasado.venta === 0,
      /* Cantidades de días y turnos: ni un peso. */
      actividad: { dias: abrioAhora.dias, abiertos: abrioAhora.abiertos, turnos: abrioAhora.turnos, sinAbrir: abrioAhora.sinAbrir },
      actividadAnterior: { dias: abrioAntes.dias, abiertos: abrioAntes.abiertos, turnos: abrioAntes.turnos },
    },
    sucursales: [...sucs.entries()]
      .map(([id, x]) => ({ id, nombre: x.nombre, pct: x.pct, puntos: puntos(x.pct, sucsAnt.get(id)?.pct ?? null) }))
      .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0)),
    margenSucursales: mSuc.filas.filter((x) => x.ventaNeta > 0).map((x) => ({ id: x.clave, nombre: x.nombre, margenPct: x.margenPct })),
    categorias: mCat.filas.filter((x) => x.ventaNeta > 0).map((x) => ({ id: x.clave, nombre: x.nombre, pct: x.participacion, margenPct: x.margenPct })),
    horas: horas.rows.map((x) => ({ hora: N(x.hora), pct: pct(N(x.tickets), totTickets) })),
    dias: promedios.map((x) => ({ dia: x.dia, pct: totProm > 0 ? r2((x.prom / totProm) * 100) : null })),
    medios: medios.rows.map((x) => ({ medio: x.medio as string, pct: pct(N(x.importe), totMedios) })).sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0)),
  };
}

/** Los tres % de stock, sobre la valorización de Métricas (lo de Coffit no cuenta: ya se le cargó a Coffit). */
export function resumenStock(lista: { valor: number; estado: string; deCoffit: boolean }[]) {
  let valor = 0; let parado = 0; let sobrestock = 0; let articulos = 0; let porAgotarse = 0;
  for (const x of lista) {
    if (x.deCoffit) continue;
    valor += x.valor; articulos += 1;
    if (x.estado === 'parado') parado += x.valor;
    if (x.estado === 'sobrestock') sobrestock += x.valor;
    if (x.estado === 'por_agotarse') porAgotarse += 1;
  }
  return {
    parado: pct(parado, valor),
    sobrestock: pct(sobrestock, valor),
    porAgotarse: pct(porAgotarse, articulos),
    articulos,
  };
}
