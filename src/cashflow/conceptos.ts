/**
 * LOS CONCEPTOS: UNA SOLA LISTA PARA EL CASH FLOW Y LA CAJA DE LOS LOCALES
 * (0133, y desde 0192 también en la caja de los locales, pedido del dueño).
 *
 * Reglas puras, sin base: el Cash Flow y la caja las usan iguales.
 *   · Dónde se ofrece: `enCashflow` / `enCaja` (al menos uno).
 *   · `pideDetalle`: la descripción es obligatoria («Otro egreso»).
 *   · `aplicaProveedor` (0226): el egreso se puede pasar a la cuenta de un
 *     proveedor. Si además dice «depósito», el pago es un depósito; si no, es
 *     en efectivo (el proveedor que pasa a cobrar por el local).
 *   · Se reconoce por el NOMBRE (decisión del dueño): «efectivo por
 *     transferencia» es un cambio y solo va en el Cash Flow, con quién y a qué
 *     cuenta; «adelanto» pide el empleado.
 */
import { BadRequestException } from '@nestjs/common';

const normal = (v: unknown) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Un concepto de depósito (16/10/2026): todo egreso que diga «depósito», con o sin tilde. */
export const esConceptoDeposito = (nombre: unknown) => normal(nombre).includes('deposito');

/** Con qué le llega al proveedor un egreso de concepto aplicado a su cuenta: depósito si lo dice el nombre, si no efectivo. */
export const medioAlProveedor = (nombre: unknown): 'deposito' | 'efectivo' => (esConceptoDeposito(nombre) ? 'deposito' : 'efectivo');

/** Un concepto que es en sí un cambio (0191): «Cambio a mi cuenta (efectivo por transferencia)». */
export const esConceptoCambio = (nombre: unknown) => normal(nombre).includes('efectivo por transferencia');

/**
 * Un concepto de adelanto de sueldo (6/11/2026): todo EGRESO que diga «adelanto»
 * («Adelantos sueldos», «Adelanto aguinaldo»…). Pide elegir el empleado (0221)
 * y es lo que se manda a la app de sueldos.
 */
export const esConceptoAdelanto = (c: { nombre?: string | null; tipo?: string | null }) =>
  c?.tipo === 'egreso' && normal(c?.nombre).includes('adelanto');

/** Lo mínimo que estas reglas necesitan de un concepto. */
export type ConceptoRegla = { nombre: string; tipo: string; clase: string; activo: boolean; gastoCategoriaId: number | null; pideDetalle: boolean };

/**
 * ¿Este concepto se puede usar para este movimiento? La misma pregunta en las
 * dos cajas: existe, está activo, es del tipo pedido y, si es gasto, tiene rubro.
 * Devuelve la descripción limpia (obligatoria si el concepto la pide).
 */
export function exigirConcepto(c: ConceptoRegla | undefined, tipo: 'ingreso' | 'egreso', detalleIn: unknown): string {
  if (!c) throw new BadRequestException('Ese concepto no existe.');
  if (!c.activo) throw new BadRequestException(`«${c.nombre}» está desactivado: elegí otro concepto.`);
  if (c.tipo !== tipo) throw new BadRequestException(`«${c.nombre}» es un concepto de ${c.tipo}.`);
  if (c.clase === 'gasto' && !c.gastoCategoriaId) {
    throw new BadRequestException(`«${c.nombre}» es un concepto de gasto pero no tiene rubro: asignale uno en Cash Flow › Configuración › Conceptos.`);
  }
  const detalle = String(detalleIn ?? '').trim().replace(/\s+/g, ' ');
  if (c.pideDetalle && !detalle) throw new BadRequestException(`«${c.nombre}» pide una descripción: escribí qué fue.`);
  return detalle;
}

/** El texto del movimiento en la caja del local: «Concepto · descripción». */
export const textoConcepto = (nombre: string, detalle: string) => (detalle ? `${nombre} · ${detalle}` : nombre);
