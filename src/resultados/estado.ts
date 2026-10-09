/**
 * EL ARMADO DEL ESTADO DE RESULTADOS (0152) — de los hechos a la cascada.
 * ============================================================================
 * Sin base de datos: recibe lo que leyó `datos.ts` y devuelve, por mes y por
 * balde, los hechos con su cascada. Las reglas de cada renglón:
 *
 *   REPARTO. Lo que es de un local va a ese local. Lo que no tiene local se
 *   reparte entre los locales en proporción a sus ventas netas del mes, o
 *   queda en «Administración» si su rubro dice que no se reparte.
 *
 *   ESTIMADO O REAL (Ingresos Brutos, tasa municipal, comisión del posnet).
 *   El sistema estima con la tasa vigente; si en el mes hay cargado un gasto
 *   del rubro marcado como pago real, manda el real:
 *     · Ingresos Brutos es UN impuesto de la empresa: el real (lo pagado más
 *       las percepciones de IIBB sufridas en el mes, que son pago a cuenta)
 *       se reparte por lo facturado de cada local.
 *     · La tasa municipal es de cada local: el real de un local reemplaza solo
 *       su estimado; uno sin local reemplaza todos y se reparte por lo facturado.
 *     · El posnet igual que la municipal, repartido por lo cobrado con tarjeta.
 *       Mercado Pago va siempre con su comisión real (sin IVA: se recupera).
 *
 *   SUELDOS. Si hay empleados cargados para el mes, manda la planilla (sueldo
 *   + cargas + 1/12 de aguinaldo) y lo cargado en el rubro Sueldos no se suma
 *   (serían los pagos: contarlos sería duplicar). Sin empleados, lo cargado.
 *
 *   GANANCIAS (persona humana). Solo la empresa entera, por lo acumulado del
 *   año calendario con la escala de ARCA. La base es el resultado antes de
 *   Ganancias; con «solo lo facturado», la parte proporcional a lo facturado.
 */
import {
  ADMINISTRACION, SIN_LOCAL, amortizacionMes, cascada, costoEmpleadoMes, escalaDelAnio, gananciasDelAnio,
  hechosVacios, r2, repartir, sumarHechos, tasaVigente, type Bien, type Empleado, type Escala, type Hechos, type Tasa,
} from './reglas';

type Fila = Record<string, any>;
export type Rubro = { id: number; nombre: string; tipo: string; resultado: string; reparte: boolean; activa: boolean };
export type HechosLeidos = {
  items: Fila[]; extras: Fila[]; fiscal: Fila[]; tarjetas: Fila[]; mp: Fila[];
  stock: Fila[]; gastos: Fila[]; percIibb: Fila[]; retiros: Fila[];
};
export type Catalogos = {
  rubros: Rubro[]; empleados: Empleado[]; bienes: Bien[]; tasas: Tasa[]; escalas: Escala[];
  config: { amortizaciones: boolean; gananciasBase: 'facturado' | 'todo' };
};
type Origen = 'estimado' | 'real' | 'mixto';

/** La comisión de Mercado Pago viene con IVA; el IVA se recupera (crédito fiscal). */
const IVA_COMISION = 1.21;

const porMes = (filas: Fila[]) => {
  const m = new Map<string, Fila[]>();
  for (const f of filas) { const l = m.get(f.mes) ?? []; l.push(f); m.set(f.mes, l); }
  return m;
};
const sumar = (m: Map<number, number>, k: number, v: number) => m.set(k, r2((m.get(k) ?? 0) + v));

/** El real reemplaza al estimado (ver encabezado). `pesos` reparte lo que no tiene local. */
function conReal(
  estimado: Map<number, number>, porLocal: Map<number, number>, comun: { hay: boolean; importe: number },
  pesos: Map<number, number>,
): { valores: Map<number, number>; origen: Origen } {
  if (!porLocal.size && !comun.hay) return { valores: estimado, origen: 'estimado' };
  const out = new Map<number, number>();
  let quedanEstimados = 0;
  for (const b of new Set([...estimado.keys(), ...porLocal.keys()])) {
    if (porLocal.has(b)) out.set(b, porLocal.get(b)!);
    else if (!comun.hay) {
      const v = estimado.get(b) ?? 0;
      if (Math.abs(v) > 0.004) quedanEstimados++;
      out.set(b, v);
    }
  }
  if (comun.hay) for (const [b, v] of repartir(comun.importe, pesos)) sumar(out, b, v);
  return { valores: out, origen: quedanEstimados ? 'mixto' : 'real' };
}

