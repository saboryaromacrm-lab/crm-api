/**
 * DIFERENCIAS DE ENTREGA — las reglas puras (0248, 26/11/2026). El servicio
 * está en `diferencias.module.ts`.
 *
 * Tres fuentes, cada una manda en lo suyo:
 *   · EL STOCK sigue a lo que LLEGÓ (lo que hay en la góndola).
 *   · LA CUENTA del proveedor sigue a EL PAPEL (lo que te va a cobrar).
 *   · LA DIFERENCIA queda pendiente con el proveedor hasta que se resuelve.
 *
 * En un proveedor mitad y mitad, lo que llegó se compara contra LAS DOS
 * mitades juntas (`otraMitad`): lo que en la factura A parece «de más» casi
 * siempre viene en la liquidación. Y lo que el papel cobra pero ya había
 * entrado antes como «de más» (`cubiertos`) no vuelve a entrar.
 */

export type Renglon = { productoId: number; presentacionId?: number | null; cantidad: number };
export type ErrorReparto = { productoId: number; presentacionId: number | null; tipo: 'falta_mas_que_el_papel' | 'cobra_mas_de_lo_que_entro' | 'negativo'; puede: number };

const EPS = 1e-6;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Un producto en un envasado: la llave con que se comparan papel y llegada. */
export const claveDe = (productoId: number, presentacionId?: number | null) => `${productoId}:${presentacionId ?? 0}`;
const deClave = (k: string) => {
  const [p, pres] = k.split(':').map(Number);
  return { productoId: p, presentacionId: pres || null };
};

function sumarPorClave(renglones: Renglon[] | null | undefined) {
  const m = new Map<string, number>();
  for (const r of renglones ?? []) {
    const k = claveDe(r.productoId, r.presentacionId);
    m.set(k, (m.get(k) ?? 0) + (Number(r.cantidad) || 0));
  }
  return m;
}

/**
 * EL REPARTO DE UNA ENTREGA. Por cada producto que se contó (`llegaron`, en
 * unidades del stock; lo que no se contó llegó como dice el papel):
 *
 *   esperado = lo de este papel + lo de la otra mitad − lo que ya había entrado
 *   faltante = esperado − llegó   (sale de lo que este papel iba a ingresar)
 *   sobrante = llegó − esperado   (entra aparte, sin deuda)
 *
 * `noEntra[i]` es lo del renglón i que no entra al stock: lo cubierto más el
 * faltante, repartido en orden entre los renglones del mismo producto.
 */
export function repartirEntrega(e: {
  items: Renglon[];
  llegaron?: Renglon[] | null;
  otraMitad?: Map<string, number> | null;
  cubiertos?: Map<string, number> | null;
}) {
  const facturado = sumarPorClave(e.items);
  const llegaron = sumarPorClave(e.llegaron);
  const cubiertos = e.cubiertos ?? new Map<string, number>();
  const errores: ErrorReparto[] = [];
  const faltantes: Renglon[] = [];
  const sobrantes: Renglon[] = [];
  const sinEntrar = new Map<string, number>();

  for (const [k, c] of cubiertos) {
    const f = facturado.get(k) ?? 0;
    if (c > f + EPS) errores.push({ ...deClave(k), tipo: 'cobra_mas_de_lo_que_entro', puede: r6(f) });
    else if (c > EPS) sinEntrar.set(k, c);
  }

  for (const [k, llego] of llegaron) {
    if (llego < -EPS) { errores.push({ ...deClave(k), tipo: 'negativo', puede: 0 }); continue; }
    const deEste = (facturado.get(k) ?? 0) - (cubiertos.get(k) ?? 0);
    const dif = r6(llego - (deEste + (e.otraMitad?.get(k) ?? 0)));
    if (dif < -EPS) {
      const falta = -dif;
      if (falta > deEste + EPS) { errores.push({ ...deClave(k), tipo: 'falta_mas_que_el_papel', puede: r6(Math.max(0, deEste)) }); continue; }
      faltantes.push({ ...deClave(k), cantidad: r6(falta) });
      sinEntrar.set(k, (sinEntrar.get(k) ?? 0) + falta);
    } else if (dif > EPS) {
      sobrantes.push({ ...deClave(k), cantidad: dif });
    }
  }

  const resto = new Map(sinEntrar);
  const noEntra = e.items.map((it) => {
    const k = claveDe(it.productoId, it.presentacionId);
    const queda = resto.get(k) ?? 0;
    const aca = Math.min(queda, Number(it.cantidad) || 0);
    resto.set(k, queda - aca);
    return r6(aca);
  });
  return { noEntra, faltantes, sobrantes, errores };
}

/** Lo resuelto de una diferencia y lo que le queda (con tolerancia de redondeo). */
export function pendienteDe(cantidad: number, resuelto: number) {
  const p = r6((Number(cantidad) || 0) - (Number(resuelto) || 0));
  return p > EPS ? p : 0;
}

/** Cómo se resuelve cada tipo (y cuáles mueven stock: + entra, − sale, 0 nada). */
export const RESOLUCIONES = {
  faltante: { llego: 1, nota_credito: 0, perdido: 0 },
  sobrante: { facturado: 0, devuelto: -1, sin_cargo: 0 },
} as const;
export type Como = 'llego' | 'nota_credito' | 'perdido' | 'facturado' | 'devuelto' | 'sin_cargo';
/** Las que se cargan a mano desde Cambios de mercadería (las otras nacen de un papel). */
export const A_MANO: Record<'faltante' | 'sobrante', Como[]> = { faltante: ['llego', 'perdido'], sobrante: ['devuelto', 'sin_cargo'] };
export const movimientoDe = (tipo: 'faltante' | 'sobrante', como: Como): -1 | 0 | 1 =>
  ((RESOLUCIONES[tipo] as Record<string, number>)[como] ?? 0) as -1 | 0 | 1;
