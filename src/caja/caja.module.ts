/**
 * CAJA — turnos del punto de venta
 * ============================================================================
 * Se modela ANTES que el ticket a propósito: un POS sin turno de caja no se
 * puede arquear, y arreglar eso después obliga a migrar datos.
 *
 * Invariantes:
 *  - Una sola sesión `abierta` por sucursal. Abrir con otra abierta es error.
 *  - El turno no se borra ni se reabre: se cierra con su arqueo y queda como
 *    registro. La diferencia (contado − sistema) se guarda tal cual, incluso
 *    negativa: ocultarla haría inútil el control.
 *  - Al cerrar se cuenta el EFECTIVO. Los demás medios se concilian por reporte
 *    contra el resumen del banco/posnet, así que se guardan como foto.
 */
import {
  Body, Controller, Get, Inject, Injectable, Module, BadRequestException,
  NotFoundException, Param, ParseIntPipe, Post, Query,
} from '@nestjs/common';
import { IsIn, IsInt, IsNumber, IsOptional, IsString } from 'class-validator';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  cajaControles, cajaMovimientos, cajaSesiones, cobranzaPagos, cobranzas, ventaPagos, ventas,
} from '../db/schema';

export const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

class AbrirCajaDto {
  @IsInt() sucursalId!: number;
  @IsOptional() @IsInt() usuarioId?: number;
  // Obligatorio: un turno SIEMPRE arranca declarando su fondo (ver `abrir`).
  @IsNumber() montoInicial!: number;
  @IsOptional() @IsString() observaciones?: string;
}

class CerrarCajaDto {
  @IsNumber() declaradoEfectivo!: number;
  @IsOptional() @IsString() observaciones?: string;
}

class ControlCajaDto {
  @IsNumber() contadoEfectivo!: number;
  @IsOptional() @IsString() observaciones?: string;
  @IsOptional() @IsInt() usuarioId?: number;
}

class MovimientoCajaDto {
  @IsIn(['ingreso', 'egreso']) tipo!: 'ingreso' | 'egreso';
  @IsNumber() importe!: number;
  @IsOptional() @IsString() motivo?: string;
  @IsOptional() @IsInt() usuarioId?: number;
}

