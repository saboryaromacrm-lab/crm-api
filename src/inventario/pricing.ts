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
  /**
   * Qué parte de la mercadería viene SIN FACTURA (0–100). 0 = todo facturado,
   * 100 = liquidación pura, 50 = mitad y mitad. Ver `costosFormato`: separa el
   * costo real del que alimenta el precio.
   */
  porcSinFactura?: number;
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
  /**
   * EL COSTO ECONÓMICO REAL del bulto: lo que la mercadería cuesta de verdad
   * (el IVA facturado no cuenta, se recupera como crédito; la parte sin factura
   * cuenta entera, no hay nada que recuperar). Es el que valúa stock, pérdidas
   * y transferencias — y con `porcSinFactura: 0` coincide con el de siempre.
   */
  costoNeto: number;
  costoFinal: number;
  costoNetoUnitario: number;
  costoFinalUnitario: number;

  /* ---- Mercadería sin factura (0072) ---- */
  /** Qué parte del valor de la mercadería viene sin factura (0–100). */
  porcSinFactura: number;
  /**
   * LA BASE DEL PRECIO DE VENTA. A la parte sin factura se le "descuenta" el
   * IVA que la venta va a generar (÷ 1,21), porque ese IVA no se traslada al
   * cliente: lo absorbe el negocio. Es el 17,36% del sistema viejo, calculado
   * en vez de tipeado — y vale para cualquier alícuota, no solo el 21.
   *
   * La prueba de que la cuenta es la del negocio: `costoPrecio × (1+IVA)` da
   * exactamente el desembolso — comprar a $100 en negro y vender "sin IVA"
   * al costo devuelve los $100 clavados.
   */
  costoPrecio: number;
  costoPrecioUnitario: number;
  /**
   * El IVA que el negocio ABSORBE al vender este bulto: la diferencia entre el
   * costo real y la base del precio. No desaparece — se paga a ARCA como
   * débito sin crédito que lo compense. Es EL dato de las métricas.
   */
  ivaAbsorbido: number;
  ivaAbsorbidoUnitario: number;
  /**
   * Lo que se le PAGA al proveedor por el bulto: la parte facturada con su IVA
   * (que después se recupera) + la parte sin factura tal cual. Con 0% coincide
   * con el costo final de siempre.
   */
  desembolso: number;
  desembolsoUnitario: number;
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
 * En modo 'final' se entra por el otro extremo: se carga lo que se PAGA tal
 * como lo cobra el proveedor y el neto se deriva hacia atrás. Los descuentos
 * y el flete quedan fuera del cálculo (ya están dentro de ese número).
 *
 * MERCADERÍA SIN FACTURA (`porcSinFactura`, 0072). Con una parte comprada en
 * liquidación el costo se PARTE EN DOS, porque hay dos preguntas distintas:
 *
 *   costoNeto    ¿cuánto cuesta de verdad? La parte facturada en neto (su IVA
 *                se recupera como crédito) + la parte sin factura entera (no
 *                hay nada que recuperar). Valúa stock, pérdidas y envíos.
 *   costoPrecio  ¿sobre qué se calcula el markup? A la parte sin factura se le
 *                quita el IVA que la venta va a generar (÷ factor), porque ese
 *                IVA lo absorbe el negocio y no se le traslada al cliente. Es
 *                el "descuento del 17,36%" del sistema viejo, hecho cuenta.
 *
 * La diferencia entre los dos es `ivaAbsorbido`: plata que sale del margen al
 * vender. Con `porcSinFactura: 0` las dos columnas coinciden y todo queda
 * exactamente como siempre.
 */