export function armarEstado(h: HechosLeidos, cat: Catalogos, mesesCalculo: string[], mesesPedidos: Set<string>, foco = '') {
  const rubroDe = new Map(cat.rubros.map((r) => [r.id, r]));
  const rubroSueldos = cat.rubros.find((r) => r.resultado === 'sueldos');
  const idx = {
    items: porMes(h.items), extras: porMes(h.extras), fiscal: porMes(h.fiscal), tarjetas: porMes(h.tarjetas),
    mp: porMes(h.mp), stock: porMes(h.stock), gastos: porMes(h.gastos), percIibb: porMes(h.percIibb), retiros: porMes(h.retiros),
  };

  const meses = mesesCalculo.map((mes) => {
    const baldes = new Map<number, Hechos>();
    const de = (b: number) => { let x = baldes.get(b); if (!x) { x = hechosVacios(); baldes.set(b, x); } return x; };
    const info = {
      sueldosIgnorados: 0, excluidos: {} as Record<string, number>, mpSinDato: 0,
      empleadosSinSueldo: [] as string[], sinTasaMunicipal: [] as number[],
    };

    /* 1 · Ventas, costo y cargos. */
    for (const f of idx.items.get(mes) ?? []) {
      const x = de(f.suc);
      if (f.nota) { x.notasCredito += f.neto; x.cmv -= f.costo; x.ventaSinCosto -= f.venta_sin_costo; }
      else { x.ventasLista += f.lista; x.descuentos += f.lista - f.neto; x.cmv += f.costo; x.ventaSinCosto += f.venta_sin_costo; }
      x.sinCosto += f.sin_costo;
    }
    for (const f of idx.extras.get(mes) ?? []) { const x = de(f.suc); x.cargos += f.cargos; x.recargos += f.recargos; }
    for (const f of idx.fiscal.get(mes) ?? []) { const x = de(f.suc); x.facturado += f.facturado; x.ivaSinFactura += f.iva_sin_factura; }
    for (const f of idx.stock.get(mes) ?? []) { const x = de(f.suc); x.mermas += f.perdidas; x.ajustesStock += f.ajustes; }
    for (const f of idx.retiros.get(mes) ?? []) de(f.suc).retiros += f.costo;

    /* Los pesos del reparto: ventas netas, lo facturado y lo cobrado con tarjeta de cada balde. */
    const pesoVentas = new Map<number, number>();
    const pesoFacturado = new Map<number, number>();
    for (const [b, x] of baldes) {
      if (b === ADMINISTRACION) continue;
      pesoVentas.set(b, x.ventasLista - x.descuentos - x.notasCredito + x.cargos);
      pesoFacturado.set(b, x.facturado);
    }
    const aBalde = (suc: number | null, importe: number, reparte: boolean, poner: (x: Hechos, v: number) => void) => {
      if (suc != null) { poner(de(suc), importe); return; }
      if (!reparte) { poner(de(ADMINISTRACION), importe); return; }
      for (const [b, v] of repartir(importe, pesoVentas)) poner(de(b), v);
    };

    /* 2 · Los gastos del mes, por el papel de su rubro. */
    const real = {
      iibb: { porLocal: new Map<number, number>(), comun: { hay: false, importe: 0 } },
      municipalidad: { porLocal: new Map<number, number>(), comun: { hay: false, importe: 0 } },
      comisiones: { porLocal: new Map<number, number>(), comun: { hay: false, importe: 0 } },
    };
    const sueldosCargados: Fila[] = [];
    for (const g of idx.gastos.get(mes) ?? []) {
      const rubro = rubroDe.get(g.rubro);
      const papel = rubro?.resultado ?? 'normal';
      const clave = String(g.rubro);
      if (papel === 'iibb' || papel === 'municipalidad' || papel === 'comisiones') {
        const r = real[papel];
        if (g.suc == null) { r.comun.hay = true; r.comun.importe = r2(r.comun.importe + g.importe); }
        else sumar(r.porLocal, g.suc, g.importe);
      } else if (papel === 'sueldos') sueldosCargados.push(g);
      else if (papel === 'ganancias' || papel === 'fuera') info.excluidos[clave] = r2((info.excluidos[clave] ?? 0) + g.importe);
      else if (papel === 'financiero') {
        aBalde(g.suc, g.importe, rubro?.reparte ?? true, (x, v) => { x.financieros[clave] = r2((x.financieros[clave] ?? 0) + v); });
      } else {
        const grupo = rubro?.tipo === 'fijo' ? 'fijos' : 'variables';
        aBalde(g.suc, g.importe, rubro?.reparte ?? true, (x, v) => { x[grupo][clave] = r2((x[grupo][clave] ?? 0) + v); });
      }
    }

    /* 3 · Ingresos Brutos: estimado por lo facturado; el real, de la empresa entera. */
    const estIibb = new Map<number, number>();
    for (const [b, base] of pesoFacturado) {
      const t = tasaVigente(cat.tasas, 'iibb', mes, { sucursalId: b > 0 ? b : null });
      if (t && base) estIibb.set(b, r2(base * t.porcentaje / 100));
    }
    const ri = real.iibb;
    const hayIibb = ri.porLocal.size > 0 || ri.comun.hay;
    const percIibb = (idx.percIibb.get(mes) ?? []).reduce((a, f) => a + f.importe, 0);
    const iibb = hayIibb
      ? conReal(estIibb, new Map(), { hay: true, importe: r2(ri.comun.importe + [...ri.porLocal.values()].reduce((a, v) => a + v, 0) + percIibb) }, pesoFacturado)
      : { valores: estIibb, origen: 'estimado' as Origen };
    for (const [b, v] of iibb.valores) de(b).iibb += v;

    /* 4 · Tasa municipal: la de cada local que vendió (con su mínimo); el real de cada local reemplaza el suyo. */
    const estMuni = new Map<number, number>();
    for (const [b, base] of pesoFacturado) {
      if (b <= 0 || !(Math.abs(pesoVentas.get(b) ?? 0) > 0.004)) continue;
      const t = tasaVigente(cat.tasas, 'municipalidad', mes, { sucursalId: b });
      if (!t) { info.sinTasaMunicipal.push(b); continue; }
      estMuni.set(b, r2(Math.max(base * t.porcentaje / 100, t.minimo)));
    }
    const muni = conReal(estMuni, real.municipalidad.porLocal, real.municipalidad.comun, pesoFacturado);
    for (const [b, v] of muni.valores) de(b).municipalidad += v;

    /* 5 · Comisiones: posnet por % de lo cobrado con tarjeta (o el real) + Mercado Pago real. */
    const estPosnet = new Map<number, number>();
    const pesoTarjetas = new Map<number, number>();
    for (const f of idx.tarjetas.get(mes) ?? []) {
      sumar(pesoTarjetas, f.suc, f.importe);
      const t = tasaVigente(cat.tasas, 'tarjeta', mes, { medio: f.medio });
      if (t) sumar(estPosnet, f.suc, r2(f.importe * t.porcentaje / 100));
    }
    const posnet = conReal(estPosnet, real.comisiones.porLocal, real.comisiones.comun, pesoTarjetas);
    for (const [b, v] of posnet.valores) de(b).comisiones += v;
    for (const f of idx.mp.get(mes) ?? []) {
      const neto = r2(f.comision / IVA_COMISION);
      const x = de(f.suc);
      x.comisiones += neto; x.comisionesMp += neto;
      info.mpSinDato += f.sin_dato;
    }

    /* 6 · Sueldos: la planilla, o lo cargado en el rubro si no hay planilla. */
    const costos = cat.empleados
      .map((e) => ({ e, c: costoEmpleadoMes(e, mes) }))
      .filter((x): x is { e: Empleado; c: NonNullable<ReturnType<typeof costoEmpleadoMes>> } => x.c != null);
    const origenSueldos: 'empleados' | 'gastos' | 'nada' = costos.length ? 'empleados' : sueldosCargados.length ? 'gastos' : 'nada';
    if (costos.length) {
      for (const { e, c } of costos) {
        if (c.sinSueldo) info.empleadosSinSueldo.push(e.nombre);
        aBalde(e.sucursalId, c.total, rubroSueldos?.reparte ?? true, (x, v) => { x.sueldos += v; });
      }
      info.sueldosIgnorados = r2(sueldosCargados.reduce((a, g) => a + g.importe, 0));
    } else {
      for (const g of sueldosCargados) aBalde(g.suc, g.importe, rubroDe.get(g.rubro)?.reparte ?? true, (x, v) => { x.sueldos += v; });
    }

    /* 7 · Amortizaciones (si están encendidas): las sin local se reparten por ventas. */
    if (cat.config.amortizaciones) {
      for (const b of cat.bienes) {
        const v = amortizacionMes(b, mes);
        if (v) aBalde(b.sucursalId, v, true, (x, val) => { x.amortizaciones += val; });
      }
    }

    /* Redondeo final de cada balde y su cascada. */
    let total = hechosVacios();
    const lista = [...baldes].map(([balde, x]) => {
      for (const k of Object.keys(x) as (keyof Hechos)[]) if (typeof x[k] === 'number') (x as any)[k] = r2(x[k] as number);
      total = sumarHechos(total, x);
      return { balde, hechos: x, cascada: cascada(x) };
    }).sort((a, b) => a.balde - b.balde);

    return {
      mes, baldes: lista, total: { hechos: total, cascada: cascada(total) },
      origen: { iibb: iibb.origen, municipalidad: muni.origen, comisiones: posnet.origen, sueldos: origenSueldos },
      percepcionesIibb: r2(percIibb), info,
    };
  });

  /* 8 · Ganancias, año por año, por lo acumulado. */
  const avisosGanancias: string[] = [];
  const ganancias = new Map<string, ReturnType<typeof gananciasDelAnio>[number] & { factor: number; escalaAnio: number | null }>();
  const anios = [...new Set(meses.map((m) => Number(m.mes.slice(0, 4))))];
  for (const anio of anios) {
    const delAnio = meses.filter((m) => m.mes.startsWith(`${anio}-`));
    const factores = delAnio.map((m) => {
      if (cat.config.gananciasBase === 'todo') return 1;
      const vn = m.total.cascada.ventasNetas;
      return vn > 0 ? Math.min(1, Math.max(0, m.total.hechos.facturado / vn)) : 1;
    });
    const esc = escalaDelAnio(cat.escalas, anio);
    if (!esc) { avisosGanancias.push(`No hay escala de Ganancias cargada: el impuesto no se estima (cargala en Configuración).`); continue; }
    /* Solo se avisa si la escala prestada se USA: un mes mirado con base positiva. */
    const usada = delAnio.some((m, i) => mesesPedidos.has(m.mes) && m.mes >= foco && m.total.cascada.antesGanancias * factores[i] > 0);
    if (!esc.propia && usada) {
      avisosGanancias.push(`No está cargada la escala de Ganancias de ${anio}: se usa la de ${esc.escala.anio}. Cargá la nueva en Configuración apenas la publique ARCA.`);
    }
    const calc = gananciasDelAnio(esc.escala, delAnio.map((m, i) => m.total.cascada.antesGanancias * factores[i]));
    delAnio.forEach((m, i) => ganancias.set(m.mes, { ...calc[i], factor: r2(factores[i] * 100) / 100, escalaAnio: esc.escala.anio }));
  }

  return {
    meses: meses.filter((m) => mesesPedidos.has(m.mes)).map((m) => {
      const g = ganancias.get(m.mes) ?? null;
      return { ...m, ganancias: g, neto: r2(m.total.cascada.antesGanancias - (g?.impuesto ?? 0)) };
    }),
    avisosGanancias: [...new Set(avisosGanancias)],
  };
}

export { ADMINISTRACION, SIN_LOCAL };
