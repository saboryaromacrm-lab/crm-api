/**
 * LA CONCILIACIÓN CONGELA (28/9/2026)
 * ============================================================================
 * "Concilié con su resumen" era solo un sello: después de cuadrar la cuenta con
 * el proveedor se podía cargar un pago, un gasto o una factura con fecha
 * ANTERIOR, o anular uno viejo, y el saldo ya cuadrado cambiaba sin que nadie
 * lo notara. Ahora lo que tiene fecha anterior al DÍA conciliado no entra ni se
 * anula; el mismo día sí (se concilia a la mañana y se sigue trabajando). Si de
 * verdad hay que corregir algo viejo, primero se quita la conciliación, a la
 * vista, en su estado de cuenta.
 */
import { BadRequestException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { proveedores } from '../db/schema';

export async function exigirFueraDeConciliado(
  ex: any, proveedorId: number | null | undefined, fecha: Date | string | null | undefined, que: string,
) {
  if (!proveedorId) return;
  const [p] = await ex.select({ nombre: proveedores.nombre, conciliadoHasta: proveedores.conciliadoHasta })
    .from(proveedores).where(eq(proveedores.id, proveedorId)).limit(1);
  if (!p?.conciliadoHasta) return;
  const dia = new Date(p.conciliadoHasta); dia.setHours(0, 0, 0, 0);
  const f = fecha
    ? (typeof fecha === 'string' ? new Date(fecha.length <= 10 ? `${fecha}T00:00:00` : fecha) : new Date(fecha))
    : new Date();
  if (f.getTime() < dia.getTime()) {
    throw new BadRequestException(
      `La cuenta de ${p.nombre} está conciliada hasta el ${dia.toLocaleDateString('es-AR')}: ${que} con fecha anterior `
      + 'cambiaría un saldo que ya se cuadró con el proveedor. Si hace falta, primero quitá la conciliación en su estado de cuenta.',
    );
  }
}
