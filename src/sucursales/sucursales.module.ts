import {
  BadRequestException, Body, Controller, Delete, Get, Inject, Injectable, Module, NotFoundException,
  Param, ParseIntPipe, Patch, Post,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { and, eq, gt, ne, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { Permiso } from '../auth/auth.decoradores';
import { incidencias, stock, sucursales } from '../db/schema';

class UpsertSucursalDto {
  @IsString() @MaxLength(80) nombre!: string;
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

  /**
   * BORRAR UNA SUCURSAL SE LLEVA SU STOCK POR CASCADA.
   *
   * `stock.sucursalId` e `incidencias.sucursalId` cuelgan con `on delete
   * cascade`, así que un `DELETE /sucursales/5` borraba **todas las existencias
   * y todas las incidencias de ese local**, sin un solo movimiento, sin log y
   * sin vuelta atrás. Las sucursales viejas hoy zafan de casualidad, por las FK
   * `restrict` de ventas, cajas y transferencias; una sucursal nueva —o una de
   * sola recepción— no tiene ninguna de esas y se borraba entera.
   *
   * Ahora se corta antes: si hay una sola unidad en cualquier estado o una
   * incidencia abierta, no se borra. Lo que hay que hacer con un local que
   * cierra es vaciarlo por transferencia, que deja los movimientos.
   */
  async remove(id: number) {
    const s = await this.get(id);
    const [conStock] = await this.db.select({ n: sql<number>`count(*)` })
      .from(stock).where(and(eq(stock.sucursalId, id), gt(stock.cantidad, 0.000001)));
    if (Number(conStock?.n) > 0) {
      throw new BadRequestException(
        `${s.nombre} todavía tiene mercadería cargada. Transferila o dala de baja antes de borrar la sucursal: `
        + 'borrarla se llevaría su stock sin dejar ningún movimiento.',
      );
    }
    const [conInc] = await this.db.select({ n: sql<number>`count(*)` })
      .from(incidencias).where(and(eq(incidencias.sucursalId, id), ne(incidencias.estado, 'resuelta')));
    if (Number(conInc?.n) > 0) {
      throw new BadRequestException(`${s.nombre} tiene incidencias sin resolver: cerralas antes de borrarla.`);
    }
    await this.db.delete(sucursales).where(eq(sucursales.id, id));
    return { ok: true };
  }
}

/**
 * Las sucursales son estructura de la empresa: crearlas, renombrarlas y —sobre
 * todo— mover cuál es "la distribuidora" es una decisión de gerencia, no de
 * mostrador. Ese `tipo` no es una etiqueta: `distribuidoraId()` toma la primera
 * con `tipo='distribuidora'` y es el destino por defecto de toda compra y el
 * origen de todo envío a Cafetería, así que un `PATCH` lo redirigía en silencio.
 *
 * La LECTURA queda abierta a cualquier sesión: la pide el Topbar para el
 * selector, el login y media docena de pantallas de todos los módulos.
 */
@Controller('sucursales')
export class SucursalesController {
  constructor(private readonly svc: SucursalesService) {}
  @Get() list() { return this.svc.list(); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }

  @Post() @Permiso('gerencia.usuarios')
  create(@Body() dto: UpsertSucursalDto) { return this.svc.create(dto); }

  @Patch(':id') @Permiso('gerencia.usuarios')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpsertSucursalDto) { return this.svc.update(id, dto); }

  @Delete(':id') @Permiso('gerencia.usuarios')
  remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }
}

@Module({
  controllers: [SucursalesController],
  providers: [SucursalesService],
})
export class SucursalesModule {}
