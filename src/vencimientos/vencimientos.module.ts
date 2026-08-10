/**
 * VENCIMIENTOS — el vigía de fechas, sin lote.
 * ============================================================================
 * La lógica vino de la app externa de vencimientos (PHP/Hostinger) y el DATO
 * es 100% de este sistema: catálogo, sucursales, costos y usuarios reales.
 *
 * El modelo en tres actos:
 *
 *   1. CONTROL (sesión): alguien camina la góndola de una sucursal y anota
 *      "N unidades de X vencen tal día". El registro NO toca stock — es una
 *      lista de control con el costo CONGELADO del día (lección de cafetería:
 *      la pérdida de marzo no cambia en julio porque subió el catálogo).
 *   2. OFERTA: un registro por vencer puede armar una oferta REAL de Ventas
 *      (tipo porcentaje, alcance producto, vigente hasta la fecha del paquete,
 *      solo en su sucursal). Aplica en caja como cualquier oferta y queda
 *      vinculada (`ofertaId`).
 *   3. PROCESAR: cuando venció, se cierra el ciclo — cuántas unidades se
 *      salvaron vendiéndose y cuántas se perdieron. La pérdida REAL es
 *      costo × perdidas, y opcionalmente genera la baja de stock de verdad
 *      (movimiento 'vencido', disponible → estado vencido) EN LA MISMA
 *      transacción: o pasa todo, o no pasó nada.
 *
 * Los rangos de alerta son EXCLUYENTES (vencido / 0-7 / 8-15 / 16-30 / +30):
 * un registro vive en UNA sola tarjeta. Y los "días para vencer" se calculan
 * SIEMPRE contra el día de ARGENTINA (now() AT TIME ZONE), nunca contra
 * CURRENT_DATE del server en UTC — a la noche UTC ya es "mañana" y los
 * vencidos se adelantarían un día.
 */
import { Body, Controller, Delete, Get, Inject, Injectable, Module, Param, ParseIntPipe, Post, Put, Query, BadRequestException, NotFoundException } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty, IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, Matches, MaxLength, ValidateNested,
} from 'class-validator';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  categorias, movimientos, presentaciones, productoProveedores, productos, sucursales, usuarios,
  vencimientoSesiones, vencimientos,
} from '../db/schema';
import { InventarioModule } from '../inventario/inventario.module';
import { InventarioService } from '../inventario/inventario.service';
import { costoNetoEntry, formatoActivo } from '../inventario/pricing';
import { OfertasModule, OfertasService } from '../ofertas/ofertas.module';

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** Día "para vencer" contra el calendario argentino, no el UTC del server. */
const HOY_AR = sql`(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date`;
const DIAS = sql<number>`(${vencimientos.fechaVencimiento} - ${HOY_AR})`;

class ItemControlDto {
  @IsInt() productoId!: number;
  @IsOptional() @IsInt() presentacionId?: number;
  @IsNumber() cantidad!: number;
  /** La fecha impresa en el paquete. Puede ser pasada: registrar lo ya vencido vale. */
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) fechaVencimiento!: string;
  @IsOptional() @IsString() @MaxLength(300) observaciones?: string;
}

class CrearSesionDto {
  @IsInt() sucursalId!: number;
  @IsOptional() @IsInt() usuarioId?: number;
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => ItemControlDto)
  items!: ItemControlDto[];
}

class EditarVencimientoDto {
  @IsOptional() @IsNumber() cantidad?: number;
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) fechaVencimiento?: string;
  @IsOptional() @IsString() @MaxLength(300) observaciones?: string;
}

class ProcesarDto {
  @IsNumber() unidadesVendidas!: number;
  /** true = además genera la baja REAL de stock (movimiento 'vencido'). */
  @IsOptional() @IsBoolean() generarMerma?: boolean;
  @IsOptional() @IsInt() usuarioId?: number;
}

class ArmarOfertaDto {
  @IsNumber() porcentaje!: number;
  /** '' = todas las sucursales; por defecto, SOLO la del registro. */
  @IsOptional() @IsString() sucursales?: string;
  @IsOptional() @IsInt() usuarioId?: number;
}