export function costosFormato(e?: CostoEntry | null, iva = 0): CostosFormato {
  const vacio: CostosFormato = {
    cantidad: 1, costoLista: 0, costoListaUnitario: 0, descuentoEfectivo: 0,
    costoBruto: 0, costoNeto: 0, costoFinal: 0, costoNetoUnitario: 0, costoFinalUnitario: 0,
    porcSinFactura: 0, costoPrecio: 0, costoPrecioUnitario: 0,
    ivaAbsorbido: 0, ivaAbsorbidoUnitario: 0, desembolso: 0, desembolsoUnitario: 0,
  };
  if (!e) return vacio;

  // Una cantidad en 0 dividiría por cero y dejaría precios en Infinity.
  const cantidad = Math.max(Number(e.cantidad) || 1, 1e-9);
  const factorIva = 1 + (Number(iva) || 0) / 100;
  /** Fracción sin factura (0–1), acotada: fuera de 0–100 no significa nada. */
  const q = Math.min(Math.max(Number(e.porcSinFactura) || 0, 0), 100) / 100;

  /**
   * Con el costo real X en la mano, el resto es una sola cuenta:
   *   base del precio = X·(1−q) + X·q/factor   ← la parte negra, sin su IVA
   *   IVA absorbido   = X − base               ← lo que el margen pierde
   *   desembolso      = X·(1−q)·factor + X·q   ← lo que se le paga
   * y vale la identidad `base × factor = desembolso`: comprar en negro y
   * vender "sin IVA" al costo devuelve el mismo peso que salió.
   */
  const partir = (costoNeto: number) => {
    const costoPrecio = costoNeto * ((1 - q) + q / factorIva);
    const desembolso = costoNeto * ((1 - q) * factorIva + q);
    return {
      porcSinFactura: q * 100,
      costoPrecio,
      costoPrecioUnitario: costoPrecio / cantidad,
      ivaAbsorbido: costoNeto - costoPrecio,
      ivaAbsorbidoUnitario: (costoNeto - costoPrecio) / cantidad,
      desembolso,
      desembolsoUnitario: desembolso / cantidad,
    };
  };

  if (e.modoCosto === 'final') {
    /*
     * Lo cargado es el DESEMBOLSO del bulto (lo que se paga, papeles sumados).
     * El costo real se deriva hacia atrás: solo la parte facturada trae IVA
     * adentro. Con q=0 es el ÷1,21 de siempre; con q=100 no hay IVA que sacar.
     */
    const costoFinal = Number(e.costoFinal) || 0;
    const costoNeto = costoFinal / ((1 - q) * factorIva + q);
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
      ...partir(costoNeto),
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
    ...partir(costoNeto),
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
 * El COSTO REAL unitario: lo que la mercadería cuesta de verdad. Es el que
 * valúa stock, pérdidas, transferencias y envíos a costo — todo lo que mide
 * plata que ya se gastó.
 *
 * NO es la base del precio de venta: eso es `costoPrecioEntry`. Con mercadería
 * 100% facturada los dos coinciden; con parte sin factura difieren, y usar el
 * equivocado o infla el precio (trasladarle al cliente un IVA que no se pagó)
 * o achica la pérdida (valuar a menos de lo que se pagó).
 */
export function costoNetoEntry(e?: CostoEntry | null, iva = 0): number {
  return costosFormato(e, iva).costoNetoUnitario;
}

/**
 * La BASE DEL PRECIO DE VENTA: neta, unitaria y con la parte sin factura ya
 * despojada del IVA que el negocio va a absorber. Es lo único que puede
 * multiplicar el markup — todos los caminos que derivan un precio (POS,
 * ficha, sitio, historial) entran por acá.
 */
export function costoPrecioEntry(e?: CostoEntry | null, iva = 0): number {
  return costosFormato(e, iva).costoPrecioUnitario;
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
 * COSTO neto de un paquete fraccionado: el del kilo por lo que consume.
 *
 * Es lo único que el paquete hereda de su madre. Con este costo, un paquete
 * pasa por `precioVentaFila` igual que cualquier producto —markup o precio
 * fijo, caja por N, redondeo de góndola— y el sistema no necesita un segundo
 * camino para cotizarlo. Antes existía `precioPresentacion`, que multiplicaba el
 * precio de la lista de la madre por un `recargo`: se borró junto con la columna
 * (0053) porque era una forma paralela de decir cuánto vale un paquete.
 */
export function costoNetoPresentacion(costoNetoKg: number, tamKg: number): number {
  return (Number(costoNetoKg) || 0) * (Number(tamKg) || 0);
}
