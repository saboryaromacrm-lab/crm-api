/**
 * AUDITORÍA DE CAMBIOS (0086)
 * ============================================================================
 * El registro de "quién cambió qué y cuándo, antes → después" para lo que se
 * pisa en el lugar y no deja documento. Los comprobantes, pagos y anulaciones
 * ya quedan firmados en sus propias tablas — esto cubre lo otro: los cambios
 * A MANO de condiciones que arrastran costos y precios sin que nadie firme.
 *
 * EL MECANISMO ES UNO Y GENERAL (entidad + entidadId), no "de proveedores":
 * hoy escriben las condiciones comerciales del proveedor (formato de compra,
 * percepciones, ficha comercial) y lo lee la pestaña Auditoría de su modal;
 * el día que Gerencia › Auditoría se construya, lee ESTA misma tabla sin
 * migrar nada.
 *
 * Reglas de escritura:
 *   - una fila por CAMPO cambiado — nunca "se guardó el formulario";
 *   - solo lo que cambió de verdad (guardar sin tocar no ensucia el registro);
 *   - dentro de la MISMA transacción que el cambio cuando la hay: un registro
 *     que puede quedar sin su cambio (o al revés) miente.
 */
import {
  BadRequestException, Controller, Get, Inject, Injectable, Module, Query,
} from '@nestjs/common';
import { desc, eq, and, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { Permiso } from '../auth/auth.decoradores';
import { auditoria, usuarios } from '../db/schema';

/** Un cambio puntual: el campo y sus dos valores. Todo texto: es para leer. */
export interface CambioAuditado {
  entidad: string;
  entidadId: number;
  ambito: string;
  detalle?: string;
  campo: string;
  antes?: string;
  despues?: string;
  usuarioId?: number | null;
}

@Injectable()
export class AuditoriaService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Graba una tanda de cambios. `tx` opcional: si el cambio corre en una
   * transacción, el registro viaja adentro — se confirman o se caen juntos.
   */
  async registrar(cambios: CambioAuditado[], tx?: any) {
    const filas = (cambios || []).filter((c) => c && c.campo);
    if (!filas.length) return;
    await (tx ?? this.db).insert(auditoria).values(filas.map((c) => ({
      usuarioId: c.usuarioId ?? null,
      entidad: c.entidad,
      entidadId: c.entidadId,
      ambito: c.ambito,
      detalle: (c.detalle ?? '').slice(0, 200),
      campo: c.campo.slice(0, 120),
      antes: String(c.antes ?? '').slice(0, 300),
      despues: String(c.despues ?? '').slice(0, 300),
    })));
  }

  /**
   * Compara dos objetos campo a campo con etiquetas legibles y devuelve los
   * cambios listos para `registrar`. `campos` mapea clave → etiqueta, y los
   * valores se comparan como TEXTO ya formateado por el llamador.
   */
  diferencias(
    base: Omit<CambioAuditado, 'campo' | 'antes' | 'despues'>,
    antes: Record<string, string>,
    despues: Record<string, string>,
    campos: Record<string, string>,
  ): CambioAuditado[] {
    const out: CambioAuditado[] = [];
    for (const [clave, etiqueta] of Object.entries(campos)) {
      const a = antes[clave] ?? '';
      const d = despues[clave] ?? '';
      if (a !== d) out.push({ ...base, campo: etiqueta, antes: a, despues: d });
    }
    return out;
  }

  async list(q: { entidad: string; entidadId: number; limit?: number }) {
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    return this.db
      .select({
        id: auditoria.id,
        fecha: auditoria.fecha,
        ambito: auditoria.ambito,
        detalle: auditoria.detalle,
        campo: auditoria.campo,
        antes: auditoria.antes,
        despues: auditoria.despues,
        usuario: sql<string>`coalesce(${usuarios.nombre}, '')`,
      })
      .from(auditoria)
      .leftJoin(usuarios, eq(usuarios.id, auditoria.usuarioId))
      .where(and(eq(auditoria.entidad, q.entidad), eq(auditoria.entidadId, q.entidadId)))
      .orderBy(desc(auditoria.id))
      .limit(limit);
  }
}

@Controller('auditoria')
export class AuditoriaController {
  constructor(private readonly svc: AuditoriaService) {}

  /*
   * Por ahora la única entidad consultable es el proveedor, y el permiso es el
   * de quienes lo administran (las mismas tres llaves que sus escrituras).
   * Cuando se sume otra entidad, su permiso se resuelve acá por entidad — no
   * abrir el endpoint entero "porque ya existía".
   */
  @Get() @Permiso('compras.proveedores', 'gastos.proveedores', 'proveedores.padron')
  list(@Query('entidad') entidad?: string, @Query('entidadId') entidadId?: string, @Query('limit') limit?: string) {
    if (entidad !== 'proveedor') throw new BadRequestException('Entidad de auditoría desconocida.');
    const id = parseInt(entidadId ?? '', 10);
    if (!id) throw new BadRequestException('Falta entidadId.');
    return this.svc.list({ entidad, entidadId: id, limit: Number(limit) || undefined });
  }
}

@Module({
  controllers: [AuditoriaController],
  providers: [AuditoriaService],
  exports: [AuditoriaService],
})
export class AuditoriaModule {}