@Injectable()
export class VencimientosService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly inv: InventarioService,
    private readonly ofertas: OfertasService,
  ) {}

  /* ---------------- Valuación (patrón cafetería, costo del formato activo) ---------------- */
  private async valuar(tx: any, items: { productoId: number; presentacionId?: number | null }[]) {
    const ids = [...new Set(items.map((it) => it.productoId))];
    const provs = await tx.select().from(productoProveedores)
      .where(inArray(productoProveedores.productoId, ids));
    const out = new Map<string, { prod: any; pres: any; costoU: number }>();
    for (const it of items) {
      const clave = `${it.productoId}-${it.presentacionId ?? 0}`;
      if (out.has(clave)) continue;
      const [prod] = await tx.select().from(productos).where(eq(productos.id, it.productoId)).limit(1);
      if (!prod) throw new BadRequestException('Producto inválido en el detalle.');
      let pres: any = null;
      if (it.presentacionId) {
        [pres] = await tx.select().from(presentaciones).where(eq(presentaciones.id, it.presentacionId)).limit(1);
        if (!pres || pres.productoId !== prod.id) throw new BadRequestException(`Presentación inválida para ${prod.nombre}.`);
      }
      const cnKg = costoNetoEntry(formatoActivo(provs.filter((p: any) => p.productoId === prod.id)) as any, prod.iva);
      out.set(clave, { prod, pres, costoU: pres ? cnKg * (pres.tamKg ?? 1) : cnKg });
    }
    return out;
  }

  /* ============================ EL CONTROL ============================ */
  async crearSesion(o: CrearSesionDto) {
    return this.db.transaction(async (tx) => {
      const [suc] = await tx.select().from(sucursales).where(eq(sucursales.id, o.sucursalId)).limit(1);
      if (!suc) throw new BadRequestException('Sucursal inválida.');
      for (const it of o.items) {
        if (!(Number(it.cantidad) > 0)) throw new BadRequestException('Todas las cantidades deben ser mayores a 0.');
        if (isNaN(new Date(`${it.fechaVencimiento}T00:00:00`).getTime())) {
          throw new BadRequestException('Fecha de vencimiento inválida.');
        }
      }
      const val = await this.valuar(tx, o.items);

      let unidades = 0;
      for (const it of o.items) unidades += Number(it.cantidad);
      const [sesion] = await tx.insert(vencimientoSesiones).values({
        sucursalId: o.sucursalId,
        usuarioId: o.usuarioId ?? null,
        totalItems: o.items.length,
        totalUnidades: unidades,
      }).returning();

      const filas = o.items.map((it) => {
        const { prod, pres, costoU } = val.get(`${it.productoId}-${it.presentacionId ?? 0}`)!;
        const esGranelSuelto = prod.tipo === 'granel' && !pres;
        const tam = pres ? (pres.tamKg < 1 ? `${Math.round(pres.tamKg * 1000)} g` : `${pres.tamKg} kg`) : '';
        return {
          productoId: prod.id,
          presentacionId: pres?.id ?? null,
          sucursalId: o.sucursalId,
          sesionId: sesion.id,
          fechaVencimiento: it.fechaVencimiento,
          cantidad: Number(it.cantidad),
          costoUnitario: costoU,
          nombre: pres ? `${prod.nombre} · ${tam}` : prod.nombre,
          unidad: esGranelSuelto ? 'kg' : (pres ? 'paq.' : 'u.'),
          codigoBarras: pres?.codigoBarras || prod.codigoBarras || '',
          observaciones: (it.observaciones ?? '').trim(),
          usuarioId: o.usuarioId ?? null,
        };
      });
      const regs = await tx.insert(vencimientos).values(filas).returning();
      return { sesionId: sesion.id, registros: regs.length, unidades: r2(unidades) };
    });
  }

  /* ============================ EL LISTADO ============================ */
  async list() {
    const rows = await this.db.select({
      v: vencimientos,
      diasParaVencer: DIAS,
    }).from(vencimientos)
      .orderBy(asc(vencimientos.fechaVencimiento), asc(vencimientos.id));
    return rows.map((r) => ({ ...r.v, diasParaVencer: Number(r.diasParaVencer) }));
  }

  async editar(id: number, o: EditarVencimientoDto) {
    const [reg] = await this.db.select().from(vencimientos).where(eq(vencimientos.id, id)).limit(1);
    if (!reg) throw new NotFoundException('Registro inexistente.');
    if (reg.procesado) throw new BadRequestException('Ya se procesó: el cierre no se edita.');
    const patch: any = {};
    if (o.cantidad !== undefined) {
      if (!(Number(o.cantidad) > 0)) throw new BadRequestException('La cantidad debe ser mayor a 0.');
      patch.cantidad = Number(o.cantidad);
    }
    if (o.fechaVencimiento !== undefined) patch.fechaVencimiento = o.fechaVencimiento;
    if (o.observaciones !== undefined) patch.observaciones = o.observaciones.trim();
    if (!Object.keys(patch).length) return reg;
    const [out] = await this.db.update(vencimientos).set(patch).where(eq(vencimientos.id, id)).returning();
    return out;
  }

  async eliminar(id: number) {
    const [reg] = await this.db.select().from(vencimientos).where(eq(vencimientos.id, id)).limit(1);
    if (!reg) throw new NotFoundException('Registro inexistente.');
    if (reg.procesado) throw new BadRequestException('Ya se procesó: dejó pérdida real asentada y no se borra.');
    await this.db.delete(vencimientos).where(eq(vencimientos.id, id));
    return { ok: true };
  }

  /* ============================ EL CIERRE ============================ */
  /**
   * Venció → se procesa: cuántas se salvaron vendiéndose y cuántas se
   * perdieron. `generarMerma` además baja el stock real (movimiento 'vencido')
   * en la MISMA transacción. El claim del registro va con FOR UPDATE: dos
   * personas procesando lo mismo, una sola gana.
   */
  async procesar(id: number, o: ProcesarDto) {
    return this.db.transaction(async (tx) => {
      const [reg] = await tx.select().from(vencimientos).where(eq(vencimientos.id, id)).limit(1).for('update');
      if (!reg) throw new NotFoundException('Registro inexistente.');
      if (reg.procesado) throw new BadRequestException('Ya estaba procesado.');
      const uv = Number(o.unidadesVendidas);
      if (!(uv >= 0)) throw new BadRequestException('Las unidades vendidas no pueden ser negativas.');
      if (uv > reg.cantidad + 1e-9) {
        throw new BadRequestException(`Las vendidas no pueden superar lo registrado (${reg.cantidad}).`);
      }
      const perdidas = r2(reg.cantidad - uv);

      let mermaMovimientoId: number | null = null;
      if (o.generarMerma && perdidas > 0) {
        const res = await this.inv.opSimpleTx(tx, {
          tipo: 'vencido',
          productoId: reg.productoId,
          presId: reg.presentacionId,
          sucursalId: reg.sucursalId,
          cantidad: perdidas,
          usuarioId: o.usuarioId ?? null,
          motivo: `Vencimiento #${reg.id} · vencía ${reg.fechaVencimiento}`,
        });
        mermaMovimientoId = res.movimiento?.id ?? null;
      }

      const [out] = await tx.update(vencimientos).set({
        procesado: true,
        unidadesVendidas: uv,
        procesadoEn: new Date(),
        mermaMovimientoId,
      }).where(eq(vencimientos.id, id)).returning();
      return { ...out, perdidas, perdidaReal: r2(perdidas * reg.costoUnitario) };
    });
  }

  /* ============================ LA OFERTA ============================ */
  /**
   * Arma una oferta REAL (Ventas › Ofertas, aplica en caja): porcentaje sobre
   * el producto, vigente hasta el día del vencimiento inclusive, por defecto
   * solo en la sucursal del registro. Si el vínculo no se puede asentar, la
   * oferta creada se borra — no quedan ofertas huérfanas.
   */
  async armarOferta(id: number, o: ArmarOfertaDto) {
    const [reg] = await this.db.select({ v: vencimientos, dias: DIAS })
      .from(vencimientos).where(eq(vencimientos.id, id)).limit(1);
    if (!reg) throw new NotFoundException('Registro inexistente.');
    const v = reg.v;
    if (v.procesado) throw new BadRequestException('Ya se procesó: la oferta llega tarde.');
    if (Number(reg.dias) < 0) throw new BadRequestException('Ya venció: no se ofrece mercadería vencida.');
    if (v.ofertaId) throw new BadRequestException('Este registro ya armó su oferta (mirala en Ventas › Ofertas).');
    const pct = Number(o.porcentaje);
    if (!(pct > 0 && pct < 100)) throw new BadRequestException('El porcentaje va entre 1 y 99.');

    const oferta = await this.ofertas.crear({
      nombre: `Por vencer · ${v.nombre}`,
      tipo: 'porcentaje',
      porcentaje: pct,
      hasta: `${v.fechaVencimiento}T23:59:59`,
      sucursales: o.sucursales !== undefined ? o.sucursales : String(v.sucursalId),
      activa: true,
      alcances: [{ tipo: 'producto', refId: v.productoId }],
    } as any);

    try {
      const [out] = await this.db.update(vencimientos).set({ ofertaId: oferta.id })
        .where(eq(vencimientos.id, id)).returning();
      return { registro: out, oferta };
    } catch (e) {
      // Compensación: sin vínculo asentado la oferta no debe quedar viva.
      await this.ofertas.borrar(oferta.id).catch(() => undefined);
      throw e;
    }
  }

  /* ============================ EL RESUMEN ============================ */
  /** Las tarjetas del panel: rangos EXCLUYENTES sobre lo abierto + el histórico procesado. */
  async resumen() {
    const abiertos = await this.db.select({
      rango: sql<string>`case
        when ${DIAS} < 0 then 'vencido'
        when ${DIAS} <= 7 then 'd7'
        when ${DIAS} <= 15 then 'd15'
        when ${DIAS} <= 30 then 'd30'
        else 'vigente' end`,
      n: sql<number>`count(*)::int`,
      unidades: sql<number>`coalesce(sum(${vencimientos.cantidad}), 0)`,
      plata: sql<number>`coalesce(sum(${vencimientos.cantidad} * ${vencimientos.costoUnitario}), 0)`,
    }).from(vencimientos)
      .where(eq(vencimientos.procesado, false))
      .groupBy(sql`1`);

    const [proc] = await this.db.select({
      n: sql<number>`count(*)::int`,
      vendidas: sql<number>`coalesce(sum(${vencimientos.unidadesVendidas}), 0)`,
      perdidas: sql<number>`coalesce(sum(${vencimientos.cantidad} - ${vencimientos.unidadesVendidas}), 0)`,
      perdidaReal: sql<number>`coalesce(sum((${vencimientos.cantidad} - ${vencimientos.unidadesVendidas}) * ${vencimientos.costoUnitario}), 0)`,
    }).from(vencimientos).where(eq(vencimientos.procesado, true));

    const ultimos = await this.db.select({ v: vencimientos, diasParaVencer: DIAS })
      .from(vencimientos).orderBy(desc(vencimientos.id)).limit(5);

    const base = { n: 0, unidades: 0, plata: 0 };
    const por = Object.fromEntries(abiertos.map((a) => [a.rango, {
      n: Number(a.n), unidades: r2(Number(a.unidades)), plata: r2(Number(a.plata)),
    }]));
    return {
      vencidos: por.vencido ?? base,
      d7: por.d7 ?? base,
      d15: por.d15 ?? base,
      d30: por.d30 ?? base,
      vigentes: por.vigente ?? base,
      procesados: {
        n: Number(proc?.n) || 0,
        vendidas: r2(Number(proc?.vendidas)),
        perdidas: r2(Number(proc?.perdidas)),
        perdidaReal: r2(Number(proc?.perdidaReal)),
      },
      ultimos: ultimos.map((u) => ({ ...u.v, diasParaVencer: Number(u.diasParaVencer) })),
    };
  }

  /* ============================ LOS REPORTES ============================ */
  /**
   * Todo el análisis del período en un viaje. Las mermas EXCLUYEN los
   * movimientos generados al procesar vencimientos (ya cuentan como pérdida
   * real del registro — sumarlos de nuevo duplicaría la plata).
   */
  async reportes(periodo: string) {
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const desde = new Date(hoy);
    if (periodo === 'semana') desde.setDate(desde.getDate() - 7);
    else if (periodo === 'trimestre') desde.setMonth(desde.getMonth() - 3);
    else if (periodo === 'anio') desde.setMonth(0, 1);
    else desde.setDate(1); // mes calendario (default)

    const enPeriodo = sql`${vencimientos.creadoEn} >= ${desde}`;
    const perdidaRealExpr = sql`(${vencimientos.cantidad} - ${vencimientos.unidadesVendidas}) * ${vencimientos.costoUnitario}`;

    const [general] = await this.db.select({
      registros: sql<number>`count(*)::int`,
      unidades: sql<number>`coalesce(sum(${vencimientos.cantidad}), 0)`,
      estimada: sql<number>`coalesce(sum(${vencimientos.cantidad} * ${vencimientos.costoUnitario}), 0)`,
      procesados: sql<number>`count(*) filter (where ${vencimientos.procesado})::int`,
      vendidas: sql<number>`coalesce(sum(${vencimientos.unidadesVendidas}) filter (where ${vencimientos.procesado}), 0)`,
      real: sql<number>`coalesce(sum(${perdidaRealExpr}) filter (where ${vencimientos.procesado}), 0)`,
    }).from(vencimientos).where(enPeriodo);

    // Mermas del período: merma + defectuoso + vencido SUELTO (no nacido de procesar).
    const noDeProcesar = sql`${movimientos.id} not in (select merma_movimiento_id from vencimientos where merma_movimiento_id is not null)`;
    const condMermas = and(
      inArray(movimientos.tipo, ['merma', 'defectuoso', 'vencido'] as any),
      sql`${movimientos.fecha} >= ${desde}`,
      noDeProcesar,
    );
    const [mermasG] = await this.db.select({
      registros: sql<number>`count(*)::int`,
      unidades: sql<number>`coalesce(sum(${movimientos.cantidad}), 0)`,
      plata: sql<number>`coalesce(sum(${movimientos.cantidad} * ${movimientos.costoUnitario}), 0)`,
    }).from(movimientos).where(condMermas);

    const porSucursalVenc = await this.db.select({
      sucursalId: vencimientos.sucursalId,
      registros: sql<number>`count(*)::int`,
      unidades: sql<number>`coalesce(sum(${vencimientos.cantidad}), 0)`,
      estimada: sql<number>`coalesce(sum(${vencimientos.cantidad} * ${vencimientos.costoUnitario}), 0)`,
      real: sql<number>`coalesce(sum(${perdidaRealExpr}) filter (where ${vencimientos.procesado}), 0)`,
    }).from(vencimientos).where(enPeriodo).groupBy(vencimientos.sucursalId);

    const porSucursalMerma = await this.db.select({
      sucursalId: movimientos.sucursalId,
      registros: sql<number>`count(*)::int`,
      plata: sql<number>`coalesce(sum(${movimientos.cantidad} * ${movimientos.costoUnitario}), 0)`,
    }).from(movimientos).where(condMermas).groupBy(movimientos.sucursalId);

    const porCategoria = await this.db.select({
      categoria: sql<string>`coalesce(${categorias.nombre}, 'Sin categoría')`,
      registros: sql<number>`count(*)::int`,
      unidades: sql<number>`coalesce(sum(${vencimientos.cantidad}), 0)`,
      estimada: sql<number>`coalesce(sum(${vencimientos.cantidad} * ${vencimientos.costoUnitario}), 0)`,
    }).from(vencimientos)
      .innerJoin(productos, eq(productos.id, vencimientos.productoId))
      .leftJoin(categorias, eq(categorias.id, productos.categoriaId))
      .where(enPeriodo)
      .groupBy(sql`1`)
      // Ordinal 4 = la pérdida estimada: lo que más plata pierde va arriba.
      .orderBy(sql`4 desc`);

    // Los que MÁS vencen — histórico completo: la señal para comprar distinto.
    const frecuentes = await this.db.select({
      productoId: vencimientos.productoId,
      presentacionId: vencimientos.presentacionId,
      nombre: vencimientos.nombre,
      veces: sql<number>`count(*)::int`,
      unidades: sql<number>`coalesce(sum(${vencimientos.cantidad}), 0)`,
      plata: sql<number>`coalesce(sum(${vencimientos.cantidad} * ${vencimientos.costoUnitario}), 0)`,
    }).from(vencimientos)
      .groupBy(vencimientos.productoId, vencimientos.presentacionId, vencimientos.nombre)
      .orderBy(sql`4 desc, 6 desc`)
      .limit(10);

    const mesExpr = sql<string>`to_char(${vencimientos.creadoEn} AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYY-MM')`;
    const seisMeses = new Date(hoy); seisMeses.setMonth(seisMeses.getMonth() - 6);
    const historial = await this.db.select({
      mes: mesExpr,
      registros: sql<number>`count(*)::int`,
      unidades: sql<number>`coalesce(sum(${vencimientos.cantidad}), 0)`,
      estimada: sql<number>`coalesce(sum(${vencimientos.cantidad} * ${vencimientos.costoUnitario}), 0)`,
      real: sql<number>`coalesce(sum(${perdidaRealExpr}) filter (where ${vencimientos.procesado}), 0)`,
    }).from(vencimientos)
      .where(sql`${vencimientos.creadoEn} >= ${seisMeses}`)
      .groupBy(sql`1`)
      .orderBy(sql`1 desc`);

    const [sesionesStats] = await this.db.select({
      sesiones: sql<number>`count(*)::int`,
      items: sql<number>`coalesce(sum(${vencimientoSesiones.totalItems}), 0)::int`,
      unidades: sql<number>`coalesce(sum(${vencimientoSesiones.totalUnidades}), 0)`,
    }).from(vencimientoSesiones).where(sql`${vencimientoSesiones.fecha} >= ${desde}`);

    const sesiones = await this.db.select({
      s: vencimientoSesiones,
      usuarioNombre: sql<string>`coalesce(${usuarios.nombre}, '—')`,
      sucursalNombre: sucursales.nombre,
    }).from(vencimientoSesiones)
      .leftJoin(usuarios, eq(usuarios.id, vencimientoSesiones.usuarioId))
      .innerJoin(sucursales, eq(sucursales.id, vencimientoSesiones.sucursalId))
      .orderBy(desc(vencimientoSesiones.id)).limit(20);

    return {
      periodo: { clave: periodo || 'mes', desde: desde.toISOString() },
      general: {
        registros: Number(general?.registros) || 0,
        unidades: r2(Number(general?.unidades)),
        estimada: r2(Number(general?.estimada)),
        procesados: Number(general?.procesados) || 0,
        vendidas: r2(Number(general?.vendidas)),
        real: r2(Number(general?.real)),
      },
      mermas: {
        registros: Number(mermasG?.registros) || 0,
        unidades: r2(Number(mermasG?.unidades)),
        plata: r2(Number(mermasG?.plata)),
      },
      porSucursal: porSucursalVenc.map((v) => {
        const m = porSucursalMerma.find((x) => x.sucursalId === v.sucursalId);
        return {
          sucursalId: v.sucursalId,
          registros: Number(v.registros),
          unidades: r2(Number(v.unidades)),
          estimada: r2(Number(v.estimada)),
          real: r2(Number(v.real)),
          mermas: r2(Number(m?.plata) || 0),
          total: r2(Number(v.estimada) + (Number(m?.plata) || 0)),
        };
      }).sort((a, b) => b.total - a.total),
      porCategoria: porCategoria.map((c) => ({
        categoria: c.categoria,
        registros: Number(c.registros),
        unidades: r2(Number(c.unidades)),
        estimada: r2(Number(c.estimada)),
      })),
      frecuentes: frecuentes.map((f) => ({
        ...f, veces: Number(f.veces), unidades: r2(Number(f.unidades)), plata: r2(Number(f.plata)),
      })),
      historial: historial.map((h) => ({
        mes: h.mes, registros: Number(h.registros), unidades: r2(Number(h.unidades)),
        estimada: r2(Number(h.estimada)), real: r2(Number(h.real)),
      })),
      sesiones: {
        stats: {
          sesiones: Number(sesionesStats?.sesiones) || 0,
          items: Number(sesionesStats?.items) || 0,
          unidades: r2(Number(sesionesStats?.unidades)),
        },
        ultimas: sesiones.map((x) => ({
          ...x.s, usuarioNombre: x.usuarioNombre, sucursalNombre: x.sucursalNombre,
        })),
      },
    };
  }
}

