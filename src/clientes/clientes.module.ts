/**
 * CLIENTES
 * ============================================================================
 * El cliente no es una agenda: concentra las reglas que el circuito de venta
 * consulta después (letra del comprobante, lista de precios, crédito).
 *
 * Dos invariantes que sostiene este módulo:
 *  1. Existe SIEMPRE un "Consumidor Final" genérico (el 95% de los tickets).
 *     Se autocrea; no se puede borrar ni desactivar.
 *  2. Un cliente con historial NUNCA se borra: baja lógica (`activo=false`).
 */
import {
  Body, Controller, Delete, Get, Inject, Injectable, Module, BadRequestException,
  NotFoundException, Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import {
  IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min,
} from 'class-validator';
import { and, eq, ne, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { Permiso } from '../auth/auth.decoradores';
import { clientes, cobranzas, presupuestos, ventas } from '../db/schema';

const COND_IVA = ['responsable_inscripto', 'monotributo', 'consumidor_final', 'exento', 'no_categorizado'] as const;
const TIPOS_DOC = ['cuit', 'cuil', 'dni', 'sin_identificar'] as const;

/** Longitud exigida por tipo de documento (0 = sin validación). */
const LARGO_DOC: Record<string, number> = { cuit: 11, cuil: 11, dni: 0, sin_identificar: 0 };

export class UpsertClienteDto {
  @IsString() @MaxLength(160) nombre!: string;
  @IsOptional() @IsString() @MaxLength(160) nombreFantasia?: string;
  @IsOptional() @IsIn(TIPOS_DOC as unknown as string[]) tipoDoc?: (typeof TIPOS_DOC)[number];
  @IsOptional() @IsString() numeroDoc?: string;
  @IsOptional() @IsIn(COND_IVA as unknown as string[]) condicionIva?: (typeof COND_IVA)[number];
  @IsOptional() @IsString() direccion?: string;
  @IsOptional() @IsString() localidad?: string;
  @IsOptional() @IsString() telefono?: string;
  @IsOptional() @IsString() email?: string;
  /* Tope 100: es un PORCENTAJE. Sin el `@Max` se podía dejar un cliente con
   * `descuento: 90` (o 900) y ese número se aplica solo a cada renglón que el
   * POS le carga, sin que nadie lo vuelva a mirar. */
  @IsOptional() @IsNumber() @Min(0) @Max(100) descuento?: number;
  @IsOptional() @IsInt() vendedorId?: number | null;
  @IsOptional() @IsInt() sucursalId?: number | null;
  @IsOptional() @IsBoolean() ctaCteHabilitada?: boolean;
  @IsOptional() @IsNumber() @Min(0) limiteCredito?: number;
  @IsOptional() @IsInt() @Min(0) diasPlazo?: number;
  @IsOptional() @IsString() observaciones?: string;
  @IsOptional() @IsBoolean() activo?: boolean;
}

/** Solo dígitos: el documento se guarda normalizado para poder compararlo. */
const soloDigitos = (v?: string) => (v ?? '').replace(/\D/g, '');

@Injectable()
export class ClientesService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /* ------------------------------ Lectura ------------------------------ */

  list(q: { activo?: boolean } = {}) {
    const where = q.activo === undefined ? undefined : eq(clientes.activo, q.activo);
    return this.db.select().from(clientes).where(where).orderBy(clientes.nombre);
  }

  async get(id: number) {
    const [c] = await this.db.select().from(clientes).where(eq(clientes.id, id)).limit(1);
    if (!c) throw new NotFoundException('Cliente inexistente.');
    return c;
  }

  /**
   * Consumidor Final genérico. Se autocrea la primera vez que se lo pide, así
   * el sistema es usable sin depender de que el seed haya corrido.
   */
  async consumidorFinal() {
    const [existente] = await this.db.select().from(clientes)
      .where(eq(clientes.esConsumidorFinal, true)).limit(1);
    if (existente) return existente;

    const [creado] = await this.db.insert(clientes).values({
      nombre: 'Consumidor Final',
      tipoDoc: 'sin_identificar',
      condicionIva: 'consumidor_final',
      esConsumidorFinal: true,
      ctaCteHabilitada: false,
    }).returning();
    return creado;
  }

  /* ------------------------------ Escritura ------------------------------ */

  /**
   * Un mismo CUIT/DNI cargado dos veces termina en dos cuentas corrientes
   * paralelas, así que se rechaza acá y no en un índice (mejor mensaje).
   */
  private async validarDocumento(dto: UpsertClienteDto, excluirId?: number) {
    const tipoDoc = dto.tipoDoc ?? 'dni';
    const numeroDoc = soloDigitos(dto.numeroDoc);
    if (!numeroDoc) return { tipoDoc, numeroDoc: '' };

    const largo = LARGO_DOC[tipoDoc] ?? 0;
    if (largo && numeroDoc.length !== largo) {
      throw new BadRequestException(`El ${tipoDoc.toUpperCase()} debe tener ${largo} dígitos.`);
    }

    const dup = await this.db.select({ id: clientes.id, nombre: clientes.nombre }).from(clientes)
      .where(and(
        eq(clientes.tipoDoc, tipoDoc),
        eq(clientes.numeroDoc, numeroDoc),
        excluirId ? ne(clientes.id, excluirId) : undefined,
      ))
      .limit(1);
    if (dup[0]) throw new BadRequestException(`Ese documento ya está registrado en "${dup[0].nombre}".`);

    return { tipoDoc, numeroDoc };
  }

  /** Campos comunes de alta y edición (el documento llega ya validado). */
  private valores(dto: UpsertClienteDto, doc: { tipoDoc: string; numeroDoc: string }) {
    return {
      nombre: dto.nombre.trim(),
      nombreFantasia: (dto.nombreFantasia ?? '').trim(),
      tipoDoc: doc.tipoDoc as (typeof TIPOS_DOC)[number],
      numeroDoc: doc.numeroDoc,
      condicionIva: (dto.condicionIva ?? 'consumidor_final') as (typeof COND_IVA)[number],
      direccion: (dto.direccion ?? '').trim(),
      localidad: (dto.localidad ?? '').trim(),
      telefono: (dto.telefono ?? '').trim(),
      email: (dto.email ?? '').trim(),
      descuento: Number(dto.descuento) || 0,
      vendedorId: dto.vendedorId ?? null,
      sucursalId: dto.sucursalId ?? null,
      ctaCteHabilitada: !!dto.ctaCteHabilitada,
      limiteCredito: Number(dto.limiteCredito) || 0,
      diasPlazo: Number(dto.diasPlazo) || 0,
      observaciones: (dto.observaciones ?? '').trim(),
    };
  }

  async create(dto: UpsertClienteDto) {
    if (!dto.nombre?.trim()) throw new BadRequestException('Ingresá el nombre o razón social.');
    const doc = await this.validarDocumento(dto);
    const [c] = await this.db.insert(clientes)
      .values({ ...this.valores(dto, doc), activo: dto.activo ?? true })
      .returning();
    return c;
  }

  async update(id: number, dto: UpsertClienteDto) {
    const actual = await this.get(id);
    if (!dto.nombre?.trim()) throw new BadRequestException('Ingresá el nombre o razón social.');

    const doc = await this.validarDocumento(dto, id);
    const values: Record<string, any> = { ...this.valores(dto, doc), activo: dto.activo ?? actual.activo };

    // El Consumidor Final es un cliente del sistema: no se le cambia lo fiscal
    // ni se lo desactiva, porque el punto de venta siempre tiene que encontrarlo.
    if (actual.esConsumidorFinal) {
      values.tipoDoc = actual.tipoDoc;
      values.numeroDoc = actual.numeroDoc;
      values.condicionIva = actual.condicionIva;
      values.activo = true;
    }

    const [c] = await this.db.update(clientes).set(values).where(eq(clientes.id, id)).returning();
    return c;
  }

  /**
   * Cuántos documentos referencian al cliente (define si se puede borrar).
   *
   * Los TRES que tienen FK `restrict` contra clientes, no dos: faltaba
   * presupuestos, así que un cliente con presupuestos y sin ventas caía en el
   * `delete` de abajo y explotaba con un error de clave ajena crudo en vez de
   * hacer la baja lógica que este comentario promete.
   */
  private async usos(id: number) {
    const [v] = await this.db.select({ n: sql<number>`count(*)::int` }).from(ventas).where(eq(ventas.clienteId, id));
    const [c] = await this.db.select({ n: sql<number>`count(*)::int` }).from(cobranzas).where(eq(cobranzas.clienteId, id));
    const [p] = await this.db.select({ n: sql<number>`count(*)::int` }).from(presupuestos).where(eq(presupuestos.clienteId, id));
    return (v?.n ?? 0) + (c?.n ?? 0) + (p?.n ?? 0);
  }

  /**
   * Baja: si tiene historial se desactiva (el pasado no se toca); si no, se
   * borra de verdad para no dejar basura de altas equivocadas.
   */
  async remove(id: number) {
    const c = await this.get(id);
    if (c.esConsumidorFinal) throw new BadRequestException('El Consumidor Final no se puede eliminar.');

    if (await this.usos(id)) {
      await this.db.update(clientes).set({ activo: false }).where(eq(clientes.id, id));
      return { ok: true, desactivado: true };
    }
    await this.db.delete(clientes).where(eq(clientes.id, id));
    return { ok: true, desactivado: false };
  }

  async reactivar(id: number) {
    await this.get(id);
    const [c] = await this.db.update(clientes).set({ activo: true }).where(eq(clientes.id, id)).returning();
    return c;
  }
}

/**
 * Las ESCRITURAS piden `ventas.clientes`; las lecturas quedan abiertas a sesión
 * válida porque el padrón lo consumen el POS, los presupuestos y la tienda.
 *
 * Sin esto, cualquier sesión podía habilitar cuenta corriente y poner un límite
 * de crédito de siete cifras — que es la precondición cómoda para vender a
 * cuenta corriente sin que ningún control salte.
 */
@Controller('clientes')
export class ClientesController {
  constructor(private readonly svc: ClientesService) {}

  @Get() list(@Query('activo') activo?: string) {
    return this.svc.list({ activo: activo === undefined ? undefined : activo === 'true' });
  }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }

  @Post() @Permiso('ventas.clientes')
  create(@Body() dto: UpsertClienteDto) { return this.svc.create(dto); }

  @Patch(':id') @Permiso('ventas.clientes')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpsertClienteDto) { return this.svc.update(id, dto); }

  @Post(':id/reactivar') @Permiso('ventas.clientes')
  reactivar(@Param('id', ParseIntPipe) id: number) { return this.svc.reactivar(id); }

  @Delete(':id') @Permiso('ventas.clientes')
  remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }
}

@Module({
  controllers: [ClientesController],
  providers: [ClientesService],
  exports: [ClientesService],
})
export class ClientesModule {}