@Injectable()
export class CajaService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /* ------------------------------ Lectura ------------------------------ */

  async get(id: number) {
    const c = await this.getOpcional(id);
    if (!c) throw new NotFoundException('Turno de caja inexistente.');
    return c;
  }

  /**
   * Igual que `get` pero devuelve `null` en vez de romper. Lo usa la venta: el
   * id de turno que manda el punto de venta puede haber quedado viejo (se cerró
   * la caja en otra pantalla, se resembró la base) y eso no debería hacer
   * fracasar un cobro — se recalcula por sucursal.
   */
  async getOpcional(id: number) {
    const [c] = await this.db.select().from(cajaSesiones).where(eq(cajaSesiones.id, id)).limit(1);
    return c ?? null;
  }

  /** Turno abierto de la sucursal, o `null` si no hay ninguno. */
  async actual(sucursalId: number) {
    const [c] = await this.db.select().from(cajaSesiones)
      .where(and(eq(cajaSesiones.sucursalId, sucursalId), eq(cajaSesiones.estado, 'abierta')))
      .limit(1);
    return c ?? null;
  }

  async list(q: { sucursalId?: number; estado?: string; limit?: number }) {
    const conds: any[] = [];
    if (q.sucursalId) conds.push(eq(cajaSesiones.sucursalId, Number(q.sucursalId)));
    if (q.estado) conds.push(eq(cajaSesiones.estado, q.estado as any));
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    return this.db.select().from(cajaSesiones)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(cajaSesiones.id))
      .limit(limit);
  }

  /**
   * Arqueo del turno: qué entró por cada medio y cuánto efectivo debería haber
   * en el cajón. Se calcula siempre en vivo (nunca se cachea) para que el
   * cajero vea el número real al momento de contar.
   */
  async arqueo(id: number) {
    const sesion = await this.get(id);

    const [porVenta, porCobranza, movs, controles] = await Promise.all([
      this.db.select({ medio: ventaPagos.medio, total: sql<number>`coalesce(sum(${ventaPagos.importe}), 0)` })
        .from(ventaPagos)
        .innerJoin(ventas, eq(ventas.id, ventaPagos.ventaId))
        .where(and(eq(ventas.cajaSesionId, id), eq(ventas.estado, 'confirmada')))
        .groupBy(ventaPagos.medio),
      this.db.select({ medio: cobranzaPagos.medio, total: sql<number>`coalesce(sum(${cobranzaPagos.importe}), 0)` })
        .from(cobranzaPagos)
        .innerJoin(cobranzas, eq(cobranzas.id, cobranzaPagos.cobranzaId))
        .where(and(eq(cobranzas.cajaSesionId, id), eq(cobranzas.estado, 'confirmada')))
        .groupBy(cobranzaPagos.medio),
      this.db.select().from(cajaMovimientos).where(eq(cajaMovimientos.cajaSesionId, id)).orderBy(cajaMovimientos.id),
      this.db.select().from(cajaControles).where(eq(cajaControles.cajaSesionId, id)).orderBy(cajaControles.id),
    ]);

    /** { efectivo: {ventas, cobranzas, total}, … } */
    const medios: Record<string, { ventas: number; cobranzas: number; total: number }> = {};
    const acumular = (filas: any[], campo: 'ventas' | 'cobranzas') => {
      for (const f of filas) {
        const m = (medios[f.medio] ??= { ventas: 0, cobranzas: 0, total: 0 });
        m[campo] = money(Number(f.total) || 0);
        m.total = money(m.ventas + m.cobranzas);
      }
    };
    acumular(porVenta, 'ventas');
    acumular(porCobranza, 'cobranzas');

    const ingresos = money(movs.filter((m) => m.tipo === 'ingreso').reduce((a, m) => a + m.importe, 0));
    const egresos = money(movs.filter((m) => m.tipo === 'egreso').reduce((a, m) => a + m.importe, 0));

    const efectivo = medios.efectivo ?? { ventas: 0, cobranzas: 0, total: 0 };
    const esperadoEfectivo = money(sesion.montoInicial + efectivo.total + ingresos - egresos);

    // Ventas en cuenta corriente: no entran a la caja, pero el cajero necesita verlas.
    const [ctaCte] = await this.db
      .select({ total: sql<number>`coalesce(sum(${ventas.total}), 0)`, n: sql<number>`count(*)::int` })
      .from(ventas)
      .where(and(
        eq(ventas.cajaSesionId, id), eq(ventas.estado, 'confirmada'),
        eq(ventas.condicionPago, 'cuenta_corriente'),
      ));

    return {
      sesion,
      medios,
      movimientos: movs,
      controles,
      ingresos,
      egresos,
      montoInicial: sesion.montoInicial,
      esperadoEfectivo,
      totalCobrado: money(Object.values(medios).reduce((a, m) => a + m.total, 0)),
      ctaCte: { total: money(Number(ctaCte?.total) || 0), cantidad: Number(ctaCte?.n) || 0 },
    };
  }

  /* ------------------------------ Escritura ------------------------------ */

  async abrir(dto: AbrirCajaDto) {
    const abierta = await this.actual(dto.sucursalId);
    if (abierta) {
      throw new BadRequestException('Ya hay un turno de caja abierto en esta sucursal. Cerralo antes de abrir otro.');
    }
    // El fondo inicial es OBLIGATORIO y positivo: un turno sin fondo declarado
    // no se puede arquear (no hay punto de partida contra el cual comparar).
    const montoInicial = money(dto.montoInicial);
    if (!(montoInicial > 0)) throw new BadRequestException('Declará el fondo inicial: la caja siempre arranca con un monto.');

    const [c] = await this.db.insert(cajaSesiones).values({
      sucursalId: dto.sucursalId,
      usuarioId: dto.usuarioId ?? null,
      montoInicial,
      estado: 'abierta',
      observaciones: dto.observaciones ?? '',
    }).returning();
    return c;
  }

  /**
   * Cerrar el turno: se cuenta el efectivo y el arqueo queda firmado.
   *
   * TODO ADENTRO DE UNA TRANSACCIÓN Y CON LA SESIÓN BLOQUEADA. El cierre son
   * tres pasos —leer que está abierta, sumar el arqueo, marcarla cerrada— y
   * entre el segundo y el tercero entraba plata: un pago a proveedor desde esta
   * caja, o un movimiento manual. Ese egreso quedaba adentro de un turno cerrado
   * pero **fuera de `sistemaEfectivo`**, así que la diferencia del arqueo nacía
   * mal y quedaba congelada en la fila: nadie se enteraba después.
   *
   * Las dos puertas que insertan movimientos (`movimiento` acá y `crear` de
   * pagos) ahora leen la sesión con el mismo candado, así que mientras el cierre
   * cuenta, ninguna puede confirmar: o entran antes y el arqueo las cuenta, o
   * esperan y se rechazan porque el turno ya cerró.
   *
   * `arqueo` sigue leyendo por fuera de la transacción a propósito: no necesita
   * el mismo snapshot, le alcanza con que nadie pueda confirmar un movimiento
   * nuevo mientras el candado está tomado.
   */
  async cerrar(id: number, dto: CerrarCajaDto) {
    const declarado = money(dto.declaradoEfectivo);

    return this.db.transaction(async (tx) => {
      const [sesion] = await tx.select().from(cajaSesiones)
        .where(eq(cajaSesiones.id, id)).limit(1).for('update');
      if (!sesion) throw new NotFoundException('Turno de caja inexistente.');
      if (sesion.estado === 'cerrada') throw new BadRequestException('El turno ya está cerrado.');

      const a = await this.arqueo(id);

      const [c] = await tx.update(cajaSesiones).set({
        cierre: new Date(),
        declaradoEfectivo: declarado,
        sistemaEfectivo: a.esperadoEfectivo,
        diferencia: money(declarado - a.esperadoEfectivo),
        totales: { medios: a.medios, ingresos: a.ingresos, egresos: a.egresos, ctaCte: a.ctaCte },
        estado: 'cerrada',
        observaciones: dto.observaciones ?? sesion.observaciones,
      }).where(eq(cajaSesiones.id, id)).returning();
      return c;
    });
  }

  /**
   * Control de caja intermedio: se cuenta el efectivo SIN cerrar el turno.
   * Guarda la foto (fecha/hora, esperado, contado, diferencia, quién) y nada
   * más — no mueve dinero ni cambia el estado. Es puro control entre arqueos.
   */
  async control(id: number, dto: ControlCajaDto) {
    const sesion = await this.get(id);
    if (sesion.estado !== 'abierta') throw new BadRequestException('El turno está cerrado: los controles son entre la apertura y el cierre.');
    const contado = money(dto.contadoEfectivo);
    if (contado < 0) throw new BadRequestException('El efectivo contado no puede ser negativo.');

    const a = await this.arqueo(id);
    const [c] = await this.db.insert(cajaControles).values({
      cajaSesionId: id,
      esperadoEfectivo: a.esperadoEfectivo,
      contadoEfectivo: contado,
      diferencia: money(contado - a.esperadoEfectivo),
      observaciones: (dto.observaciones ?? '').trim(),
      usuarioId: dto.usuarioId ?? null,
    }).returning();
    return c;
  }

  async movimiento(id: number, dto: MovimientoCajaDto) {
    const importe = money(dto.importe);
    if (importe <= 0) throw new BadRequestException('El importe debe ser mayor a 0.');
    if (!dto.motivo?.trim()) throw new BadRequestException('Indicá el motivo del movimiento.');

    return this.db.transaction(async (tx) => {
      /* Con candado y en la misma transacción que el insert: si el cierre está
       * corriendo, este movimiento espera y se rechaza en vez de entrar a un
       * turno cuyo arqueo ya se calculó sin él. Ver `cerrar`. */
      const [sesion] = await tx.select().from(cajaSesiones)
        .where(eq(cajaSesiones.id, id)).limit(1).for('update');
      if (!sesion) throw new NotFoundException('Turno de caja inexistente.');
      if (sesion.estado !== 'abierta') throw new BadRequestException('El turno está cerrado.');

      const [m] = await tx.insert(cajaMovimientos).values({
        cajaSesionId: id, tipo: dto.tipo, importe, motivo: dto.motivo!.trim(), usuarioId: dto.usuarioId ?? null,
      }).returning();
      return m;
    });
  }

  /**
   * Turno válido para operar en una sucursal. Lo usa la venta: si la caja es
   * obligatoria y no hay turno, la venta se rechaza acá y no a mitad de camino.
   */
  async exigirTurno(sucursalId: number, obligatoria: boolean) {
    const abierta = await this.actual(sucursalId);
    if (!abierta && obligatoria) {
      throw new BadRequestException('No hay un turno de caja abierto en esta sucursal. Abrí la caja para vender.');
    }
    return abierta;
  }
}