@Controller('vencimientos')
export class VencimientosController {
  constructor(private readonly svc: VencimientosService) {}

  @Get() list() { return this.svc.list(); }
  @Get('resumen') resumen() { return this.svc.resumen(); }
  @Get('reportes') reportes(@Query('periodo') periodo?: string) { return this.svc.reportes(periodo || 'mes'); }
  @Post('sesiones') crearSesion(@Body() dto: CrearSesionDto) { return this.svc.crearSesion(dto); }
  @Put(':id') editar(@Param('id', ParseIntPipe) id: number, @Body() dto: EditarVencimientoDto) { return this.svc.editar(id, dto); }
  @Delete(':id') eliminar(@Param('id', ParseIntPipe) id: number) { return this.svc.eliminar(id); }
  @Post(':id/procesar') procesar(@Param('id', ParseIntPipe) id: number, @Body() dto: ProcesarDto) { return this.svc.procesar(id, dto); }
  @Post(':id/armar-oferta') armarOferta(@Param('id', ParseIntPipe) id: number, @Body() dto: ArmarOfertaDto) { return this.svc.armarOferta(id, dto); }
}

@Module({
  imports: [InventarioModule, OfertasModule],
  providers: [VencimientosService],
  controllers: [VencimientosController],
})
export class VencimientosModule {}
