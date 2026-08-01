import {
  Body, Controller, Delete, Get, Inject, Injectable, Module, NotFoundException,
  Param, ParseIntPipe, Patch, Post,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { eq } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { sucursales } from '../db/schema';

class UpsertSucursalDto {
  @IsString() nombre!: string;
  @IsOptional() @IsIn(['distribuidora', 'express']) tipo?: 'distribuidora' | 'express';
}

@Injectable()
export class SucursalesService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  list() { return this.db.select().from(sucursales).orderBy(sucursales.id); }

  async get(id: number) {
    const [s] = await this.db.select().from(sucursales).where(eq(sucursales.id, id)).limit(1);
    if (!s) throw new NotFoundException('Sucursal inexistente.');
    return s;
  }

  async create(dto: UpsertSucursalDto) {
    const [s] = await this.db.insert(sucursales).values({ nombre: dto.nombre.trim(), tipo: dto.tipo ?? 'express' }).returning();
    return s;
  }

  async update(id: number, dto: UpsertSucursalDto) {
    await this.get(id);
    const [s] = await this.db.update(sucursales).set({ nombre: dto.nombre.trim(), tipo: dto.tipo ?? 'express' }).where(eq(sucursales.id, id)).returning();
    return s;
  }

  async remove(id: number) {
    await this.get(id);
    await this.db.delete(sucursales).where(eq(sucursales.id, id));
    return { ok: true };
  }
}

@Controller('sucursales')
export class SucursalesController {
  constructor(private readonly svc: SucursalesService) {}
  @Get() list() { return this.svc.list(); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }
  @Post() create(@Body() dto: UpsertSucursalDto) { return this.svc.create(dto); }
  @Patch(':id') update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpsertSucursalDto) { return this.svc.update(id, dto); }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }
}

@Module({
  controllers: [SucursalesController],
  providers: [SucursalesService],
})
export class SucursalesModule {}
