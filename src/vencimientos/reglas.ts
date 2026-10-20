/**
 * LAS REGLAS DE OFERTA POR RANGO DE VENCIMIENTO (0188, 20/10/2026, pedido del
 * dueño): cada rango tiene una regla fija —sin oferta, % de descuento, costo +
 * % o llevá N pagá M— y el sistema arma, escala y mide la oferta de cada
 * registro solo. Acá vive LA CUENTA, sin base de datos: qué oferta sale de una
 * regla y cuánto se gana con ella en cada lista. La usan el reloj que escala,
 * el borrador del formulario y la pantalla de rentabilidad: una sola cuenta.
 *
 * LA PLATA SE MIDE COMO EN MÉTRICAS: ganancia = neto de la venta − costo REAL
 * (el que congela la venta en `venta_items.costo_unitario`). Por eso:
 *   · el PISO es el costo real: el neto nunca queda por debajo, o sea el final
 *     nunca baja de costo × (1 + IVA). Ojo: NO es «markup 0 sobre la base del
 *     precio» —con parte sin factura esa base no lleva el IVA que se absorbe,
 *     y vender a ese precio pierde justo ese IVA—;
 *   · «costo + 5 %» es ganar el 5 % sobre ese costo real.
 *
 * UN PRECIO PARA TODOS EN «%» Y «COSTO + %»: la oferta es de precio fijo. Un
 * % sobre CADA lista bajaría además el precio mayorista —que ya es bajo— y lo
 * dejaría debajo del costo; con un precio fijo el producto sale a lo mismo en
 * el mostrador y por mayor, y corre en cada lista donde ese precio es una baja.
 * El % se calcula sobre la lista base (la del mostrador). En «llevá N pagá M»
 * cada lista mantiene su precio y la promo corre donde no queda bajo el costo.
 */

/** Los rangos con regla, con las claves del panel (`rangoVenc`). Lo vencido nunca se ofrece. */
export const RANGOS_REGLA = ['vigente', 'd30', 'd15', 'd7'] as const;
export type RangoRegla = (typeof RANGOS_REGLA)[number];
export const MECANICAS = ['ninguna', 'descuento', 'costo', 'nxm'] as const;
export type Mecanica = (typeof MECANICAS)[number];

export interface Regla {
  rango: RangoRegla;
  mecanica: Mecanica;
  /** % de descuento (descuento) o % de ganancia sobre el costo real (costo). */
  valor: number;
  /** Solo nxm. */
  lleva: number;
  paga: number;
}

/** Lo que manda el dueño de entrada (y lo que siembra la 0188). */
export const REGLAS_DE_FABRICA: Regla[] = [
  { rango: 'vigente', mecanica: 'ninguna', valor: 0, lleva: 0, paga: 0 },
  { rango: 'd30', mecanica: 'descuento', valor: 25, lleva: 0, paga: 0 },
  { rango: 'd15', mecanica: 'descuento', valor: 40, lleva: 0, paga: 0 },
  { rango: 'd7', mecanica: 'costo', valor: 5, lleva: 0, paga: 0 },
];

/** El rango de un registro según los días que le quedan: mismos cortes que el panel. */
export function rangoDe(dias: number): RangoRegla | 'vencido' {
  if (dias < 0) return 'vencido';
  if (dias <= 7) return 'd7';
  if (dias <= 15) return 'd15';
  if (dias <= 30) return 'd30';
  return 'vigente';
}

/** Una regla válida o el motivo por el que no lo es. */
export function errorDeRegla(r: Regla): string | null {
  if (!RANGOS_REGLA.includes(r.rango)) return 'Rango inválido.';
  if (!MECANICAS.includes(r.mecanica)) return 'Mecánica inválida.';
  const v = Number(r.valor);
  if (r.mecanica === 'descuento' && !(v > 0 && v < 100)) return 'El descuento va entre 1 y 99 %.';
  if (r.mecanica === 'costo' && !(v >= 0 && v <= 300)) return 'La ganancia sobre el costo va de 0 a 300 %.';
  if (r.mecanica === 'nxm') {
    const n = Number(r.lleva); const m = Number(r.paga);
    if (!(Number.isInteger(n) && Number.isInteger(m) && m >= 1 && n > m && n <= 20)) return 'En «llevá N pagá M», N y M son enteros con N mayor que M (por ejemplo 3 y 2).';
  }
  return null;
}

