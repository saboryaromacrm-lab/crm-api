/**
 * LA FICHA DE MOVIMIENTOS DE UN PRODUCTO (kardex) — 20/10/2026, pedido del dueño
 * ============================================================================
 * «Al entrar al movimiento de un producto me tiene que mostrar todo de todo
 * para hacerle seguimiento.» Cada movimiento con lo que sumó o restó en cada
 * artículo (el suelto y cada paquete), sucursal y estado del stock, y el saldo
 * que dejó.
 *
 * TODO cambio de stock pasa por `addDelta` y TODO `addDelta` escribe su
 * movimiento (inventario.service.ts, verificado 20/10/2026), así que el stock
 * de hoy menos lo que movió cada movimiento, hacia atrás, da el saldo de cada
 * momento. Lo que queda antes del primer movimiento es la CARGA INICIAL (stock
 * que entró sin movimiento, al arrancar el sistema): en estados que no sean
 * «disponible» tiene que ser 0, y en disponible no puede ser negativo. Si no,
 * algo no cierra: eso es lo que revisa `incoherencias`.
 *
 * Acá, solo la cuenta (sin base de datos), para poder probarla.
 */

/** El movimiento como está guardado (lo que importa para la cuenta). */
export interface Mov {
  id: number;
  tipo: string;
  sucursalId: number | null;
  presentacionId: number | null;
  signo: number;
  cantidad: number;
  estadoDesde: string | null;
  estadoHacia: string | null;
}

/** Lo que un fraccionado registró por paquete (0102): `paquetes` con signo (una corrección puede restar). */
export interface ItemFraccion { presentacionId: number; paquetes: number; tamKg: number }

export interface Delta { sucursalId: number; presentacionId: number; estado: string; delta: number }

const r3 = (n: number) => Math.round(n * 1000) / 1000;
export const claveSaldo = (d: { sucursalId: number; presentacionId: number; estado: string }) => `${d.sucursalId}|${d.presentacionId}|${d.estado}`;

/**
 * Lo que un movimiento sumó o restó, por artículo y estado. Las reglas salen
 * de cómo cada camino escribe el movimiento junto a su `addDelta`:
 *
 *   · baja (signo −1): resta en `estadoDesde`; si además tiene `estadoHacia`
 *     (merma que pasa a vencido/defectuoso), lo suma ahí;
 *   · alta (signo +1): suma en `estadoHacia`;
 *   · cambio de estado (signo 0): resta en `estadoDesde` y suma en `estadoHacia`;
 *   · `estadoDesde` = `estadoHacia` (ajuste por incidencia): suma o resta según el signo;
 *   · FRACCIONADO: el movimiento guarda los kg; los paquetes, el registro de
 *     fraccionamiento (`items`). Sin registro (anterior a la 0102) y con un
 *     solo paquete, se deduce de los kg y queda marcado `estimado`. Pasa en
 *     disponible, salvo el de un pedido al cargar lo armado (0206): ese pasa en
 *     comprometido, y lo dice su `estadoHacia`.
 */
export function deltasDe(m: Mov, items: ItemFraccion[] = [], tamPres?: (presId: number) => number | null): { deltas: Delta[]; estimado: boolean } {
  const suc = m.sucursalId ?? 0;
  const c = Number(m.cantidad) || 0;
  if (m.tipo === 'fraccionamiento') {
    const estado = m.estadoHacia ?? 'disponible';
    if (items.length) {
      const kg = r3(items.reduce((a, i) => a + i.paquetes * i.tamKg, 0));
      return {
        estimado: false,
        deltas: [
          { sucursalId: suc, presentacionId: 0, estado, delta: -kg },
          ...items.map((i) => ({ sucursalId: suc, presentacionId: i.presentacionId, estado, delta: i.paquetes })),
        ],
      };
    }
    const tam = m.presentacionId ? tamPres?.(m.presentacionId) ?? null : null;
    if (m.presentacionId && tam && tam > 0) {
      return {
        estimado: true,
        deltas: [
          { sucursalId: suc, presentacionId: 0, estado, delta: -c },
          { sucursalId: suc, presentacionId: m.presentacionId, estado, delta: Math.round(c / tam) },
        ],
      };
    }
    return { estimado: true, deltas: [] };
  }
  const pres = m.presentacionId ?? 0;
  const de = m.estadoDesde;
  const a = m.estadoHacia;
  if (de && a && de === a) return { estimado: false, deltas: [{ sucursalId: suc, presentacionId: pres, estado: de, delta: (m.signo || 0) * c }] };
  const deltas: Delta[] = [];
  if (de && m.signo <= 0) deltas.push({ sucursalId: suc, presentacionId: pres, estado: de, delta: -c });
  if (a && m.signo >= 0) deltas.push({ sucursalId: suc, presentacionId: pres, estado: a, delta: c });
  /* La baja que pasa a vencido/defectuoso (signo −1 con los dos estados). */
  if (de && a && m.signo < 0) deltas.push({ sucursalId: suc, presentacionId: pres, estado: a, delta: c });
  return { estimado: false, deltas };
}

/**
 * Hacia atrás desde el stock de hoy: el saldo DESPUÉS de cada movimiento (por
 * clave), y lo que queda antes del primero (la carga inicial). `movs` en
 * orden de id ascendente; `hoy` es el stock actual por clave.
 */
export function saldosHaciaAtras(movs: { id: number; deltas: Delta[] }[], hoy: Map<string, number>) {
  const actual = new Map(hoy);
  const despues = new Map<number, Map<string, number>>();
  for (let i = movs.length - 1; i >= 0; i--) {
    const m = movs[i];
    const foto = new Map<string, number>();
    for (const d of m.deltas) foto.set(claveSaldo(d), r3(actual.get(claveSaldo(d)) ?? 0));
    despues.set(m.id, foto);
    for (const d of m.deltas) actual.set(claveSaldo(d), r3((actual.get(claveSaldo(d)) ?? 0) - d.delta));
  }
  return { despues, inicial: actual };
}

/**
 * Lo que NO cierra: una carga inicial imposible. En comprometido, en tránsito,
 * vencido, defectuoso o retenido no se carga stock a mano (todo entra como
 * disponible), así que su saldo antes del primer movimiento tiene que ser 0; y
 * el disponible no puede arrancar negativo.
 */
export function incoherencias(inicial: Map<string, number>, tolerancia = 0.0005) {
  const out: { sucursalId: number; presentacionId: number; estado: string; cantidad: number; motivo: string }[] = [];
  for (const [k, v] of inicial) {
    const [suc, pres, estado] = k.split('|');
    const base = { sucursalId: Number(suc), presentacionId: Number(pres), estado, cantidad: r3(v) };
    if (estado !== 'disponible' && Math.abs(v) > tolerancia) {
      out.push({ ...base, motivo: `En «${estado}» había stock antes de cualquier movimiento: algo cambió ese estado sin dejar registro.` });
    } else if (estado === 'disponible' && v < -tolerancia) {
      out.push({ ...base, motivo: 'El disponible arrancaría negativo: hay más salidas registradas que stock posible.' });
    }
  }
  return out;
}
