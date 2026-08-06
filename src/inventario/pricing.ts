/**
 * PRECIOS — el único lugar donde se derivan (puro, sin DB).
 * ============================================================================
 *   costoNeto = costo × (1 − desc%) × (1 + flete%)
 *   neto      = costoNeto × (1 + markup% de la lista)          ← lista
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
/**
 * FORMATO DE COMPRA — cómo entra el producto.
 *
 * Todos los importes son del BULTO entero, no de la unidad: es como los factura
 * el proveedor. Lo unitario se deriva dividiendo por `cantidad`.
 */
export interface CostoEntry {
  /** Unidades por bulto. "Caja x12" → 12. */
  cantidad?: number;
  /** Costo de lista del bulto, sin descuentos ni flete. */
  costo: number;
  /** Escala de descuentos, EN CASCADA (30 y 10 = 37%, no 40%). */
  descuento: number;
  descuento2?: number;
  descuento3?: number;
  descuento4?: number;
  flete: number;
  /** 'final' ignora descuentos y flete: el costo se carga ya cerrado y con IVA. */
  modoCosto?: 'lista' | 'final';
  costoFinal?: number;
  usarParaPrecio?: boolean;
}

/** La cadena completa, tal como se muestra en la pantalla del formato. */
export interface CostosFormato {
  cantidad: number;
  costoLista: number;
  costoListaUnitario: number;
  /** El de la cascada, en %. Es el número que nadie calcula bien de cabeza. */
  descuentoEfectivo: number;
  costoBruto: number;
  costoNeto: number;
  costoFinal: number;
  /** El que alimenta el precio de venta. */
  costoNetoUnitario: number;
  costoFinalUnitario: number;
}

/**
 * Descuento efectivo de una escala en cascada, en %.
 *
 * Cada uno se aplica sobre lo que quedó del anterior: "30 y 10" es
 * `1 − 0,70 × 0,90 = 37%`, no 40%. Sumarlos es el error caro y silencioso que
 * este cálculo existe para evitar.
 */
export function descuentoEfectivo(e?: CostoEntry | null): number {
  if (!e) return 0;
  const escala = [e.descuento, e.descuento2, e.descuento3, e.descuento4];
  const factor = escala.reduce<number>((acc, d) => acc * (1 - (Number(d) || 0) / 100), 1);
  return (1 - factor) * 100;
}

/**
 * Deriva la cadena entera de un formato de compra.
 *
 *   lista → descuentos en cascada → flete → NETO → IVA → final
 *
 * En modo 'final' se entra por el otro extremo: se carga el costo con IVA tal
 * como lo factura el proveedor y el neto se deriva hacia atrás. Los descuentos
 * y el flete quedan fuera del cálculo (ya están dentro de ese número).
 *
 * El **costo neto unitario** es el único que alimenta el precio de venta. El
 * final es informativo: sirve para conciliar contra la factura, y usarlo para
 * calcular el precio contaría el IVA dos veces.
 */
export function costosFormato(e?: CostoEntry | null, iva = 0): CostosFormato {
  const vacio: CostosFormato = {
    cantidad: 1, costoLista: 0, costoListaUnitario: 0, descuentoEfectivo: 0,
    costoBruto: 0, costoNeto: 0, costoFinal: 0, costoNetoUnitario: 0, costoFinalUnitario: 0,
  };
  if (!e) return vacio;

  // Una cantidad en 0 dividiría por cero y dejaría precios en Infinity.
  const cantidad = Math.max(Number(e.cantidad) || 1, 1e-9);
  const factorIva = 1 + (Number(iva) || 0) / 100;

  if (e.modoCosto === 'final') {
    const costoFinal = Number(e.costoFinal) || 0;
    const costoNeto = costoFinal / factorIva;
    return {
      cantidad,
      costoLista: 0,
      costoListaUnitario: 0,
      descuentoEfectivo: 0,
      costoBruto: costoNeto,
      costoNeto,
      costoFinal,
      costoNetoUnitario: costoNeto / cantidad,
      costoFinalUnitario: costoFinal / cantidad,
    };
  }

  const costoLista = Number(e.costo) || 0;
  const desc = descuentoEfectivo(e);
  const costoBruto = costoLista * (1 - desc / 100);
  const costoNeto = costoBruto * (1 + (Number(e.flete) || 0) / 100);
  const costoFinal = costoNeto * factorIva;
  return {
    cantidad,
    costoLista,
    costoListaUnitario: costoLista / cantidad,
    descuentoEfectivo: desc,
    costoBruto,
    costoNeto,
    costoFinal,
    costoNetoUnitario: costoNeto / cantidad,
    costoFinalUnitario: costoFinal / cantidad,
  };
}

