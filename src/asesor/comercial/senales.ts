/**
 * ASESOR COMERCIAL · LAS SEÑALES (0193)
 * ============================================================================
 * Lo que el SISTEMA detecta solo sobre la foto comercial, con reglas fijas:
 * no gasta IA y se ve aunque la IA no esté configurada. Funciones puras: se
 * prueban sin base (comercial.test.ts).
 */
import type { Nivel, Senal } from '../nucleo/especialidad';
import { metricasViejas } from '../negocio/senales';

export const UMBRALES = {
  fechaCercanaDias: 21, tiendaCaePct: -20, descuentosPct: 10, comboLift: 2, comboTickets: 10,
};

const ok = (x: any) => x && typeof x === 'object' && !('error' in x);
const $ = (n: number) => `$${Math.round(n).toLocaleString('es-AR')}`;
const nombres = (xs: any[], k: string, n = 4) => xs.slice(0, n).map((x) => x[k]).join(', ') + (xs.length > n ? ` y ${xs.length - n} más` : '');

export function detectar(foto: any, ahora = new Date()): Senal[] {
  const s: Senal[] = [];
  const U = UMBRALES;
  const viejas = metricasViejas(foto, ahora);
  if (viejas) s.push(viejas);

  /* Vencimientos: lo que no llega a venderse antes de vencer. */
  const v = foto?.porVencer;
  if (ok(v)) {
    const vigentes = (v.detalle ?? []).filter((x: any) => x.diasQueFaltan >= 0 && !x.llegaAVenderse);
    const sinOferta = vigentes.filter((x: any) => !x.oferta?.activa);
    const conOferta = vigentes.filter((x: any) => x.oferta?.activa);
    if (sinOferta.length) s.push({ nivel: 'urgente', area: 'vencimientos', titulo: `${sinOferta.length} lote(s) por vencer no llegan a venderse y no tienen oferta`, detalle: `${nombres(sinOferta, 'producto')}: ${$(sinOferta.reduce((a: number, x: any) => a + x.valorACosto, 0))} a costo en riesgo.` });
    if (conOferta.length) s.push({ nivel: 'mirar', area: 'vencimientos', titulo: `${conOferta.length} lote(s) no llegan a venderse ni con la oferta que tienen`, detalle: `${nombres(conOferta, 'producto')}: hace falta algo más (combo, otro local, la tienda online).` });
    if (v.vencidosSinProcesar > 0) s.push({ nivel: 'mirar', area: 'vencimientos', titulo: `${v.vencidosSinProcesar} lote(s) ya vencieron y siguen sin procesar`, detalle: 'Hay que darlos de baja o resolverlos en Almacén › Vencimientos: siguen contando como stock.' });
  }

  /* Fechas comerciales cerca y nada armado para ellas. */
  const q = foto?.queViene;
  const armadas: any[] = Array.isArray(foto?.ofertasActivasHoy) ? foto.ofertasActivasHoy : [];
  if (ok(q)) {
    for (const x of q.fechasComerciales ?? []) {
      if (x.faltan > U.fechaCercanaDias) continue;
      /* Hay algo armado si alguna oferta (que no sea la automática por vencimiento) corre hasta esa fecha o después. */
      const hay = armadas.some((o: any) => !o.automaticaPorVencimiento && (!o.hasta || o.hasta >= x.fecha));
      if (!hay) s.push({ nivel: 'mirar', area: 'fechas', titulo: `${x.nombre} en ${x.faltan} día(s) y no hay promociones armadas`, detalle: `${x.fecha}${x.aprox ? ' (fecha aproximada)' : ''}. ${x.nota}` });
    }
  }

  /* Cómo rindieron las ofertas. */
  const of = foto?.comoRindieronLasOfertas60Dias;
  if (ok(of)) {
    const pierden = (of.ofertas ?? []).filter((x: any) => x.veredicto === 'pierde');
    if (pierden.length) s.push({ nivel: 'mirar', area: 'ofertas', titulo: `${pierden.length} oferta(s) pierden plata`, detalle: nombres(pierden, 'oferta') });
    const nada = (of.ofertas ?? []).filter((x: any) => x.veredicto === 'sin_ventas' && x.estado === 'vigente');
    if (nada.length) s.push({ nivel: 'dato', area: 'ofertas', titulo: `${nada.length} oferta(s) vigentes sin ninguna venta`, detalle: `${nombres(nada, 'oferta')}: revisá si se ven (cartel, tienda) o si el precio convence.` });
    if (of.descuentosPctDeLaVenta != null && of.descuentosPctDeLaVenta >= U.descuentosPct) s.push({ nivel: 'mirar', area: 'ofertas', titulo: `Los descuentos son el ${of.descuentosPctDeLaVenta} % de la venta`, detalle: 'Mirá cuáles traen venta nueva y cuáles solo regalan margen.' });
  }

  /* Tienda online. */
  const t = foto?.tiendaOnline30Dias;
  if (ok(t)) {
    for (const [modo, lado] of [['minorista', t.minorista], ['mayorista', t.mayorista]] as const) {
      const r = lado?.resumen ?? {};
      if ((r.sesiones?.antes ?? 0) >= 50 && r.sesiones?.variacionPct != null && r.sesiones.variacionPct <= U.tiendaCaePct) {
        s.push({ nivel: 'mirar', area: 'tienda_online', titulo: `Tienda ${modo}: ${Math.abs(r.sesiones.variacionPct)} % menos visitantes`, detalle: `${r.sesiones.ahora} contra ${r.sesiones.antes} en el período anterior.` });
      }
      if ((r.pedidos?.antes ?? 0) >= 5 && r.conversion?.variacionPct != null && r.conversion.variacionPct <= U.tiendaCaePct) {
        s.push({ nivel: 'mirar', area: 'tienda_online', titulo: `Tienda ${modo}: la conversión baja ${Math.abs(r.conversion.variacionPct)} %`, detalle: `Entran pero compran menos: ${r.conversion.ahora} contra ${r.conversion.antes}.` });
      }
      if ((lado?.seMiranYNoSeCompran ?? []).length >= 3) s.push({ nivel: 'dato', area: 'tienda_online', titulo: `Tienda ${modo}: ${lado.seMiranYNoSeCompran.length} producto(s) muy mirados que casi no se compran`, detalle: nombres(lado.seMiranYNoSeCompran, 'producto') });
    }
  }

  /* Cupones que pierden. */
  const cu = foto?.cupones60Dias;
  if (ok(cu)) {
    const malos = (cu.cupones ?? []).filter((x: any) => x.usos > 0 && x.ganancia < 0);
    if (malos.length) s.push({ nivel: 'mirar', area: 'cupones', titulo: `${malos.length} cupón(es) dejan pérdida`, detalle: nombres(malos, 'codigo') });
  }

  /* Combos naturales: lo que la gente ya lleva junto. */
  const cj = foto?.compradosJuntos60Dias;
  if (ok(cj)) {
    const fuertes = (cj.pares ?? []).filter((x: any) => (x.lift ?? 0) >= U.comboLift && x.ticketsJuntos >= U.comboTickets);
    if (fuertes.length) s.push({ nivel: 'dato', area: 'combos', titulo: `${fuertes.length} par(es) de productos que se compran juntos mucho más de lo normal`, detalle: fuertes.slice(0, 3).map((x: any) => `${x.productoA.nombre} + ${x.productoB.nombre}`).join(' · ') });
  }

  /* Plata parada: candidatos a combo o a oferta. */
  const st = foto?.stockQueNoSeMueve;
  if (ok(st) && (st.resumen?.valorParado ?? 0) > 0) {
    s.push({ nivel: 'dato', area: 'stock', titulo: `${$(st.resumen.valorParado)} a costo en stock que no se vendió en 30 días`, detalle: `Candidatos a combo con lo que más rota: ${nombres(st.parado ?? [], 'producto', 3)}.` });
  }

  const orden: Record<Nivel, number> = { urgente: 0, mirar: 1, dato: 2 };
  return s.sort((a, b) => orden[a.nivel] - orden[b.nivel]);
}
