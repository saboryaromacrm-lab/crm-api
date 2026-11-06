/**
 * EL PERSONAL, PARA LOS ADELANTOS DE SUELDO (0221, 6/11/2026, pedido del dueño).
 *
 * Una sola lista de empleados (`personal`): los usuarios del ERP marcados «es
 * empleado» y los que no usan el sistema (solo el nombre, se cargan en
 * Gerencia › Usuarios › Empleados). Un egreso con concepto de ADELANTO, en la
 * caja central o en la de un local, exige elegir a uno de esta lista: queda su
 * `personal_id` y su nombre adelante del detalle («Sofía · semana 2»), así se
 * lee en todos los listados y la app de sueldos sabe de quién es.
 */
import { BadRequestException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Database } from '../db/drizzle';
import { personal } from '../db/schema';
import { esConceptoAdelanto } from '../cashflow/conceptos';

export type Empleado = { id: number; nombre: string; usuarioId: number | null };

/** Los empleados que se pueden elegir hoy (activos, y si usan el sistema, con el usuario activo). Con `id`, solo ese. */
export async function empleadosVigentes(db: Pick<Database, 'execute'>, id?: number): Promise<Empleado[]> {
  const r: any = await db.execute(sql`
    select p.id, coalesce(u.nombre, p.nombre) as nombre, p.usuario_id
    from personal p left join usuarios u on u.id = p.usuario_id
    where p.activo and (p.usuario_id is null or u.activo) ${id == null ? sql`` : sql`and p.id = ${id}`}
    order by lower(coalesce(u.nombre, p.nombre))`);
  return (r.rows as any[]).map((x) => ({ id: Number(x.id), nombre: String(x.nombre), usuarioId: x.usuario_id == null ? null : Number(x.usuario_id) }));
}

/**
 * El empleado del movimiento. Con un concepto de adelanto es obligatorio y su
 * nombre va adelante del detalle; con cualquier otro concepto no se guarda.
 */
export async function empleadoDelMovimiento(
  db: Pick<Database, 'execute'>, c: { nombre: string; tipo: string }, personalId: unknown, detalle: string,
): Promise<{ personalId: number | null; detalle: string }> {
  if (!esConceptoAdelanto(c)) return { personalId: null, detalle };
  const id = Number(personalId);
  const [e] = Number.isInteger(id) && id > 0 ? await empleadosVigentes(db, id) : [];
  if (!e) throw new BadRequestException(`«${c.nombre}» es un adelanto de sueldo: elegí a qué empleado se le dio.`);
  return { personalId: e.id, detalle: detalle ? `${e.nombre} · ${detalle}` : e.nombre };
}

/** Marca (o desmarca) a un usuario del ERP como empleado: su fila del personal se crea o se activa/desactiva. */
export async function marcarEmpleado(db: Pick<Database, 'insert'>, usuarioId: number, es: boolean) {
  await db.insert(personal).values({ usuarioId, activo: es })
    .onConflictDoUpdate({ target: personal.usuarioId, set: { activo: es } });
}