/**
 * El formato que define el precio. UNA sola definición para todo el sistema:
 * antes cada lugar repetía "el del proveedor activo, si no el primero" y
 * alcanzaba con que uno quedara desalineado para que el precio del POS no
 * coincidiera con el de la ficha.
 */
export function formatoActivo<T extends { usarParaPrecio?: boolean }>(entries: T[]): T | null {
  if (!entries || !entries.length) return null;
  return entries.find((e) => e.usarParaPrecio) ?? entries[0];
}

/* ------------------------------------------------------------------ *
 * Formato de venta: la fila producto×lista hecha precio
 * ------------------------------------------------------------------ */

/** Fila de `producto_listas` (lo que el precio necesita de ella). */
export interface FilaVenta {
  /** En cuántas unidades se vende: 1 = suelto, 12 = caja de 12. */
  unidades?: number;
  modoPrecio?: 'markup' | 'precio';
  markup?: number;
  /** Precio FINAL (con IVA) del FORMATO completo, en modo 'precio'. */
  precioFijo?: number;
}

export interface PrecioVenta {
  unidades: number;
  /** Neto por UNIDAD: es la moneda del ticket (el POS trabaja en neto unitario). */
  netoUnitario: number;
  /** Lo que ve el cliente por una unidad. */
  finalUnitario: number;
  /** Lo que ve el cliente por el formato entero (la caja). */
  finalFormato: number;
}

/**
 * Deriva el precio de un formato de venta. Los DOS modos convergen en el mismo
 * resultado —neto unitario + finales— para que el resto del sistema no tenga
 * que saber cómo se definió:
 *
 *   markup  el precio ACOMPAÑA al costo: neto = costo × (1+markup), con
 *           redondeo de góndola sobre el final de la unidad. El formato es
 *           unidad × N (la caja vale exactamente N veces la unidad).
 *   precio  el número es LA VOLUNTAD del que lo fijó: el final del FORMATO es
 *           exacto, sin redondeo de góndola (fijar $10.000 y que el sistema
 *           muestre $10.001 sería pisarle la decisión). La unidad se deriva
 *           dividiendo — puede dar centavos, y está bien: es informativa.
 */
export function precioVentaFila(costoNetoUnitario: number, fila: FilaVenta, opts?: OpcionesPrecio): PrecioVenta {
  const unidades = Math.max(Number(fila?.unidades) || 1, 1e-9);
  const iva = Number(opts?.iva) || 0;

  if (fila?.modoPrecio === 'precio') {
    const finalFormato = money(Number(fila.precioFijo) || 0);
    const finalUnitario = money(finalFormato / unidades);
    return {
      unidades,
      netoUnitario: money(finalFormato / (1 + iva / 100) / unidades),
      finalUnitario,
      finalFormato,
    };
  }

  const netoUnitario = precioLista(costoNetoUnitario, Number(fila?.markup) || 0, opts);
  const finalUnitario = precioFinal(netoUnitario, iva, opts?.redondeo ?? 0);
  return {
    unidades,
    netoUnitario,
    finalUnitario,
    finalFormato: money(finalUnitario * unidades),
  };
}

/** Opciones de redondeo. Sin `redondeo`, el comportamiento es el de siempre. */
export interface OpcionesPrecio {
  /** Alícuota de IVA del producto (21, 10.5, 0…). */
  iva?: number;
  /** 0 = sin redondeo; 1 = al entero; 10/50/100 = a esa unidad. */
  redondeo?: number;
}

const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * El costo con el que se calcula el precio de venta: **neto y unitario**.
 *
 * Neto porque el markup se aplica sobre el neto y el IVA se suma al final;
 * unitario porque el precio es por unidad aunque se compre por caja.
 */
export function costoNetoEntry(e?: CostoEntry | null, iva = 0): number {
  return costosFormato(e, iva).costoNetoUnitario;
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
export function precioLista(costoNetoKg: number, markup: number, opts?: OpcionesPrecio): number {
  const neto = (Number(costoNetoKg) || 0) * (1 + (Number(markup) || 0) / 100);
  return ajustarNeto(neto, opts);
}

/**
 * Precio NETO de una presentación fraccionada. `markupLista` es el markup de
 * la lista con la que se cotiza; la presentación solo aporta su `recargo`.
 */
export function precioPresentacion(
  costoNetoKg: number,
  pres: { tamKg: number; recargo: number },
  markupLista = 0,
  opts?: OpcionesPrecio,
): number {
  const porKg = (Number(costoNetoKg) || 0) * (1 + (Number(markupLista) || 0) / 100);
  const neto = porKg * (Number(pres.tamKg) || 0) * (1 + (Number(pres.recargo) || 0) / 100);
  return ajustarNeto(neto, opts);
}
