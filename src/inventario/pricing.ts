/**
 * PRECIOS — el único lugar donde se derivan (puro, sin DB).
 * ============================================================================
 *   costoNeto = costo × (1 − desc%) × (1 + flete%)
 *   neto      = costoNeto × (1 + ganancia% de la lista)          ← lista
 *   neto      = … × tamKg × (1 + recargo%)                       ← presentación
 *   final     = neto × (1 + IVA%)      ← lo que ve el cliente en góndola
 *
 * La presentación parte del precio por kg **de la lista** y recién después
 * aplica el recargo de fraccionamiento (envase + mano de obra). Antes usaba un
 * margen propio y quedaba fuera de las listas: un mayorista pagaba la bolsa de
 * 1 kg al mismo precio que un minorista.
 *
 * REDONDEO DE GÓNDOLA
 * -------------------
 * Se aplica sobre el precio **final con IVA**, no sobre el neto: redondear el
 * neto deja la góndola con centavos igual ($1.455 neto → $1.760,55). Entonces
 * se redondea el final y el neto se deriva hacia atrás.
 *
 * Como todo el sistema trabaja en NETO (misma convención que las compras),
 * `precioLista` devuelve el neto ya ajustado y `precioFinal` reconstruye la
 * etiqueta. La operación es idempotente — `precioFinal(precioLista(x))` da
 * siempre el mismo número redondo — así la etiqueta y el ticket no discrepan.
 *
 * El redondeo entra por parámetro (no lee configuración) para que este módulo
 * siga siendo puro y testeable sin montar nada.
 */
export interface CostoEntry {
  costo: number;
  descuento: number;
  flete: number;
}

/** Opciones de redondeo. Sin `redondeo`, el comportamiento es el de siempre. */
export interface OpcionesPrecio {
  /** Alícuota de IVA del producto (21, 10.5, 0…). */
  iva?: number;
  /** 0 = sin redondeo; 1 = al entero; 10/50/100 = a esa unidad. */
  redondeo?: number;
}

const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export function costoNetoEntry(e?: CostoEntry | null): number {
  if (!e) return 0;
  const c = Number(e.costo) || 0;
  const d = Number(e.descuento) || 0;
  const f = Number(e.flete) || 0;
  return c * (1 - d / 100) * (1 + f / 100);
}

/** Redondea a la unidad pedida. `redondeo <= 0` deja el valor a 2 decimales. */
export function redondearPrecio(valor: number, redondeo = 0): number {
  const v = Number(valor) || 0;
  const r = Number(redondeo) || 0;
  if (r <= 0) return money(v);
  return Math.round(v / r) * r;
}

/**
 * Precio final con IVA, ya redondeado: el número de la etiqueta. Aplicado
 * sobre un neto que salió de `precioLista`, devuelve exactamente el valor con
 * el que se derivó.
 */
export function precioFinal(neto: number, iva = 0, redondeo = 0): number {
  return redondearPrecio((Number(neto) || 0) * (1 + (Number(iva) || 0) / 100), redondeo);
}

/**
 * Ajusta un neto teórico para que su precio final caiga en la unidad de
 * redondeo configurada. Sin redondeo, solo normaliza a 2 decimales.
 */
function ajustarNeto(neto: number, opts?: OpcionesPrecio): number {
  const redondeo = Number(opts?.redondeo) || 0;
  if (redondeo <= 0) return money(neto);
  const iva = Number(opts?.iva) || 0;
  const final = redondearPrecio(neto * (1 + iva / 100), redondeo);
  return money(final / (1 + iva / 100));
}

/** Precio NETO de venta de una lista, ajustado al redondeo de góndola. */
export function precioLista(costoNetoKg: number, ganancia: number, opts?: OpcionesPrecio): number {
  const neto = (Number(costoNetoKg) || 0) * (1 + (Number(ganancia) || 0) / 100);
  return ajustarNeto(neto, opts);
}

/**
 * Precio NETO de una presentación fraccionada. `gananciaLista` es el margen de
 * la lista con la que se cotiza; la presentación solo aporta su `recargo`.
 */
export function precioPresentacion(
  costoNetoKg: number,
  pres: { tamKg: number; recargo: number },
  gananciaLista = 0,
  opts?: OpcionesPrecio,
): number {
  const porKg = (Number(costoNetoKg) || 0) * (1 + (Number(gananciaLista) || 0) / 100);
  const neto = porKg * (Number(pres.tamKg) || 0) * (1 + (Number(pres.recargo) || 0) / 100);
  return ajustarNeto(neto, opts);
}