/** El artículo que vence (producto suelto o paquete) con lo que hace falta para cotizarlo. */
export interface Articulo {
  iva: number;
  /** Redondeo de góndola del producto (0 = al centavo). */
  redondeo: number;
  /** Costo REAL unitario de hoy (neto): el que la venta va a congelar. */
  costoReal: number;
  /** Lista base (mostrador): de ahí sale el % de descuento. */
  listaBaseId: number | null;
  /** Precio FINAL unitario de cada lista activa donde el artículo tiene formato. */
  listas: { listaId: number; nombre: string; precio: number }[];
}

export interface Rentabilidad {
  listaId: number;
  nombre: string;
  /** Precio final de lista, por unidad. */
  precioLista: number;
  /** Precio final por unidad con la oferta (en nxm, lo que sale cada una llevando el lote). */
  precioOferta: number;
  /** Ganancia por unidad: neto − costo real. */
  ganancia: number;
  /** Ganancia sobre el costo real, en %. */
  sobreCosto: number;
  /** La oferta corre en esta lista. Si no, `motivo`. */
  aplica: boolean;
  motivo: string;
}

export type Propuesta =
  | { hay: false; motivo: string; porLista: Rentabilidad[] }
  | {
    hay: true;
    tipo: 'precio_fijo' | 'nxm';
    /** precio_fijo: el precio final por unidad. */
    precio: number;
    lleva: number;
    paga: number;
    /** Ids de las listas donde corre (CSV del motor de ofertas). */
    listas: number[];
    /** El % o el «costo + %» pedía menos que el costo: quedó en el costo. */
    topeAlCosto: boolean;
    porLista: Rentabilidad[];
  };

const c2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const pct1 = (n: number) => Math.round((Number(n) || 0) * 10) / 10;
/** Redondeo de góndola (mismo criterio que `redondearPrecio`: nunca a cero). */
function redondear(v: number, r: number) {
  if (!(r > 0)) return c2(v);
  const x = Math.round(v / r) * r;
  return x > 0 ? x : c2(v);
}
/** Hacia arriba: el piso nunca puede quedar debajo por redondear. */
function redondearArriba(v: number, r: number) {
  if (!(r > 0)) return Math.ceil(v * 100 - 1e-6) / 100;
  return Math.ceil(v / r - 1e-9) * r;
}

/** El final que deja el neto JUSTO en el costo real. */
export const pisoFinal = (a: Articulo) => a.costoReal * (1 + (Number(a.iva) || 0) / 100);

function rentabilidad(a: Articulo, l: Articulo['listas'][number], precioOferta: number, aplica: boolean, motivo = ''): Rentabilidad {
  const neto = precioOferta / (1 + (Number(a.iva) || 0) / 100);
  const ganancia = neto - a.costoReal;
  return {
    listaId: l.listaId,
    nombre: l.nombre,
    precioLista: c2(l.precio),
    precioOferta: c2(precioOferta),
    ganancia: c2(ganancia),
    sobreCosto: a.costoReal > 0 ? pct1((ganancia / a.costoReal) * 100) : 0,
    aplica,
    motivo,
  };
}

