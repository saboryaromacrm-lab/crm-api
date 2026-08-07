import {
  BadRequestException, Body, Controller, Delete, Get, Inject, Injectable, Module,
  NotFoundException, Param, ParseIntPipe, Patch, Post, Put, Query,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { proveedorPercepciones, proveedores } from '../db/schema';

class UpsertProveedorDto {
  @IsString() nombre!: string;
  @IsOptional() @IsString() cuit?: string;
  /** Define si su factura discrimina IVA (de acá sale la alícuota por defecto). */
  @IsOptional() @IsIn(['responsable_inscripto', 'monotributo', 'consumidor_final', 'exento', 'no_categorizado'])
  condicionIva?: string;
  @IsOptional() @IsString() direccion?: string;
  @IsOptional() @IsString() telefono?: string;
  @IsOptional() @IsString() email?: string;
  /**
   * Clasificación, no permiso: en qué buscador aparece. Un proveedor puede ser
   * las dos cosas (el que trae mercadería y además te cobra el flete).
   */
  @IsOptional() @IsBoolean() proveeMercaderia?: boolean;
  @IsOptional() @IsBoolean() proveeGastos?: boolean;
}

@Injectable()
export class ProveedoresService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * `tipo` filtra por clasificación ('mercaderia' | 'gastos'); sin él vienen
   * todos. El filtro NO es excluyente: un proveedor marcado como los dos sale
   * en las dos listas, que es exactamente lo que se quiere.
   */
  list(tipo?: string) {
    const conds: any[] = [];
    if (tipo === 'mercaderia') conds.push(eq(proveedores.proveeMercaderia, true));
    if (tipo === 'gastos') conds.push(eq(proveedores.proveeGastos, true));
    return this.db.select().from(proveedores)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(proveedores.nombre);
  }

  async get(id: number) {
    const [p] = await this.db.select().from(proveedores).where(eq(proveedores.id, id)).limit(1);
    if (!p) throw new NotFoundException('Proveedor inexistente.');
    return p;
  }

  async create(dto: UpsertProveedorDto) {
    const [p] = await this.db.insert(proveedores).values({
      nombre: dto.nombre.trim(), cuit: dto.cuit ?? '', condicionIva: (dto.condicionIva ?? 'responsable_inscripto') as any, direccion: dto.direccion ?? '',
      telefono: dto.telefono ?? '', email: dto.email ?? '',
      // Sin indicar nada se asume el proveedor clásico: el que trae mercadería.
      proveeMercaderia: dto.proveeMercaderia ?? true,
      proveeGastos: dto.proveeGastos ?? false,
    }).returning();
    return p;
  }

  async update(id: number, dto: UpsertProveedorDto) {
    const actual = await this.get(id);
    const [p] = await this.db.update(proveedores).set({
      nombre: dto.nombre.trim(), cuit: dto.cuit ?? '', condicionIva: (dto.condicionIva ?? 'responsable_inscripto') as any, direccion: dto.direccion ?? '',
      telefono: dto.telefono ?? '', email: dto.email ?? '',
      // Un formulario viejo que no manda los flags no puede reclasificar al
      // proveedor sin querer: si no vienen, se conserva lo que ya tenía.
      proveeMercaderia: dto.proveeMercaderia ?? actual.proveeMercaderia,
      proveeGastos: dto.proveeGastos ?? actual.proveeGastos,
    }).where(eq(proveedores.id, id)).returning();
    return p;
  }

  async remove(id: number) {
    await this.get(id);
    // Los costos por proveedor se borran en cascada; el proveedor_activo_id queda en null.
    await this.db.delete(proveedores).where(eq(proveedores.id, id));
    return { ok: true };
  }

  /* ---------------------------- PERCEPCIONES ---------------------------- *
   * Las que ESTE proveedor suele cobrar. Se configuran una vez acá y después
   * la carga de la factura las ofrece con un tilde: el mismo proveedor a veces
   * las trae y a veces no, así que nunca se aplican solas.
   */
  percepciones(proveedorId: number) {
    return this.db.select().from(proveedorPercepciones)
      .where(eq(proveedorPercepciones.proveedorId, proveedorId))
      .orderBy(proveedorPercepciones.id);
  }

  /**
   * Reemplaza la lista completa (el formulario manda todas las filas juntas).
   * Se borra y se reinserta: las percepciones YA APLICADAS a un comprobante
   * tienen su propia copia con nombre y alícuota, así que tocar esta lista no
   * altera ninguna factura vieja.
   */
  async setPercepciones(proveedorId: number, filas: any[]) {
    await this.get(proveedorId);
    const validas = (filas || [])
      .filter((f) => (f?.nombre ?? '').trim())
      .map((f) => ({
        proveedorId,
        nombre: String(f.nombre).trim(),
        alicuota: Number(f.alicuota) || 0,
        base: (f.base === 'total' ? 'total' : 'neto') as 'neto' | 'total',
        activa: f.activa !== false,
      }));
    for (const f of validas) {
      if (f.alicuota < 0 || f.alicuota > 100) {
        throw new BadRequestException(`La alícuota de "${f.nombre}" tiene que estar entre 0 y 100.`);
      }
    }
    await this.db.transaction(async (tx) => {
      await tx.delete(proveedorPercepciones).where(eq(proveedorPercepciones.proveedorId, proveedorId));
      if (validas.length) await tx.insert(proveedorPercepciones).values(validas);
    });
    return this.percepciones(proveedorId);
  }
}

@Controller('proveedores')
export class ProveedoresController {
  constructor(private readonly svc: ProveedoresService) {}

  @Get() list(@Query('tipo') tipo?: string) { return this.svc.list(tipo); }
  @Get(':id/percepciones') percepciones(@Param('id', ParseIntPipe) id: number) {
    return this.svc.percepciones(id);
  }
  @Put(':id/percepciones') setPercepciones(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.setPercepciones(id, body?.percepciones ?? body);
  }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }
  @Post() create(@Body() dto: UpsertProveedorDto) { return this.svc.create(dto); }
  @Patch(':id') update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpsertProveedorDto) { return this.svc.update(id, dto); }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }
}

@Module({
  controllers: [ProveedoresController],
  providers: [ProveedoresService],
  exports: [ProveedoresService],
})
export class ProveedoresModule {}
