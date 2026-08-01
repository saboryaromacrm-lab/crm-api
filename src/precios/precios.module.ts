/**
 * ACTUALIZACIÓN DE COSTOS Y MÁRGENES
 * ============================================================================
 * En este sistema **el precio de venta no se edita**: se deriva.
 *
 *     costoNeto = costo × (1 − descuento%) × (1 + flete%)
 *     precio    = costoNeto × (1 + ganancia%)
 *
 * Así que "actualizar precios" es mover una de esas palancas. Y no todas son
 * iguales: **costo, descuento y flete son del proveedor** (los cambia él);
 * **la ganancia es una decisión propia** y es transversal a los proveedores.
 * Por eso la UI las separa y este módulo también.
 *
 * Acá NO hay endpoint de simulación: el frontend ya tiene costos y márgenes en
 * memoria, así que previsualiza sin tocar la red. El servidor solo recibe los
 * cambios ya aprobados y los aplica en un único UPDATE.
 *
 * Todo cambio de costo queda registrado en `producto_proveedor_costos`, lo que
 * habilita la auditoría y el **deshacer por lote**.
 */
import {
  Body, Controller, Get, Inject, Injectable, Module, BadRequestException, Param, Post, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, ValidateNested,
} from 'class-validator';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  productoProveedorCostos, productoProveedores, productos, proveedores, usuarios,
} from '../db/schema';

const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

class CambioCostoDto {
  /** id de `producto_proveedores`. */
  @IsInt() id!: number;
  @IsOptional() @IsNumber() costo?: number;
  @IsOptional() @IsNumber() descuento?: number;
  @IsOptional() @IsNumber() flete?: number;
}

class ActualizarCostosDto {
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => CambioCostoDto)
  cambios!: CambioCostoDto[];
  @IsOptional() @IsIn(['manual', 'masiva', 'recepcion']) origen?: 'manual' | 'masiva' | 'recepcion';
  @IsOptional() @IsString() motivo?: string;
  @IsOptional() @IsInt() usuarioId?: number;
}

class CambioMargenDto {
  @IsInt() id!: number;
  @IsNumber() valor!: number;
}

class ActualizarMargenesDto {
  /** 'ganancia_lista' toca `listas_precio.ganancia`; el otro, `presentaciones.recargo`. */
  @IsIn(['ganancia_lista', 'ganancia_presentacion']) tipo!: 'ganancia_lista' | 'ganancia_presentacion';
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => CambioMargenDto)
  cambios!: CambioMargenDto[];
}

