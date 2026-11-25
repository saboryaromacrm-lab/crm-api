/**
 * LA TRANSFERENCIA QUE UN CLIENTE LE HIZO DIRECTO A UN PROVEEDOR (0246,
 * 25/11/2026, pedido del dueño): sin cuenta disponible de por medio. Lo puro:
 * la referencia que queda en el renglón de la venta (y cómo se vuelve a la de
 * antes al deshacer) y las reglas de lo que se aplica a sus documentos.
 */
const EPS = 0.009;
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export type ImputacionDirecta = { comprobanteId?: number; gastoId?: number; importe: number };

/** «ALDANA · directo», con la referencia que ya tenía el renglón detrás. */
export function referenciaDirecta(proveedor: string, original: string): string {
  const antes = String(original ?? '').trim();
  return `${proveedor} · directo${antes ? ` · ${antes}` : ''}`;
}

/** Al deshacer, la referencia de antes. Si no tiene la forma esperada (el proveedor cambió de nombre), queda como está. */
export function referenciaOriginal(proveedor: string, referencia: string): string {
  const prefijo = `${proveedor} · directo`;
  if (!referencia.startsWith(prefijo)) return referencia;
  return referencia.slice(prefijo.length).replace(/^ · /, '');
}

/**
 * Lo que se aplica a sus documentos, antes de tocar la base: cada renglón a UN
 * documento, sin repetir, por más de 0, todos del mismo mundo (un pago vive en
 * una sola bandeja) y sin pasarse de lo transferido. El resto queda a cuenta.
 * Devuelve el destino del pago o el error para la pantalla.
 */
export function planDirecto(
  importe: number, items: ImputacionDirecta[], soloGastos: boolean,
): { destino: 'mercaderia' | 'gastos' } | { error: string } {
  const vistos = new Set<string>();
  for (const it of items) {
    if (!!it.comprobanteId === !!it.gastoId) return { error: 'Cada parte se aplica a un solo documento.' };
    if (!(r2(it.importe) > 0)) return { error: 'Lo que se aplica a cada documento tiene que ser mayor a 0.' };
    const clave = it.gastoId ? `g${it.gastoId}` : `c${it.comprobanteId}`;
    if (vistos.has(clave)) return { error: 'Un documento está dos veces.' };
    vistos.add(clave);
  }
  const conGastos = items.some((x) => x.gastoId);
  if (conGastos && items.some((x) => x.comprobanteId)) {
    return { error: 'Un pago va a facturas de mercadería o a gastos, no a los dos: elegí unos u otros.' };
  }
  const suma = r2(items.reduce((a, x) => a + r2(x.importe), 0));
  if (suma - r2(importe) > EPS) {
    return { error: `Se están aplicando $${suma.toFixed(2)} y la transferencia es de $${r2(importe).toFixed(2)}.` };
  }
  if (!items.length) return { destino: soloGastos ? 'gastos' : 'mercaderia' };
  return { destino: conGastos ? 'gastos' : 'mercaderia' };
}
