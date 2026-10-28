/**
 * MIS CUENTAS (0207, 28/10/2026, pedido del dueño: «tengo varias cuentas
 * digitales, quiero elegir desde dónde sale el dinero»).
 *
 * Las cuentas propias de las que sale una transferencia (Mercado Pago, un
 * banco…). Las carga el superadmin en Gerencia › Cash Flow › Configuración;
 * las ve todo el que paga, para elegir.
 *
 * LA REGLA, en un solo lugar (`cuentaDeTransferencia`): con al menos una cuenta
 * activa, todo pago por transferencia dice de cuál salió — también cada parte
 * transferida de un pago mixto. Las demás formas no llevan cuenta: el efectivo
 * (y el efectivo por transferencia, que es efectivo nuestro) sale del cajón, el
 * depósito es efectivo que se lleva al banco y el echeq tiene su banco.
 */
import {
  BadRequestException, Body, ConflictException, Controller, Get, Inject, Injectable, NotFoundException, Param,
  ParseIntPipe, Patch, Post,
} from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { CualquierUsuario, Permiso } from '../auth/auth.decoradores';
import { PERMISO_CASHFLOW } from '../cashflow/a-controlar';
import { DRIZZLE, Database } from '../db/drizzle';
import { cuentasPropias } from '../db/schema';

const esUnico = (e: any) => e?.code === '23505' || e?.cause?.code === '23505';

export class CuentaPropiaDto {
  @IsOptional() @IsString() @MaxLength(60) nombre?: string;
  @IsOptional() @IsString() @MaxLength(120) detalle?: string;
  @IsOptional() @IsBoolean() activa?: boolean;
}

/**
 * De qué cuenta propia salió una transferencia: el id que se guarda en el pago
 * (o en la parte del pago mixto). No es transferencia, o es efectivo por
 * transferencia → null. Con cuentas cargadas, elegir una es obligatorio y tiene
 * que estar activa.
 */
export async function cuentaDeTransferencia(
  db: Pick<Database, 'select'>, medio: string, cuentaId?: number | null, cambioPor?: string | null,
): Promise<number | null> {
  if (medio !== 'transferencia' || cambioPor) return null;
  if (cuentaId) {
    const [c] = await db.select({ id: cuentasPropias.id }).from(cuentasPropias)
      .where(and(eq(cuentasPropias.id, cuentaId), eq(cuentasPropias.activa, true))).limit(1);
    if (!c) throw new BadRequestException('Esa cuenta no existe o está desactivada: elegí otra.');
    return c.id;
  }
  const [hay] = await db.select({ id: cuentasPropias.id }).from(cuentasPropias)
    .where(eq(cuentasPropias.activa, true)).limit(1);
  if (hay) throw new BadRequestException('Elegí de qué cuenta tuya salió la transferencia.');
  return null;
}

@Injectable()
export class CuentasPropiasService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Activas primero, por nombre; `usos` = pagos que salieron de cada una (de un solo medio o en partes). */
  listar() {
    return this.db.select({
      id: cuentasPropias.id, nombre: cuentasPropias.nombre, detalle: cuentasPropias.detalle, activa: cuentasPropias.activa,
      /* `cuentas_propias.id` escrito con la tabla: sin joins, drizzle pone «"id"» pelado y adentro
       * de la subconsulta se leía como el id del pago. */
      usos: sql<number>`(select count(*)::int from proveedor_pagos p where p.cuenta_propia_id = cuentas_propias.id)
        + (select count(*)::int from pago_formas f where f.cuenta_propia_id = cuentas_propias.id)`,
    }).from(cuentasPropias).orderBy(desc(cuentasPropias.activa), asc(cuentasPropias.nombre));
  }

  async crear(dto: CuentaPropiaDto) {
    return this.guardar(() => this.db.insert(cuentasPropias).values(this.validar(dto)).returning());
  }

  async editar(id: number, dto: CuentaPropiaDto) {
    const [actual] = await this.db.select().from(cuentasPropias).where(eq(cuentasPropias.id, id)).limit(1);
    if (!actual) throw new NotFoundException('Esa cuenta no existe.');
    return this.guardar(() => this.db.update(cuentasPropias).set(this.validar(dto, actual))
      .where(eq(cuentasPropias.id, id)).returning());
  }

  private validar(dto: CuentaPropiaDto, actual?: typeof cuentasPropias.$inferSelect) {
    const nombre = String(dto.nombre ?? actual?.nombre ?? '').trim().replace(/\s+/g, ' ');
    if (!nombre) throw new BadRequestException('La cuenta necesita un nombre (por ejemplo «Mercado Pago»).');
    return {
      nombre,
      detalle: String(dto.detalle ?? actual?.detalle ?? '').trim(),
      activa: dto.activa ?? actual?.activa ?? true,
    };
  }

  private async guardar(escribir: () => Promise<Array<typeof cuentasPropias.$inferSelect>>) {
    try {
      const [c] = await escribir();
      return c;
    } catch (e) {
      if (esUnico(e)) throw new ConflictException('Ya hay una cuenta con ese nombre.');
      throw e;
    }
  }
}

/** Leerlas, cualquiera que pague; cargarlas y cambiarlas, solo quien maneja el Cash Flow (el superadmin). */
@Controller('cuentas-propias')
export class CuentasPropiasController {
  constructor(private readonly svc: CuentasPropiasService) {}

  @Get() @CualquierUsuario() listar() { return this.svc.listar(); }
  @Post() @Permiso(PERMISO_CASHFLOW) crear(@Body() dto: CuentaPropiaDto) { return this.svc.crear(dto); }
  @Patch(':id') @Permiso(PERMISO_CASHFLOW) editar(@Param('id', ParseIntPipe) id: number, @Body() dto: CuentaPropiaDto) {
    return this.svc.editar(id, dto);
  }
}