/** La oferta que sale de la regla para el artículo, con la rentabilidad en cada lista. */
export function proponer(regla: Regla, a: Articulo): Propuesta {
  if (regla.mecanica === 'ninguna') return { hay: false, motivo: 'Este rango no lleva oferta.', porLista: [] };
  if (!a.listas.length) return { hay: false, motivo: 'No tiene precio en ninguna lista.', porLista: [] };
  /* Sin costo no hay piso que cuidar ni ganancia que medir: no se arma a ciegas. */
  if (!(a.costoReal > 0)) return { hay: false, motivo: 'No tiene costo cargado: sin eso no se puede asegurar que no se venda a pérdida.', porLista: [] };
  const piso = pisoFinal(a);

  if (regla.mecanica === 'nxm') {
    const n = regla.lleva; const m = regla.paga;
    const porLista = a.listas.map((l) => {
      const cadaUna = (l.precio * m) / n;
      return cadaUna + 0.005 >= piso
        ? rentabilidad(a, l, cadaUna, true)
        : rentabilidad(a, l, cadaUna, false, `Llevando ${n} y pagando ${m}, cada una queda debajo del costo.`);
    });
    const listas = porLista.filter((x) => x.aplica).map((x) => x.listaId);
    return listas.length
      ? { hay: true, tipo: 'nxm', precio: 0, lleva: n, paga: m, listas, topeAlCosto: false, porLista }
      : { hay: false, motivo: `Con ${n}×${m} queda debajo del costo en todas las listas.`, porLista };
  }

  const base = a.listas.find((l) => l.listaId === a.listaBaseId) ?? [...a.listas].sort((x, y) => y.precio - x.precio)[0];
  const pedido = regla.mecanica === 'descuento'
    ? base.precio * (1 - regla.valor / 100)
    : a.costoReal * (1 + regla.valor / 100) * (1 + (Number(a.iva) || 0) / 100);
  const pisoRedondeado = redondearArriba(piso, a.redondeo);
  const precio = Math.max(redondear(pedido, a.redondeo), pisoRedondeado);
  const topeAlCosto = redondear(pedido, a.redondeo) < pisoRedondeado;
  const porLista = a.listas.map((l) => (
    precio < l.precio - 0.005
      ? rentabilidad(a, l, precio, true)
      : rentabilidad(a, l, l.precio, false, 'Su precio de lista ya es igual o menor: la oferta no le baja nada.')
  ));
  const listas = porLista.filter((x) => x.aplica).map((x) => x.listaId);
  return listas.length
    ? { hay: true, tipo: 'precio_fijo', precio: c2(precio), lleva: 0, paga: 0, listas, topeAlCosto, porLista }
    : { hay: false, motivo: 'El precio de oferta no es más bajo que ninguna lista: ya está al costo o debajo.', porLista };
}

/** La oferta tal como está puesta (manual o automática): lo que necesita la cuenta. */
export interface OfertaPuesta {
  tipo: string;
  porcentaje: number;
  precio: number;
  lleva: number;
  paga: number;
  /** CSV de listas; vacío = todas. */
  listas: string;
}

/**
 * Lo que deja la oferta PUESTA en cada lista, por unidad, con las mismas
 * cuentas que el motor de la caja (`techoOferta`): una manual puede estar
 * debajo del costo y eso se tiene que ver. Por cantidad, el precio es lo que
 * sale cada una llevando lo que pide la promo. El combo y la de ticket no
 * tienen un precio por unidad de este artículo: `null`.
 */
export function rentabilidadDeOferta(o: OfertaPuesta, a: Articulo): Rentabilidad[] | null {
  if (!(a.costoReal > 0)) return null;
  const pct = (Number(o.porcentaje) || 0) / 100;
  const n = Number(o.lleva) || 0;
  const m = Number(o.paga) || 0;
  const precio = (p: number): number | null => {
    switch (o.tipo) {
      case 'porcentaje': return p * (1 - pct);
      case 'segunda_unidad': return p * (1 - pct / 2);
      case 'nxm': return n >= 2 && m >= 1 && m < n ? (p * m) / n : p;
      case 'precio_fijo': return Math.min(Number(o.precio) || 0, p);
      case 'pack': return n >= 2 ? Math.min((Number(o.precio) || 0) / n, p) : p;
      default: return null;
    }
  };
  if (precio(1) === null) return null;
  const ids = String(o.listas || '').split(',').map(Number).filter(Boolean);
  return a.listas.map((l) => {
    if (ids.length && !ids.includes(l.listaId)) return rentabilidad(a, l, l.precio, false, 'La oferta no corre en esta lista.');
    const x = precio(l.precio)!;
    return x < l.precio - 0.005
      ? rentabilidad(a, l, x, true)
      : rentabilidad(a, l, l.precio, false, 'La oferta no le baja nada a este precio.');
  });
}

/** «−25 %», «Costo + 5 %», «3×2», «Sin oferta»: cómo se lee la regla. */
export function describirRegla(r: Pick<Regla, 'mecanica' | 'valor' | 'lleva' | 'paga'>): string {
  switch (r.mecanica) {
    case 'descuento': return `−${r.valor} %`;
    case 'costo': return r.valor > 0 ? `Costo + ${r.valor} %` : 'Al costo';
    case 'nxm': return `${r.lleva}×${r.paga}`;
    default: return 'Sin oferta';
  }
}