@Injectable()
export class PreciosService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /* ------------------------------ Costos ------------------------------ */

  /**
   * Aplica cambios de costo/descuento/flete y deja el rastro.
   *
   * Corre en una transacción y en dos pasos: un UPDATE masivo con VALUES (no
   * uno por fila: actualizar 800 costos no puede ser 800 viajes) y un INSERT
   * con el historial. Devuelve el `lote`, que es lo que después permite
   * deshacer la tanda entera.
   */
  async actualizarCostos(dto: ActualizarCostosDto, tx?: any) {
    const ejecutar = async (db: any) => {
      const ids = [...new Set(dto.cambios.map((c) => c.id))];
      if (!ids.length) throw new BadRequestException('No hay cambios para aplicar.');
      if (ids.length > 5000) throw new BadRequestException('Demasiadas filas en una sola actualización (máximo 5000).');

      const actuales = await db.select().from(productoProveedores).where(inArray(productoProveedores.id, ids));
      const porId = new Map(actuales.map((e: any) => [e.id, e]));

      /** Estado final de cada entrada: lo que no viene en el cambio no se toca. */
      const finales = dto.cambios
        .map((c) => {
          const a: any = porId.get(c.id);
          if (!a) return null;
          const nuevo = {
            id: c.id,
            costo: money(Math.max(0, c.costo ?? a.costo)),
            descuento: money(Math.max(0, c.descuento ?? a.descuento)),
            flete: money(Math.max(0, c.flete ?? a.flete)),
          };
          const sinCambio = Math.abs(nuevo.costo - a.costo) < 0.005
            && Math.abs(nuevo.descuento - a.descuento) < 0.005
            && Math.abs(nuevo.flete - a.flete) < 0.005;
          return sinCambio ? null : { nuevo, anterior: a };
        })
        .filter(Boolean) as { nuevo: any; anterior: any }[];

      if (!finales.length) return { ok: true, actualizados: 0, lote: '' };

      const valores = sql.join(
        finales.map(({ nuevo }) => sql`(${nuevo.id}::int, ${nuevo.costo}::double precision, ${nuevo.descuento}::double precision, ${nuevo.flete}::double precision)`),
        sql`, `,
      );
      await db.execute(sql`
        UPDATE producto_proveedores AS t
        SET costo = v.costo, descuento = v.descuento, flete = v.flete
        FROM (VALUES ${valores}) AS v(id, costo, descuento, flete)
        WHERE t.id = v.id
      `);

      const lote = `L${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      await db.insert(productoProveedorCostos).values(finales.map(({ nuevo, anterior }) => ({
        productoProveedorId: nuevo.id,
        costoAnterior: anterior.costo, descuentoAnterior: anterior.descuento, fleteAnterior: anterior.flete,
        costo: nuevo.costo, descuento: nuevo.descuento, flete: nuevo.flete,
        origen: (dto.origen ?? 'manual') as any,
        motivo: dto.motivo ?? '',
        lote,
        usuarioId: dto.usuarioId ?? null,
        comprobanteId: (dto as any).comprobanteId ?? null,
      })));

      return { ok: true, actualizados: finales.length, lote };
    };

    // Si viene `tx`, corre dentro de la transacción del llamador (recepción de
    // comprobante): el costo y el comprobante se guardan juntos o no se guarda nada.
    return tx ? ejecutar(tx) : this.db.transaction(ejecutar);
  }

  /* ------------------------------ Márgenes ------------------------------ */

  /** Los márgenes no llevan historial: son decisión propia y siempre reversibles a mano. */
  async actualizarMargenes(dto: ActualizarMargenesDto) {
    const tabla = dto.tipo === 'ganancia_lista' ? 'listas_precio' : 'presentaciones';
    const columna = dto.tipo === 'ganancia_lista' ? 'ganancia' : 'recargo';

    const cambios = dto.cambios.filter((c) => Number.isInteger(c.id) && Number.isFinite(c.valor));
    if (!cambios.length) throw new BadRequestException('No hay cambios para aplicar.');
    if (cambios.length > 5000) throw new BadRequestException('Demasiadas filas en una sola actualización (máximo 5000).');

    const valores = sql.join(
      cambios.map((c) => sql`(${c.id}::int, ${money(Math.max(0, c.valor))}::double precision)`),
      sql`, `,
    );
    await this.db.execute(sql`
      UPDATE ${sql.raw(tabla)} AS t
      SET ${sql.raw(columna)} = v.valor
      FROM (VALUES ${valores}) AS v(id, valor)
      WHERE t.id = v.id
    `);
    return { ok: true, actualizados: cambios.length };
  }

  /* -------------------------- Proveedor activo -------------------------- */

  /**
   * Pasa el proveedor activo de varios productos y lo **audita en la misma
   * tabla que los costos**.
   *
   * El activo define qué costo manda el precio de venta, así que cambiarlo
   * mueve la góndola igual que un aumento. Si no quedara registrado, el
   * historial no podría explicar por qué cambió un precio.
   *
   * Salta los productos donde ese proveedor ya es el activo y los que no tienen
   * entrada de costo para él (no habría de dónde sacar el precio).
   */
  async activarProveedor(
    o: {
      productoIds: number[]; proveedorId: number;
      origen?: 'manual' | 'masiva' | 'recepcion'; motivo?: string;
      usuarioId?: number; comprobanteId?: number;
    },
    tx?: any,
  ) {
    const ejecutar = async (db: any) => {
      const ids = [...new Set(o.productoIds || [])].filter(Boolean);
      if (!ids.length) return { ok: true, activados: 0, lote: '' };

      const prods = await db.select().from(productos).where(inArray(productos.id, ids));
      const pendientes = prods.filter((p: any) => p.proveedorActivoId !== o.proveedorId);
      if (!pendientes.length) return { ok: true, activados: 0, lote: '' };

      // La fila de historial cuelga de la entrada producto/proveedor que pasa a mandar.
      const entradas = await db.select().from(productoProveedores).where(and(
        eq(productoProveedores.proveedorId, o.proveedorId),
        inArray(productoProveedores.productoId, pendientes.map((p: any) => p.id)),
      ));
      const entradaDe = new Map(entradas.map((e: any) => [e.productoId, e]));

      const aplicables = pendientes.filter((p: any) => entradaDe.has(p.id));
      if (!aplicables.length) return { ok: true, activados: 0, lote: '' };

      await db.update(productos)
        .set({ proveedorActivoId: o.proveedorId })
        .where(inArray(productos.id, aplicables.map((p: any) => p.id)));

      const lote = `A${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      await db.insert(productoProveedorCostos).values(aplicables.map((p: any) => {
        const e: any = entradaDe.get(p.id);
        return {
          productoProveedorId: e.id,
          // El costo no cambia acá: lo que cambia es CUÁL costo se usa.
          costoAnterior: e.costo, descuentoAnterior: e.descuento, fleteAnterior: e.flete,
          costo: e.costo, descuento: e.descuento, flete: e.flete,
          activoAnterior: p.proveedorActivoId ?? null,
          activoNuevo: o.proveedorId,
          origen: (o.origen ?? 'manual') as any,
          motivo: o.motivo ?? 'Cambio de proveedor activo',
          lote,
          usuarioId: o.usuarioId ?? null,
          comprobanteId: o.comprobanteId ?? null,
        };
      }));

      return { ok: true, activados: aplicables.length, lote };
    };
    return tx ? ejecutar(tx) : this.db.transaction(ejecutar);
  }

  /* ------------------------------ Auditoría ------------------------------ */

  /** Historial de costos con nombres resueltos, para leerlo sin cruzar tablas. */
  async historial(q: { productoId?: number; proveedorId?: number; lote?: string; limit?: number }) {
    const conds: any[] = [];
    if (q.productoId) conds.push(eq(productoProveedores.productoId, Number(q.productoId)));
    if (q.proveedorId) conds.push(eq(productoProveedores.proveedorId, Number(q.proveedorId)));
    if (q.lote) conds.push(eq(productoProveedorCostos.lote, q.lote));

    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    return this.db
      .select({
        id: productoProveedorCostos.id,
        fecha: productoProveedorCostos.fecha,
        lote: productoProveedorCostos.lote,
        origen: productoProveedorCostos.origen,
        motivo: productoProveedorCostos.motivo,
        comprobanteId: productoProveedorCostos.comprobanteId,
        productoProveedorId: productoProveedorCostos.productoProveedorId,
        costoAnterior: productoProveedorCostos.costoAnterior,
        descuentoAnterior: productoProveedorCostos.descuentoAnterior,
        fleteAnterior: productoProveedorCostos.fleteAnterior,
        costo: productoProveedorCostos.costo,
        descuento: productoProveedorCostos.descuento,
        flete: productoProveedorCostos.flete,
        activoAnterior: productoProveedorCostos.activoAnterior,
        activoNuevo: productoProveedorCostos.activoNuevo,
        productoId: productoProveedores.productoId,
        producto: productos.nombre,
        proveedor: proveedores.nombre,
        usuario: usuarios.nombre,
      })
      .from(productoProveedorCostos)
      .innerJoin(productoProveedores, eq(productoProveedores.id, productoProveedorCostos.productoProveedorId))
      .innerJoin(productos, eq(productos.id, productoProveedores.productoId))
      .innerJoin(proveedores, eq(proveedores.id, productoProveedores.proveedorId))
      .leftJoin(usuarios, eq(usuarios.id, productoProveedorCostos.usuarioId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(productoProveedorCostos.id))
      .limit(limit);
  }

  /**
   * Deshacer un lote: restaura los valores anteriores de cada fila.
   *
   * Se **saltea** las entradas cuyo valor vigente ya no coincide con lo que
   * dejó el lote: significa que alguien las volvió a cambiar después, y pisarlas
   * borraría ese cambio más nuevo sin avisar. Se informa cuáles quedaron afuera.
   *
   * La reversión no borra: agrega filas nuevas con origen `reversion`, así el
   * historial sigue siendo append-only y se puede leer qué pasó.
   */
  async revertirLote(lote: string, usuarioId?: number) {
    if (!lote) throw new BadRequestException('Indicá el lote a revertir.');

    return this.db.transaction(async (tx) => {
      const filas = await tx.select().from(productoProveedorCostos)
        .where(eq(productoProveedorCostos.lote, lote));
      if (!filas.length) throw new BadRequestException('No existe ese lote de actualización.');

      const ids = filas.map((f: any) => f.productoProveedorId);
      const actuales = await tx.select().from(productoProveedores).where(inArray(productoProveedores.id, ids));
      const porId = new Map(actuales.map((e: any) => [e.id, e]));

      // Productos involucrados, solo si el lote además cambió el proveedor activo.
      const prodIds = [...new Set(actuales.map((e: any) => e.productoId))];
      const prods = prodIds.length
        ? await tx.select().from(productos).where(inArray(productos.id, prodIds))
        : [];
      const prodPorId = new Map(prods.map((p: any) => [p.id, p]));

      const revertibles: any[] = [];
      const salteadas: any[] = [];
      for (const f of filas as any[]) {
        const a: any = porId.get(f.productoProveedorId);
        if (!a) { salteadas.push({ id: f.productoProveedorId, motivo: 'La entrada ya no existe.' }); continue; }
        const intacta = Math.abs(a.costo - f.costo) < 0.005
          && Math.abs(a.descuento - f.descuento) < 0.005
          && Math.abs(a.flete - f.flete) < 0.005;
        if (!intacta) { salteadas.push({ id: f.productoProveedorId, motivo: 'Cambió después de este lote.' }); continue; }

        // Si la fila cambió el proveedor activo, ese cambio también tiene que
        // seguir vigente; si no, revertirlo pisaría una decisión más nueva.
        const p: any = prodPorId.get(a.productoId);
        if (f.activoNuevo != null && p && p.proveedorActivoId !== f.activoNuevo) {
          salteadas.push({ id: f.productoProveedorId, motivo: 'El proveedor activo cambió después de este lote.' });
          continue;
        }
        revertibles.push({ f, a });
      }

      if (revertibles.length) {
        const valores = sql.join(
          revertibles.map(({ f }) => sql`(${f.productoProveedorId}::int, ${f.costoAnterior}::double precision, ${f.descuentoAnterior}::double precision, ${f.fleteAnterior}::double precision)`),
          sql`, `,
        );
        await tx.execute(sql`
          UPDATE producto_proveedores AS t
          SET costo = v.costo, descuento = v.descuento, flete = v.flete
          FROM (VALUES ${valores}) AS v(id, costo, descuento, flete)
          WHERE t.id = v.id
        `);

        // Los cambios de proveedor activo del lote también vuelven atrás.
        for (const { f, a } of revertibles) {
          if (f.activoNuevo == null) continue;
          await tx.update(productos)
            .set({ proveedorActivoId: f.activoAnterior ?? null })
            .where(eq(productos.id, a.productoId));
        }

        const nuevoLote = `R${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
        await tx.insert(productoProveedorCostos).values(revertibles.map(({ f, a }) => ({
          productoProveedorId: f.productoProveedorId,
          costoAnterior: a.costo, descuentoAnterior: a.descuento, fleteAnterior: a.flete,
          costo: f.costoAnterior, descuento: f.descuentoAnterior, flete: f.fleteAnterior,
          // Invertidos: esta fila deshace lo que hizo la original.
          activoAnterior: f.activoNuevo ?? null,
          activoNuevo: f.activoNuevo != null ? (f.activoAnterior ?? null) : null,
          origen: 'reversion' as any,
          motivo: `Reversión del lote ${lote}`,
          lote: nuevoLote,
          usuarioId: usuarioId ?? null,
        })));
      }

      return { ok: true, revertidos: revertibles.length, salteados: salteadas };
    });
  }
}

@Controller('precios')
export class PreciosController {
  constructor(private readonly svc: PreciosService) {}

  @Get('historial')
  historial(
    @Query('productoId') productoId?: string,
    @Query('proveedorId') proveedorId?: string,
    @Query('lote') lote?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.historial({
      productoId: productoId ? Number(productoId) : undefined,
      proveedorId: proveedorId ? Number(proveedorId) : undefined,
      lote,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('costos') costos(@Body() dto: ActualizarCostosDto) { return this.svc.actualizarCostos(dto); }
  @Post('margenes') margenes(@Body() dto: ActualizarMargenesDto) { return this.svc.actualizarMargenes(dto); }
  @Post('revertir/:lote') revertir(@Param('lote') lote: string) { return this.svc.revertirLote(lote); }
}

@Module({
  controllers: [PreciosController],
  providers: [PreciosService],
  exports: [PreciosService],
})
export class PreciosModule {}
