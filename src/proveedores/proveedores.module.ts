import {
  Body, Controller, Delete, Get, Inject, Injectable, Module, NotFoundException,
  Param, ParseIntPipe, Patch, Post,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { eq } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { proveedores } from '../db/schema';

class UpsertProveedorDto {
  @IsString() nombre!: string;
  @IsOptional() @IsString() cuit?: string;
  /** Define si su factura discrimina IVA (de acá sale la alícuota por defecto). */
  @IsOptional() @IsIn(['responsable_inscripto', 'monotributo', 'consumidor_final', 'exento', 'no_categorizado'])
  condicionIva?: string;
  @IsOptional() @IsString() direccion?: string;
  @IsOptional() @IsString() telefono?: string;
  @IsOptional() @IsString() email?: string;
}

@Injectable()
export class ProveedoresService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  list() {
    return this.db.select().from(proveedores).orderBy(proveedores.nombre);
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
    }).returning();
    return p;
  }

  async update(id: number, dto: UpsertProveedorDto) {
    await this.get(id);
    const [p] = await this.db.update(proveedores).set({
      nombre: dto.nombre.trim(), cuit: dto.cuit ?? '', condicionIva: (dto.condicionIva ?? 'responsable_inscripto') as any, direccion: dto.direccion ?? '',
      telefono: dto.telefono ?? '', email: dto.email ?? '',
    }).where(eq(proveedores.id, id)).returning();
    return p;
  }

  async remove(id: number) {
    await this.get(id);
    // Los costos por proveedor se borran en cascada; el proveedor_activo_id queda en null.
    await this.db.delete(proveedores).where(eq(proveedores.id, id));
    return { ok: true };
  }
}

@Controller('proveedores')
export class ProveedoresController {
  constructor(private readonly svc: ProveedoresService) {}

  @Get() list() { return this.svc.list(); }
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
