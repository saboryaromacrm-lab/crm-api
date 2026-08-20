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
  /** El punto de venta de ARCA de este local. Vacío = todavía no se cargó. */
  @IsOptional() @IsString() @MaxLength(5) puntoVenta?: string;
  /** El domicilio comercial declarado para ese punto de venta. */
  @IsOptional() @IsString() @MaxLength(200) direccion?: string;
}

/**
 * CINCO DÍGITOS, y no reutiliza `normalizarPuntoVenta` de compras a propósito:
 * aquella normaliza a CUATRO y así están guardadas las facturas de proveedor
 * desde siempre — cambiarla dejaría de reconocer como duplicada una factura ya
 * cargada. Esta es para los NUESTROS, que nacen hoy y nacen de cinco.
 *
 * El vacío se respeta: es "todavía no cargado", no un cero.
 */
export const normalizarPuntoVentaFiscal = (v: unknown) => {
  const d = String(v ?? '').replace(/\D/g, '').replace(/^0+/, '');
  return d ? d.padStart(5, '0') : '';
};

@Injectable()
export class SucursalesService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  list() { return this.db.select().from(sucursales).orderBy(sucursales.id); }

  async get(id: number) {
    const [s] = await this.db.select().from(sucursales).where(eq(sucursales.id, id)).limit(1);
    if (!s) throw new NotFoundException('Sucursal inexistente.');
    return s;
  }

  /**
   * Lo que se guarda de una sucursal, con el punto de venta normalizado y el
   * candado contra el duplicado.
   *
   * EL DUPLICADO SE ATAJA ACÁ ADEMÁS DEL ÍNDICE porque el mensaje importa: dos
   * sucursales con el mismo punto de venta pedirían el mismo próximo número a
   * ARCA y se pisarían, y un error de índice único no explica nada de eso.
   */
  private async normalizar(dto: UpsertSucursalDto, idPropio?: number) {
    const puntoVenta = normalizarPuntoVentaFiscal(dto.puntoVenta);
    if (puntoVenta) {
      const dueño = await this.db.select({ id: sucursales.id, nombre: sucursales.nombre })
        .from(sucursales).where(eq(sucursales.puntoVenta, puntoVenta)).limit(1);
      if (dueño.length && dueño[0].id !== idPropio) {
        throw new BadRequestException(
          `El punto de venta ${puntoVenta} ya es el de ${dueño[0].nombre}. `
          + 'Cada local tiene el suyo: compartirlo haría que las dos sucursales le pidan '
          + 'el mismo número a ARCA y una de las dos rebote.',
        );
      }
    }
    return {
      nombre: dto.nombre.trim(),
      tipo: dto.tipo ?? ('express' as const),
      puntoVenta,
      direccion: (dto.direccion ?? '').trim(),
    };
  }

  async create(dto: UpsertSucursalDto) {
    const [s] = await this.db.insert(sucursales).values(await this.normalizar(dto)).returning();
    return s;
  }

  async update(id: number, dto: UpsertSucursalDto) {
    await this.get(id);
    const [s] = await this.db.update(sucursales)
      .set(await this.normalizar(dto, id)).where(eq(sucursales.id, id)).returning();
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
