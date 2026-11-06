/**
 * EL CARGO EXTRA A MANO (6/11/2026, pedido del dueño).
 *
 * El botón «Cargo extra» del POS dejaba escribir cualquier concepto con
 * cualquier precio y cualquier IVA. En octubre se usó sobre todo para vender
 * PRODUCTOS tipeados a mano (sin stock, sin costo) y casi todos con IVA 0 —
 * buena parte dentro de una Factura B, que es un problema fiscal.
 *
 * Desde ahora escribir un cargo libre pide el permiso `cargo_extra`, que no
 * trae ningún rol (lo tilda el superadmin en Gerencia › Usuarios y roles).
 * Sin el permiso NO se puede cargar ningún cargo a mano: ni siquiera Envío o
 * Bolsa (6/11/2026, el dueño: «que elimines todo hasta envío y bolsa»). El
 * botón ni aparece en la caja.
 *
 * Pasan además, sin permiso, los cargos que NO tipea nadie:
 *   · el envío a domicilio de un pedido de la tienda / presupuesto
 *     («Envío a domicilio (B° …)», lo arma Presupuestos al cerrar en el POS);
 *   · el recargo por cuotas (lo pone el servidor al cobrar);
 *   · los que el ticket YA tenía guardados (el cajero sigue trabajando sobre
 *     un ticket que cargó alguien con permiso; el permiso es para AGREGAR).
 */

const RE_ENVIO_PEDIDO = /^Envío a domicilio( \(B° [^)]*\))?$/;
const RE_RECARGO = /^Recargo \d+ cuotas? \(/;

type Extra = { concepto?: string | null; importe?: number | string | null; iva?: number | string | null };

/** ¿Este cargo lo pone el sistema (y lo puede llevar un ticket de alguien SIN el permiso)? */
export function esCargoFijo(e: Extra): boolean {
  const c = String(e?.concepto ?? '').trim();
  if (RE_RECARGO.test(c)) return true;
  return Number(e?.iva) === 21 && RE_ENVIO_PEDIDO.test(c);
}

const clave = (e: Extra) => `${String(e?.concepto ?? '').trim()}|${Number(e?.importe) || 0}|${Number(e?.iva) || 0}`;

/**
 * Los cargos que este ticket NO puede llevar: libres, sin el permiso, y que no
 * estaban ya en el ticket guardado. Vacío = todo en regla.
 */
export function cargosNoPermitidos(extras: Extra[] = [], puedeLibre: boolean, previos: Extra[] = []): Extra[] {
  if (puedeLibre) return [];
  const ya = new Map<string, number>();
  for (const p of previos ?? []) ya.set(clave(p), (ya.get(clave(p)) ?? 0) + 1);
  const malos: Extra[] = [];
  for (const e of extras ?? []) {
    if (esCargoFijo(e)) continue;
    const k = clave(e);
    const quedan = ya.get(k) ?? 0;
    if (quedan > 0) { ya.set(k, quedan - 1); continue; }
    malos.push(e);
  }
  return malos;
}

/** El mensaje para el cajero. */
export function mensajeCargoNoPermitido(malos: Extra[]): string {
  const nombres = malos.map((e) => `«${String(e.concepto ?? '').trim() || 'sin concepto'}»`).join(', ');
  return `Para cargar ${nombres} a mano hace falta el permiso «Cargo extra a mano». `
    + 'Si es mercadería, cargala como producto.';
}
