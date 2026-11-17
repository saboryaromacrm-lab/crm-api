/**
 * EL AJUSTE A MANO (17/11/2026, pedido del dueño: «solo los ajustes manuales,
 * no los de venta»). Como «ajuste» se guardan también las reservas y
 * liberaciones de pedidos y presupuestos (cambian el estado, no la cantidad:
 * signo 0), las anulaciones de comprobantes, los descartes, los conteos y las
 * incidencias. El que carga una persona en Almacén (`opSimpleTx`) es el único
 * que mueve la cantidad y deja la descripción «Ajuste +N · motivo» o
 * «Ajuste −N · motivo»: eso lo distingue.
 */
import { and, eq, like, ne, or } from 'drizzle-orm';
import { movimientos } from '../db/schema';

/** El valor del filtro «tipo» que pide solo los ajustes a mano. */
export const AJUSTE_MANUAL = 'ajuste_manual';
/** Cómo empieza la descripción que escribe `opSimpleTx` para un ajuste (`${label} ${+|−}…`). */
const PREFIJOS = ['Ajuste +', 'Ajuste −'];

export const esAjusteManual = (m: { tipo: string; signo: number | string; descripcion?: string | null }) =>
  m.tipo === 'ajuste' && Number(m.signo) !== 0 && PREFIJOS.some((p) => (m.descripcion ?? '').startsWith(p));

/** La misma regla, para la consulta del historial. */
export const condAjusteManual = () => and(
  eq(movimientos.tipo, 'ajuste'),
  ne(movimientos.signo, 0),
  or(...PREFIJOS.map((p) => like(movimientos.descripcion, `${p}%`))),
);
