/*
 * LOS CÓDIGOS ANTERIORES DE UN PRODUCTO (0241, 23/11/2026, pedido del dueño).
 *
 * El fabricante cambia el código de barras y en la góndola conviven las dos
 * tandas: el producto conserva los códigos viejos para que la mercadería de
 * antes se siga encontrando al escanearla. Acá, solo la regla de qué lista
 * queda al guardar la ficha (sin base de datos, para poder probarla).
 */

/** Tope de códigos anteriores por producto: más que esto ya no es «la tanda vieja». */
export const MAX_CODIGOS_ANTERIORES = 20;

/**
 * La lista que queda al guardar:
 *   · la que manda la ficha (`pedidos`) o, si no la manda, la que ya tenía (`previos`);
 *   · más el código de barras que tenía (`barrasAntes`) si se lo cambiaron: se guarda solo;
 *   · sin vacíos, sin repetidos y sin los códigos propios del producto (`propios`:
 *     su código de barras, su código interno y su DUN), que ya lo identifican.
 * Si pasa el tope, quedan los más nuevos (los del final).
 */
export function codigosAnteriores(o: {
  pedidos?: string[] | null;
  previos?: string[] | null;
  barrasAntes?: string | null;
  propios: (string | null | undefined)[];
}): string[] {
  const propios = new Set(o.propios.map((c) => String(c ?? '').trim()).filter(Boolean));
  const out: string[] = [];
  for (const c of [...(o.pedidos ?? o.previos ?? []), o.barrasAntes]) {
    const t = String(c ?? '').trim();
    if (t && !propios.has(t) && !out.includes(t)) out.push(t);
  }
  return out.slice(-MAX_CODIGOS_ANTERIORES);
}