@Controller('caja')
export class CajaController {
  constructor(private readonly svc: CajaService) {}

  @Get('actual/:sucursalId')
  actual(@Param('sucursalId', ParseIntPipe) sucursalId: number) { return this.svc.actual(sucursalId); }

  @Get()
  list(@Query('sucursalId') sucursalId?: string, @Query('estado') estado?: string, @Query('limit') limit?: string) {
    return this.svc.list({
      sucursalId: sucursalId ? Number(sucursalId) : undefined,
      estado, limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(':id/arqueo') arqueo(@Param('id', ParseIntPipe) id: number) { return this.svc.arqueo(id); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }

  @Post('abrir') abrir(@Body() dto: AbrirCajaDto) { return this.svc.abrir(dto); }
  @Post(':id/cerrar') cerrar(@Param('id', ParseIntPipe) id: number, @Body() dto: CerrarCajaDto) { return this.svc.cerrar(id, dto); }
  @Post(':id/control') control(@Param('id', ParseIntPipe) id: number, @Body() dto: ControlCajaDto) { return this.svc.control(id, dto); }
  @Post(':id/movimiento') mov(@Param('id', ParseIntPipe) id: number, @Body() dto: MovimientoCajaDto) { return this.svc.movimiento(id, dto); }
}

@Module({
  controllers: [CajaController],
  providers: [CajaService],
  exports: [CajaService],
})
export class CajaModule {}
