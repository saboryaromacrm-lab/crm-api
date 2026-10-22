/**
 * ASESOR COMERCIAL · CUÁNTO DEJA UNA PROMOCIÓN (0193)
 * ============================================================================
 * La IA NO hace cuentas: esto calcula, con el precio de la lista base y el
 * costo real de hoy (los mismos de la caja: `ReglasVencimientoService.articulos`),
 * qué precio queda con la promoción y cuánto deja. Lo usan la herramienta
 * «simular_promocion» (la IA prueba ideas antes de proponerlas) y cada
 * propuesta del informe (lo que ve el dueño antes de crearla).
 *
 * Los precios son FINALES (con IVA), como en Ofertas; el margen es NETO.
 * Cada tipo, igual que el motor de ofertas de la caja:
 *   porcentaje      el % sobre cada unidad.
 *   precio_fijo     cada unidad a `precioFinal`.
 *   nxm             lleva N, paga M: el precio efectivo por unidad es p·M/N.
 *   segunda_unidad  el % sobre una de cada dos: el efectivo es p·(1 − %/200).
 *   pack            N unidades a `precioFinal` (el efectivo es precioFinal/N).
 *   combo           el conjunto (cada producto con su cantidad) a `precioFinal`.
 *   ticket          el % sobre todo el ticket desde `montoMinimo`: depende de lo
 *                   que lleve cada cliente, no se simula por producto.
 * Función pura: se prueba sin base (simular.test.ts).
 */
import type { Articulo } from '../../vencimientos/reglas';

export interface ItemPromo { productoId: number; presentacionId: number; cantidad: number }
export interface Promo {
  tipo: string; productos: ItemPromo[];
  porcentaje: number; precioFinal: number; lleva: number; paga: number; montoMinimo: number;
}

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const r1 = (n: number) => Math.round((Number(n) || 0) * 10) / 10;
const neto = (final: number, iva: number) => final / (1 + (Number(iva) || 0) / 100);
export const claveArticulo = (productoId: number, presentacionId: number | null | undefined) => `${productoId}-${presentacionId || 0}`;

/** El precio de lista que manda: la lista base (mostrador) o, si no tiene, la primera activa. */
export const precioBase = (a: Articulo) => (a.listas.find((l) => l.listaId === a.listaBaseId) ?? a.listas[0])?.precio ?? null;

export function simular(p: Promo, articulos: Map<string, Articulo>, nombres: Map<string, string> = new Map()) {
  const avisos: string[] = [];
  const nombre = (it: ItemPromo) => nombres.get(claveArticulo(it.productoId, it.presentacionId)) ?? `#${it.productoId}`;
  if (!p.productos.length && p.tipo !== 'ticket') return { tipo: p.tipo, avisos: ['La promoción no tiene productos.'] };
  if (p.tipo === 'ticket') {
    return {
      tipo: p.tipo, avisos: [`${r1(p.porcentaje)} % sobre todo el ticket desde $${Math.round(p.montoMinimo).toLocaleString('es-AR')}: lo que deja depende de lo que lleve cada cliente (no se simula por producto).`],
    };
  }

  const datos = p.productos.map((it) => {
    const a = articulos.get(claveArticulo(it.productoId, it.presentacionId));
    const precio = a ? precioBase(a) : null;
    if (!a) avisos.push(`${nombre(it)}: no existe o no tiene costo cargado.`);
    else if (precio == null) avisos.push(`${nombre(it)}: no tiene precio en ninguna lista activa.`);
    return { it, a, precio };
  });

  if (p.tipo === 'combo') {
    const ok = datos.filter((d) => d.a && d.precio != null);
    if (ok.length < 2) return { tipo: p.tipo, avisos: [...avisos, 'Un combo necesita al menos dos productos con precio.'] };
    const cant = (d: typeof ok[number]) => Math.max(1, Math.round(d.it.cantidad || 1));
    const lista = ok.reduce((s, d) => s + d.precio! * cant(d), 0);
    const costo = ok.reduce((s, d) => s + d.a!.costoReal * cant(d), 0);
    /* El neto del combo: el precio del combo repartido por el valor de cada producto, cada parte sin su IVA. */
    const netoCombo = ok.reduce((s, d) => s + neto(p.precioFinal * ((d.precio! * cant(d)) / lista), d.a!.iva), 0);
    const netoLista = ok.reduce((s, d) => s + neto(d.precio! * cant(d), d.a!.iva), 0);
    const margen = netoCombo - costo;
    if (p.precioFinal <= 0) avisos.push('Falta el precio del combo.');
    if (margen < 0) avisos.push('El combo queda por DEBAJO del costo.');
    return {
      tipo: p.tipo, avisos,
      combo: {
        productos: ok.map((d) => ({ producto: nombre(d.it), cantidad: cant(d), precioLista: r2(d.precio!), costo: r2(d.a!.costoReal) })),
        precioListaTotal: r2(lista), precioCombo: r2(p.precioFinal), descuentoPct: lista > 0 ? r1((1 - p.precioFinal / lista) * 100) : null,
        costoTotal: r2(costo), margenAntes: r2(netoLista - costo), margenCombo: r2(margen), margenComboPct: netoCombo > 0 ? r1((margen / netoCombo) * 100) : null,
        bajoCosto: margen < 0,
      },
    };
  }

  const efectivo = (precio: number) => {
    switch (p.tipo) {
      case 'porcentaje': return precio * (1 - p.porcentaje / 100);
      case 'precio_fijo': return p.precioFinal;
      case 'nxm': return p.lleva > 0 && p.paga > 0 && p.paga < p.lleva ? (precio * p.paga) / p.lleva : null;
      case 'segunda_unidad': return precio * (1 - p.porcentaje / 200);
      case 'pack': return p.lleva >= 2 && p.precioFinal > 0 ? p.precioFinal / p.lleva : null;
      default: return null;
    }
  };
  const filas = datos.filter((d) => d.a && d.precio != null).map((d) => {
    const promo = efectivo(d.precio!);
    if (promo == null) return null;
    const costo = d.a!.costoReal; const iva = d.a!.iva;
    const margenAntes = neto(d.precio!, iva) - costo; const margen = neto(promo, iva) - costo;
    return {
      producto: nombre(d.it), precioLista: r2(d.precio!), precioPromoPorUnidad: r2(promo), descuentoPct: r1((1 - promo / d.precio!) * 100),
      costo: r2(costo), margenAntesPorUnidad: r2(margenAntes), margenPromoPorUnidad: r2(margen),
      margenPromoPct: neto(promo, iva) > 0 ? r1((margen / neto(promo, iva)) * 100) : null, bajoCosto: margen < 0,
    };
  }).filter((x): x is NonNullable<typeof x> => x != null);
  if (!filas.length && !avisos.length) avisos.push('Faltan datos de la promoción (porcentaje, precio, lleva o paga).');
  for (const f of filas) if (f.bajoCosto) avisos.push(`${f.producto}: con la promoción queda por DEBAJO del costo.`);
  return { tipo: p.tipo, avisos, productos: filas };
}
