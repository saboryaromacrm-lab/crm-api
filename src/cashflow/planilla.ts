/**
 * LA PLANILLA DE CAJAS DEL DÍA (Cash Flow, 19/10/2026): la regla pura de en qué
 * quedó cada turno. La consulta vive en CashflowService.planilla().
 */

/**
 * EN QUÉ QUEDÓ UN TURNO, para la planilla del día (19/10/2026). Una sola regla,
 * la misma que Sobres y «En tránsito»: un turno cerrado que mandó efectivo
 * está SIN RENDIR hasta que su sobre tiene un control vigente.
 *   abierta     · todavía no cerró.
 *   sin_rendir  · cerró y mandó sobre; nadie lo controló.
 *   rendida     · sobre controlado.
 *   no_corresponde · sobre marcado «no corresponde» (ya estaba en el saldo inicial, extraviado).
 *   sin_sobre   · cerró sin mandar efectivo (todo quedó en la caja, o el cierre de siempre).
 *   previo      · cerró con sobre ANTES de arrancar el Cash Flow: no se controla acá.
 */
export type EstadoTurno = 'abierta' | 'sin_rendir' | 'rendida' | 'no_corresponde' | 'sin_sobre' | 'previo';
export function estadoTurno(t: { estado: string; envio: number; sobreId: number | null; descartado: boolean; cierreDia: string | null }, fechaInicio: string | null): EstadoTurno {
  if (t.estado === 'abierta') return 'abierta';
  if (!(t.envio > 0)) return 'sin_sobre';
  if (!fechaInicio || (t.cierreDia ?? '') < fechaInicio) return 'previo';
  if (t.sobreId == null) return 'sin_rendir';
  return t.descartado ? 'no_corresponde' : 'rendida';
}
