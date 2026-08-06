/**
 * GASTOS — lo que la empresa paga y no es mercadería
 * ============================================================================
 * Circuito completo y chico: se carga el comprobante que llegó, se imputa a una
 * categoría del plan de gastos, y se paga (de una o en partes). De ahí salen
 * las dos preguntas que el negocio hace todos los días: **qué tengo que pagar**
 * (bandeja de vencimientos) y **en qué se me va la plata** (resumen por rubro).
 *
 * Tres decisiones que valen la pena explicar:
 *
 *  1. El proveedor es el MISMO de compras. Un CUIT, una entidad. Lo que separa
 *     los dos mundos es el documento, no la persona (ver `schema.ts`).
 *  2. Pagar en efectivo desde un turno de caja abierto genera el EGRESO en esa
 *     caja, en la misma transacción. Sin eso, el dinero sale del cajón y el
 *     arqueo de la noche no cierra por un motivo que ya nadie recuerda.
 *  3. Un gasto con pagos no se anula ni se le cambian los importes: primero se
 *     revierte el pago. La plata que salió tiene que poder rastrearse siempre.
 */
import {
  BadRequestException, Body, Controller, Delete, Get, Inject, Injectable, Module,
  NotFoundException, Param, ParseIntPipe, Patch, Post, Query, Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  IsIn, IsInt, IsNumber, IsOptional, IsString,
} from 'class-validator';
import { and, asc, desc, eq, gte, inArray, lte, ne, or, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  gastoAdjuntos, gastoCategorias, gastos, gastosRecurrentes, proveedores, sucursales, usuarios,
} from '../db/schema';
import { PagosModule, PagosProveedorService } from '../pagos/pagos.module';

const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Fecha que llega del formulario. Un `<input type="date">` manda 'AAAA-MM-DD'
 * pelado, y `new Date('2026-08-05')` lo interpreta como MEDIANOCHE UTC: en
 * Argentina (UTC-3) eso es el 4 a las 21:00, así que el gasto que el usuario
 * fechó el 5 aparecía listado el 4. Con la hora explícita se parsea local.
 */
function fechaLocal(v?: string | null) {
  if (!v) return null;
  const s = String(v).trim();
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s);
}

/** Meses que cubre cada frecuencia: define cuándo un gasto fijo vuelve a tocar. */
const MESES_FRECUENCIA: Record<string, number> = {
  mensual: 1, bimestral: 2, trimestral: 3, semestral: 6, anual: 12,
};

const TIPOS_DOC = ['factura', 'ticket', 'recibo', 'nota_credito', 'otro'] as const;
const MEDIOS = ['efectivo', 'transferencia', 'tarjeta_debito', 'tarjeta_credito', 'cheque', 'qr', 'otro'] as const;

/* ------------------------------- DTOs ------------------------------- */

class GastoDto {
  @IsOptional() @IsString() fecha?: string;
  @IsOptional() @IsIn(TIPOS_DOC as unknown as string[]) tipoDoc?: string;
  @IsOptional() @IsIn(['A', 'B', 'C', 'X']) letra?: string;
  @IsOptional() @IsString() numero?: string;
  @IsOptional() @IsInt() proveedorId?: number;
  @IsOptional() @IsString() proveedorTexto?: string;
  @IsInt() categoriaId!: number;
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsString() descripcion?: string;
  @IsOptional() @IsIn(['contado', 'cuenta_corriente']) condicionPago?: string;
  /** A qué negocio se imputa: la distribuidora (defecto) o la cafetería. */
  @IsOptional() @IsIn(['distribuidora', 'cafeteria']) negocio?: string;
  @IsOptional() @IsString() vencimiento?: string;
  @IsOptional() @IsNumber() neto?: number;
  @IsOptional() @IsNumber() iva?: number;
  @IsOptional() @IsNumber() otros?: number;
  @IsOptional() @IsString() observaciones?: string;
  @IsOptional() @IsInt() usuarioId?: number;
  /**
   * Pago en el mismo acto del alta (el caso más común: se paga y se carga).
   * Si viene, se registra como primer pago del gasto.
   */
  @IsOptional() pagoInmediato?: any;
}

class PagoDto {
  @IsNumber() importe!: number;
  @IsOptional() @IsIn(MEDIOS as unknown as string[]) medio?: string;
  @IsOptional() @IsString() fecha?: string;
  @IsOptional() @IsString() referencia?: string;
  /** Turno de caja del que sale el efectivo (genera el egreso). */
  @IsOptional() @IsInt() cajaSesionId?: number;
  @IsOptional() @IsInt() usuarioId?: number;
}

class CategoriaDto {
  @IsOptional() @IsString() nombre?: string;
  @IsOptional() @IsIn(['fijo', 'variable']) tipo?: string;
  @IsOptional() @IsString() descripcion?: string;
  @IsOptional() activa?: boolean;
  @IsOptional() @IsInt() orden?: number;
}

class RecurrenteDto {
  @IsOptional() @IsString() nombre?: string;
  @IsOptional() @IsInt() categoriaId?: number;
  @IsOptional() @IsInt() proveedorId?: number;
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsNumber() importeEstimado?: number;
  @IsOptional() @IsIn(['mensual', 'bimestral', 'trimestral', 'semestral', 'anual']) frecuencia?: string;
  @IsOptional() @IsInt() diaVencimiento?: number;
  @IsOptional() activo?: boolean;
  @IsOptional() @IsString() observaciones?: string;
}

/* ------------------------------- Servicio ------------------------------- */

@Injectable()
export class GastosService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    /** Los pagos NO son de Gastos: son del proveedor. Acá solo se consultan. */
    private readonly pagos: PagosProveedorService,
  ) {}

  /* ---------------- Catálogos ---------------- */

  /**
   * Todo lo chico que el módulo necesita para operar, en una sola llamada:
   * plan de gastos, proveedores (con su clasificación), sucursales, usuarios y
   * las plantillas de gastos fijos.
   */
  async bootstrap() {
    const [categorias, provs, sucs, users, recurrentes] = await Promise.all([
      this.db.select().from(gastoCategorias).orderBy(asc(gastoCategorias.orden), asc(gastoCategorias.nombre)),
      this.db.select().from(proveedores).orderBy(asc(proveedores.nombre)),
      this.db.select().from(sucursales).orderBy(asc(sucursales.id)),
      this.db.select({ id: usuarios.id, nombre: usuarios.nombre, activo: usuarios.activo }).from(usuarios),
      this.db.select().from(gastosRecurrentes).orderBy(asc(gastosRecurrentes.nombre)),
    ]);
    return { categorias, proveedores: provs, sucursales: sucs, usuarios: users, recurrentes };
  }

  listCategorias() {
    return this.db.select().from(gastoCategorias)
      .orderBy(asc(gastoCategorias.orden), asc(gastoCategorias.nombre));
  }

  async crearCategoria(dto: CategoriaDto) {
    const nombre = (dto.nombre ?? '').trim();
    if (!nombre) throw new BadRequestException('Poné el nombre del rubro.');
    const [ya] = await this.db.select().from(gastoCategorias).where(eq(gastoCategorias.nombre, nombre)).limit(1);
    if (ya) throw new BadRequestException(`Ya existe un rubro llamado "${nombre}".`);
    const [c] = await this.db.insert(gastoCategorias).values({
      nombre,
      tipo: (dto.tipo ?? 'variable') as any,
      descripcion: (dto.descripcion ?? '').trim(),
      activa: dto.activa !== false,
      orden: Number(dto.orden) || 500,
    }).returning();
    return c;
  }

  async editarCategoria(id: number, dto: CategoriaDto) {
    const [c] = await this.db.select().from(gastoCategorias).where(eq(gastoCategorias.id, id)).limit(1);
    if (!c) throw new NotFoundException('Rubro inexistente.');
    const patch: any = {};
    if (dto.nombre != null) {
      const n = String(dto.nombre).trim();
      if (!n) throw new BadRequestException('El nombre no puede quedar vacío.');
      const [otro] = await this.db.select().from(gastoCategorias)
        .where(and(eq(gastoCategorias.nombre, n), ne(gastoCategorias.id, id))).limit(1);
      if (otro) throw new BadRequestException(`Ya existe un rubro llamado "${n}".`);
      patch.nombre = n;
    }
    if (dto.tipo != null) patch.tipo = dto.tipo;
    if (dto.descripcion != null) patch.descripcion = String(dto.descripcion).trim();
    if (dto.activa != null) patch.activa = !!dto.activa;
    if (dto.orden != null) patch.orden = Number(dto.orden) || 0;
    if (Object.keys(patch).length) await this.db.update(gastoCategorias).set(patch).where(eq(gastoCategorias.id, id));
    return { ok: true };
  }

  /**
   * El rubro con gastos imputados no se borra: se DA DE BAJA. Borrarlo dejaría
   * gastos históricos apuntando al vacío y el resumen del año pasado sin
   * explicación. La baja lo saca de los selectores y nada más.
   */
  async borrarCategoria(id: number) {
    const [c] = await this.db.select().from(gastoCategorias).where(eq(gastoCategorias.id, id)).limit(1);
    if (!c) throw new NotFoundException('Rubro inexistente.');
    const [uso] = await this.db.select({ n: sql<number>`count(*)::int` }).from(gastos).where(eq(gastos.categoriaId, id));
    const [usoFijo] = await this.db.select({ n: sql<number>`count(*)::int` }).from(gastosRecurrentes)
      .where(eq(gastosRecurrentes.categoriaId, id));
    if (Number(uso?.n) > 0 || Number(usoFijo?.n) > 0) {
      throw new BadRequestException(
        `"${c.nombre}" tiene ${Number(uso?.n) || 0} gasto(s) imputados: no se borra, se da de baja para que deje de aparecer.`,
      );
    }
    await this.db.delete(gastoCategorias).where(eq(gastoCategorias.id, id));
    return { ok: true };
  }

  /* ---------------- Gastos: lectura ---------------- */

  private condiciones(q: any) {
    const conds: any[] = [];
    if (q.desde) conds.push(gte(gastos.fecha, fechaLocal(q.desde)!));
    if (q.hasta) conds.push(lte(gastos.fecha, new Date(`${String(q.hasta).slice(0, 10)}T23:59:59.999`)));
    if (q.categoriaId) conds.push(eq(gastos.categoriaId, Number(q.categoriaId)));
    if (q.proveedorId) conds.push(eq(gastos.proveedorId, Number(q.proveedorId)));
    if (q.sucursalId) conds.push(eq(gastos.sucursalId, Number(q.sucursalId)));
    if (q.estado) conds.push(eq(gastos.estado, q.estado));
    if (q.negocio) conds.push(eq(gastos.negocio, q.negocio));
    if (q.q) {
      const like = `%${String(q.q).trim()}%`;
      conds.push(or(
        sql`${gastos.descripcion} ilike ${like}`,
        sql`${gastos.numero} ilike ${like}`,
        sql`${gastos.proveedorTexto} ilike ${like}`,
        sql`${gastos.observaciones} ilike ${like}`,
      ));
    }
    return conds.length ? and(...conds) : undefined;
  }

  async list(q: any) {
    const limit = Math.min(Math.max(Number(q.limit) || 300, 1), 1000);
    return this.db.select().from(gastos)
      .where(this.condiciones(q))
      .orderBy(desc(gastos.fecha), desc(gastos.id))
      .limit(limit);
  }

  async get(id: number) {
    const [g] = await this.db.select().from(gastos).where(eq(gastos.id, id)).limit(1);
    if (!g) throw new NotFoundException('Gasto inexistente.');
    const [pagos, adjuntos] = await Promise.all([
      this.pagos.pagosDe({ gastoId: id }),
      // Sin `data`: los bytes se piden aparte, por su endpoint.
      this.db.select({
        id: gastoAdjuntos.id, nombre: gastoAdjuntos.nombre, mime: gastoAdjuntos.mime,
        subidoEn: gastoAdjuntos.subidoEn,
      }).from(gastoAdjuntos).where(eq(gastoAdjuntos.gastoId, id)).orderBy(asc(gastoAdjuntos.id)),
    ]);
    return { ...g, saldo: money(g.total - g.pagado), pagos, adjuntos };
  }

  /**
   * Bandeja de vencimientos: lo que falta pagar, ordenado por urgencia. `dias`
   * es negativo cuando ya venció — el frontend pinta con eso sin recalcular
   * fechas (y sin discutir con la zona horaria del navegador).
   */
  async cuentasAPagar(q: any = {}) {
    const conds: any[] = [
      ne(gastos.estado, 'anulado'),
      sql`${gastos.total} - ${gastos.pagado} > 0.009`,
    ];
    if (q.sucursalId) conds.push(eq(gastos.sucursalId, Number(q.sucursalId)));
    if (q.proveedorId) conds.push(eq(gastos.proveedorId, Number(q.proveedorId)));
    const filas = await this.db.select().from(gastos)
      .where(and(...conds))
      .orderBy(asc(sql`coalesce(${gastos.vencimiento}, ${gastos.fecha})`), asc(gastos.id));

    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    return filas.map((g) => {
      const ref = g.vencimiento ? new Date(g.vencimiento) : null;
      let dias: number | null = null;
      if (ref) {
        const d = new Date(ref); d.setHours(0, 0, 0, 0);
        dias = Math.round((d.getTime() - hoy.getTime()) / 86400000);
      }
      return { ...g, saldo: money(g.total - g.pagado), dias };
    });
  }

  /**
   * Contador para el badge del sidebar: cuántos gastos están vencidos o vencen
   * hoy. Endpoint chico a propósito — lo pollea el CRM cada 30 segundos.
   */
  async pendientes() {
    const hoy = new Date(); hoy.setHours(23, 59, 59, 999);
    const [r] = await this.db.select({
      vencidos: sql<number>`count(*) filter (where ${gastos.vencimiento} is not null and ${gastos.vencimiento} <= ${hoy.toISOString()})::int`,
      pendientes: sql<number>`count(*)::int`,
      saldo: sql<number>`coalesce(sum(${gastos.total} - ${gastos.pagado}), 0)`,
    }).from(gastos).where(and(
      ne(gastos.estado, 'anulado'),
      sql`${gastos.total} - ${gastos.pagado} > 0.009`,
    ));
    return {
      vencidos: Number(r?.vencidos) || 0,
      pendientes: Number(r?.pendientes) || 0,
      saldo: money(Number(r?.saldo) || 0),
    };
  }

  /**
   * Resumen de gerencia: en qué se va la plata. Todo agregado en la base — el
   * período puede tener miles de filas y no tiene sentido traerlas para sumar
   * en JavaScript.
   */
  async resumen(q: any) {
    const conds: any[] = [ne(gastos.estado, 'anulado')];
    if (q.desde) conds.push(gte(gastos.fecha, fechaLocal(q.desde)!));
    if (q.hasta) conds.push(lte(gastos.fecha, new Date(`${String(q.hasta).slice(0, 10)}T23:59:59.999`)));
    if (q.sucursalId) conds.push(eq(gastos.sucursalId, Number(q.sucursalId)));
    const where = and(...conds);

    const [[totales], porCategoria, porMes, porProveedor] = await Promise.all([
      this.db.select({
        cantidad: sql<number>`count(*)::int`,
        total: sql<number>`coalesce(sum(${gastos.total}), 0)`,
        neto: sql<number>`coalesce(sum(${gastos.neto}), 0)`,
        iva: sql<number>`coalesce(sum(${gastos.iva}), 0)`,
        pagado: sql<number>`coalesce(sum(${gastos.pagado}), 0)`,
      }).from(gastos).where(where),

      this.db.select({
        categoriaId: gastos.categoriaId,
        nombre: gastoCategorias.nombre,
        tipo: gastoCategorias.tipo,
        cantidad: sql<number>`count(*)::int`,
        total: sql<number>`coalesce(sum(${gastos.total}), 0)`,
      }).from(gastos)
        .innerJoin(gastoCategorias, eq(gastoCategorias.id, gastos.categoriaId))
        .where(where)
        .groupBy(gastos.categoriaId, gastoCategorias.nombre, gastoCategorias.tipo)
        .orderBy(desc(sql`sum(${gastos.total})`)),

      this.db.select({
        mes: sql<string>`to_char(${gastos.fecha}, 'YYYY-MM')`,
        total: sql<number>`coalesce(sum(${gastos.total}), 0)`,
      }).from(gastos).where(where)
        .groupBy(sql`to_char(${gastos.fecha}, 'YYYY-MM')`)
        .orderBy(asc(sql`to_char(${gastos.fecha}, 'YYYY-MM')`)),

      this.db.select({
        proveedorId: gastos.proveedorId,
        nombre: sql<string>`coalesce(${proveedores.nombre}, nullif(${gastos.proveedorTexto}, ''), 'Sin proveedor')`,
        cantidad: sql<number>`count(*)::int`,
        total: sql<number>`coalesce(sum(${gastos.total}), 0)`,
      }).from(gastos)
        .leftJoin(proveedores, eq(proveedores.id, gastos.proveedorId))
        .where(where)
        .groupBy(gastos.proveedorId, proveedores.nombre, gastos.proveedorTexto)
        .orderBy(desc(sql`sum(${gastos.total})`))
        .limit(15),
    ]);

    const cat = porCategoria.map((c) => ({ ...c, total: money(Number(c.total)) }));
    const fijos = money(cat.filter((c) => c.tipo === 'fijo').reduce((a, c) => a + c.total, 0));
    const variables = money(cat.filter((c) => c.tipo === 'variable').reduce((a, c) => a + c.total, 0));

    return {
      cantidad: Number(totales?.cantidad) || 0,
      total: money(Number(totales?.total) || 0),
      neto: money(Number(totales?.neto) || 0),
      // IVA de los gastos = crédito fiscal (lo que se descuenta del IVA ventas).
      iva: money(Number(totales?.iva) || 0),
      pagado: money(Number(totales?.pagado) || 0),
      saldo: money((Number(totales?.total) || 0) - (Number(totales?.pagado) || 0)),
      porCategoria: cat,
      porMes: porMes.map((m) => ({ ...m, total: money(Number(m.total)) })),
      porProveedor: porProveedor.map((p) => ({ ...p, total: money(Number(p.total)) })),
      porTipo: { fijos, variables },
    };
  }

  /* ---------------- Gastos: escritura ---------------- */

  private totalesDe(dto: GastoDto) {
    const neto = money(dto.neto ?? 0);
    const iva = money(dto.iva ?? 0);
    const otros = money(dto.otros ?? 0);
    return { neto, iva, otros, total: money(neto + iva + otros) };
  }

  /**
   * Guard de duplicado: cargar dos veces la misma factura es EL error clásico
   * de un módulo de gastos, y se detecta tarde (cuando el resumen del mes da
   * más de lo que da el banco). Con proveedor y número, la combinación tiene
   * que ser única.
   */
  private async chequearDuplicado(proveedorId: number | null, letra: string, numero: string, exceptoId?: number) {
    if (!proveedorId || !numero) return;
    const conds: any[] = [
      eq(gastos.proveedorId, proveedorId),
      eq(gastos.numero, numero),
      eq(gastos.letra, letra as any),
      ne(gastos.estado, 'anulado'),
    ];
    if (exceptoId) conds.push(ne(gastos.id, exceptoId));
    const [ya] = await this.db.select({ id: gastos.id }).from(gastos).where(and(...conds)).limit(1);
    if (ya) {
      throw new BadRequestException(
        `Ese comprobante ya está cargado (gasto #${ya.id}). Si es otro, revisá el número o el proveedor.`,
      );
    }
  }

  async crear(dto: GastoDto) {
    const [cat] = await this.db.select().from(gastoCategorias)
      .where(eq(gastoCategorias.id, Number(dto.categoriaId))).limit(1);
    if (!cat) throw new BadRequestException('Elegí el rubro al que se imputa el gasto.');

    let proveedorId: number | null = null;
    if (dto.proveedorId) {
      const [p] = await this.db.select().from(proveedores).where(eq(proveedores.id, Number(dto.proveedorId))).limit(1);
      if (!p) throw new BadRequestException('Proveedor inválido.');
      proveedorId = p.id;
    }

    const { neto, iva, otros, total } = this.totalesDe(dto);
    if (total <= 0) throw new BadRequestException('El importe del gasto tiene que ser mayor a 0.');

    const numero = (dto.numero ?? '').trim();
    const letra = dto.letra ?? 'B';
    await this.chequearDuplicado(proveedorId, letra, numero);

    const [creado] = await this.db.insert(gastos).values({
        fecha: fechaLocal(dto.fecha) ?? undefined,
        tipoDoc: (dto.tipoDoc ?? 'factura') as any,
        letra: letra as any,
        numero,
        proveedorId,
        proveedorTexto: proveedorId ? '' : (dto.proveedorTexto ?? '').trim(),
        categoriaId: cat.id,
        sucursalId: dto.sucursalId ?? null,
        descripcion: (dto.descripcion ?? '').trim(),
        condicionPago: (dto.condicionPago ?? 'contado') as any,
        negocio: (dto.negocio ?? 'distribuidora') as any,
        vencimiento: fechaLocal(dto.vencimiento),
        neto, iva, otros, total,
        pagado: 0,
        estado: 'pendiente',
        observaciones: (dto.observaciones ?? '').trim(),
        usuarioId: dto.usuarioId ?? null,
    }).returning();

    /*
     * "Lo pagué y lo cargo": el pago se registra como pago al proveedor y se
     * imputa a este gasto en un solo acto. Va DESPUÉS del alta y no dentro de
     * la misma transacción a propósito — si el pago falla (turno cerrado, por
     * ejemplo), el gasto queda cargado y pendiente, que es un estado válido y
     * recuperable. Perder también la carga sería peor.
     */
    if (dto.pagoInmediato) {
      await this.pagos.crear({
        destino: 'gastos',
        proveedorId: proveedorId ?? undefined,
        importe: Number(dto.pagoInmediato.importe) || total,
        medio: dto.pagoInmediato.medio,
        fecha: dto.pagoInmediato.fecha,
        referencia: dto.pagoInmediato.referencia,
        concepto: (dto.descripcion ?? '').trim() || `Gasto #${creado.id}`,
        sucursalId: dto.sucursalId,
        cajaSesionId: dto.pagoInmediato.cajaSesionId,
        usuarioId: dto.pagoInmediato.usuarioId ?? dto.usuarioId,
        imputaciones: [{ gastoId: creado.id, importe: Number(dto.pagoInmediato.importe) || total }],
      });
    }
    return this.get(creado.id);
  }

  /**
   * Edición. Con pagos registrados solo se tocan los campos DESCRIPTIVOS: los
   * importes ya se movieron contra la caja o el banco, y cambiarlos por atrás
   * dejaría un pago mayor que su propio gasto.
   */
  async editar(id: number, dto: GastoDto) {
    const [g] = await this.db.select().from(gastos).where(eq(gastos.id, id)).limit(1);
    if (!g) throw new NotFoundException('Gasto inexistente.');
    if (g.estado === 'anulado') throw new BadRequestException('El gasto está anulado: no se edita.');

    const patch: any = {};
    if (dto.categoriaId != null) {
      const [c] = await this.db.select().from(gastoCategorias).where(eq(gastoCategorias.id, Number(dto.categoriaId))).limit(1);
      if (!c) throw new BadRequestException('Rubro inválido.');
      patch.categoriaId = c.id;
    }
    if (dto.descripcion != null) patch.descripcion = String(dto.descripcion).trim();
    if (dto.observaciones != null) patch.observaciones = String(dto.observaciones).trim();
    if (dto.vencimiento !== undefined) patch.vencimiento = fechaLocal(dto.vencimiento);
    if (dto.sucursalId !== undefined) patch.sucursalId = dto.sucursalId ?? null;
    // El negocio es imputación, no importe: se puede corregir aunque haya pagos.
    if (dto.negocio) patch.negocio = dto.negocio;

    const tienePagos = g.pagado > 0.009;
    if (!tienePagos) {
      if (dto.fecha) patch.fecha = fechaLocal(dto.fecha);
      if (dto.tipoDoc) patch.tipoDoc = dto.tipoDoc;
      if (dto.letra) patch.letra = dto.letra;
      if (dto.numero != null) patch.numero = String(dto.numero).trim();
      if (dto.condicionPago) patch.condicionPago = dto.condicionPago;
      if (dto.proveedorId !== undefined) {
        patch.proveedorId = dto.proveedorId ?? null;
        if (dto.proveedorId) patch.proveedorTexto = '';
      }
      if (dto.proveedorTexto != null && !patch.proveedorId) patch.proveedorTexto = String(dto.proveedorTexto).trim();
      if (dto.neto != null || dto.iva != null || dto.otros != null) {
        const t = this.totalesDe({
          neto: dto.neto ?? g.neto, iva: dto.iva ?? g.iva, otros: dto.otros ?? g.otros,
        } as GastoDto);
        if (t.total <= 0) throw new BadRequestException('El importe del gasto tiene que ser mayor a 0.');
        Object.assign(patch, t);
      }
      await this.chequearDuplicado(
        patch.proveedorId !== undefined ? patch.proveedorId : g.proveedorId,
        patch.letra ?? g.letra,
        patch.numero ?? g.numero,
        id,
      );
    } else if (
      dto.neto != null || dto.iva != null || dto.otros != null
      || dto.numero != null || dto.proveedorId !== undefined
    ) {
      throw new BadRequestException(
        'El gasto ya tiene pagos registrados: revertí el pago antes de cambiar importes, número o proveedor.',
      );
    }

    if (Object.keys(patch).length) await this.db.update(gastos).set(patch).where(eq(gastos.id, id));
    return this.get(id);
  }

  async anular(id: number, motivo?: string) {
    const [g] = await this.db.select().from(gastos).where(eq(gastos.id, id)).limit(1);
    if (!g) throw new NotFoundException('Gasto inexistente.');
    if (g.estado === 'anulado') throw new BadRequestException('Ya está anulado.');
    if (g.pagado > 0.009) {
      throw new BadRequestException('Tiene pagos registrados: revertilos primero — la plata que salió tiene que quedar rastreable.');
    }
    const nota = (motivo ?? '').trim();
    await this.db.update(gastos).set({
      estado: 'anulado',
      observaciones: nota ? `${g.observaciones ? `${g.observaciones}\n` : ''}Anulado: ${nota}` : g.observaciones,
    }).where(eq(gastos.id, id));
    return this.get(id);
  }

  /* ------------- Pagos (delegados en Pagos a proveedores) ------------- */

  /**
   * Pagar este gasto. Crea un PAGO AL PROVEEDOR y lo imputa en el mismo acto:
   * el gasto no tiene pagos propios, tiene imputaciones de pagos que son del
   * proveedor. Ese giro es lo que habilita el circuito inverso — que la cajera
   * pague cuando llega la mercadería, sin que el documento exista todavía.
   */
  async pagar(id: number, dto: PagoDto) {
    const [g] = await this.db.select().from(gastos).where(eq(gastos.id, id)).limit(1);
    if (!g) throw new NotFoundException('Gasto inexistente.');
    if (g.estado === 'anulado') throw new BadRequestException('El gasto está anulado.');
    const importe = money(dto.importe);
    await this.pagos.crear({
      destino: 'gastos',
      proveedorId: g.proveedorId ?? undefined,
      importe,
      medio: dto.medio,
      fecha: dto.fecha,
      referencia: dto.referencia,
      concepto: g.descripcion || `Gasto #${g.id}`,
      sucursalId: g.sucursalId ?? undefined,
      cajaSesionId: dto.cajaSesionId,
      usuarioId: dto.usuarioId,
      imputaciones: [{ gastoId: g.id, importe }],
    });
    return this.get(id);
  }

  /**
   * Aplicar a este gasto un pago que YA existe — el que la cajera registró
   * antes de que el comprobante estuviera cargado. No mueve plata: la imputa.
   */
  async aplicarPago(id: number, pagoId: number, importe: number, usuarioId?: number) {
    await this.pagos.imputar(pagoId, {
      imputaciones: [{ gastoId: id, importe: money(importe) }],
      usuarioId,
    });
    return this.get(id);
  }

  /* ---------------- Adjuntos (foto del comprobante) ---------------- */

  async subirAdjunto(gastoId: number, body: any) {
    const [g] = await this.db.select({ id: gastos.id }).from(gastos).where(eq(gastos.id, gastoId)).limit(1);
    if (!g) throw new NotFoundException('Gasto inexistente.');
    const dataUrl = String(body?.data ?? '');
    const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
    if (!m) throw new BadRequestException('La imagen tiene que llegar como data URL en base64.');
    const [a] = await this.db.insert(gastoAdjuntos).values({
      gastoId, nombre: String(body?.nombre ?? '').slice(0, 120), mime: m[1], data: m[2],
    }).returning({ id: gastoAdjuntos.id, nombre: gastoAdjuntos.nombre, mime: gastoAdjuntos.mime });
    return a;
  }

  async verAdjunto(id: number, res: Response) {
    const [a] = await this.db.select().from(gastoAdjuntos).where(eq(gastoAdjuntos.id, id)).limit(1);
    if (!a) throw new NotFoundException('Adjunto inexistente.');
    const buf = Buffer.from(a.data, 'base64');
    res.setHeader('Content-Type', a.mime);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.end(buf);
  }

  async borrarAdjunto(id: number) {
    await this.db.delete(gastoAdjuntos).where(eq(gastoAdjuntos.id, id));
    return { ok: true };
  }

  /* ---------------- Gastos fijos (recurrentes) ---------------- */

  listRecurrentes() {
    return this.db.select().from(gastosRecurrentes).orderBy(asc(gastosRecurrentes.nombre));
  }

  async crearRecurrente(dto: RecurrenteDto) {
    const nombre = (dto.nombre ?? '').trim();
    if (!nombre) throw new BadRequestException('Poné un nombre (ej.: "Alquiler del local").');
    const [c] = await this.db.select().from(gastoCategorias).where(eq(gastoCategorias.id, Number(dto.categoriaId))).limit(1);
    if (!c) throw new BadRequestException('Elegí el rubro del gasto fijo.');
    const [r] = await this.db.insert(gastosRecurrentes).values({
      nombre,
      categoriaId: c.id,
      proveedorId: dto.proveedorId ?? null,
      sucursalId: dto.sucursalId ?? null,
      importeEstimado: money(dto.importeEstimado ?? 0),
      frecuencia: (dto.frecuencia ?? 'mensual') as any,
      diaVencimiento: Math.min(Math.max(Number(dto.diaVencimiento) || 10, 1), 31),
      activo: dto.activo !== false,
      observaciones: (dto.observaciones ?? '').trim(),
    }).returning();
    return r;
  }

  async editarRecurrente(id: number, dto: RecurrenteDto) {
    const [r] = await this.db.select().from(gastosRecurrentes).where(eq(gastosRecurrentes.id, id)).limit(1);
    if (!r) throw new NotFoundException('Gasto fijo inexistente.');
    const patch: any = {};
    if (dto.nombre != null) {
      const n = String(dto.nombre).trim();
      if (!n) throw new BadRequestException('El nombre no puede quedar vacío.');
      patch.nombre = n;
    }
    if (dto.categoriaId != null) patch.categoriaId = Number(dto.categoriaId);
    if (dto.proveedorId !== undefined) patch.proveedorId = dto.proveedorId ?? null;
    if (dto.sucursalId !== undefined) patch.sucursalId = dto.sucursalId ?? null;
    if (dto.importeEstimado != null) patch.importeEstimado = money(dto.importeEstimado);
    if (dto.frecuencia != null) patch.frecuencia = dto.frecuencia;
    if (dto.diaVencimiento != null) patch.diaVencimiento = Math.min(Math.max(Number(dto.diaVencimiento) || 10, 1), 31);
    if (dto.activo != null) patch.activo = !!dto.activo;
    if (dto.observaciones != null) patch.observaciones = String(dto.observaciones).trim();
    if (Object.keys(patch).length) await this.db.update(gastosRecurrentes).set(patch).where(eq(gastosRecurrentes.id, id));
    return { ok: true };
  }

  async borrarRecurrente(id: number) {
    const [r] = await this.db.select().from(gastosRecurrentes).where(eq(gastosRecurrentes.id, id)).limit(1);
    if (!r) throw new NotFoundException('Gasto fijo inexistente.');
    // Los gastos ya generados quedan: `recurrente_id` no tiene FK justamente
    // para que borrar la plantilla no borre la historia.
    await this.db.delete(gastosRecurrentes).where(eq(gastosRecurrentes.id, id));
    return { ok: true };
  }

  /**
   * Qué gastos fijos faltan emitir en un período ('YYYY-MM'), y cuáles ya
   * están. La idempotencia se comprueba contra los GASTOS realmente emitidos
   * por cada plantilla, no contra un flag: así reintentar nunca duplica, y si
   * alguien borra el gasto generado, la plantilla vuelve a ofrecerse.
   */
  async previsualizarPeriodo(periodo: string) {
    const { inicio, fin } = this.rangoPeriodo(periodo);
    const plantillas = await this.db.select().from(gastosRecurrentes)
      .where(eq(gastosRecurrentes.activo, true)).orderBy(asc(gastosRecurrentes.nombre));
    if (!plantillas.length) return { periodo, pendientes: [], emitidos: [] };

    const emitidos = await this.db.select().from(gastos).where(and(
      inArray(gastos.recurrenteId, plantillas.map((p) => p.id)),
      ne(gastos.estado, 'anulado'),
    ));

    const pendientes: any[] = [];
    const yaEstan: any[] = [];
    for (const p of plantillas) {
      const meses = MESES_FRECUENCIA[p.frecuencia] ?? 1;
      const limite = new Date(fin);
      limite.setMonth(limite.getMonth() - meses);
      const previo = emitidos.find((g) => g.recurrenteId === p.id && new Date(g.fecha) > limite);
      if (previo) yaEstan.push({ plantilla: p, gastoId: previo.id, fecha: previo.fecha });
      else pendientes.push({ plantilla: p, vencimiento: this.vencimientoDe(inicio, p.diaVencimiento) });
    }
    return { periodo, pendientes, emitidos: yaEstan };
  }

  async generarPeriodo(periodo: string, usuarioId?: number, soloIds?: number[]) {
    const { inicio } = this.rangoPeriodo(periodo);
    const previa = await this.previsualizarPeriodo(periodo);
    const aGenerar = previa.pendientes.filter(
      (x: any) => !soloIds?.length || soloIds.includes(x.plantilla.id),
    );
    if (!aGenerar.length) return { creados: 0, periodo, gastos: [] };

    const creados = await this.db.transaction(async (tx) => {
      const filas = aGenerar.map((x: any) => ({
        fecha: inicio,
        tipoDoc: 'factura' as const,
        letra: 'B' as const,
        numero: '',
        proveedorId: x.plantilla.proveedorId,
        categoriaId: x.plantilla.categoriaId,
        sucursalId: x.plantilla.sucursalId,
        descripcion: `${x.plantilla.nombre} · ${periodo}`,
        condicionPago: 'cuenta_corriente' as const,
        vencimiento: x.vencimiento,
        // El importe es el ESTIMADO de la plantilla: queda como previsión hasta
        // que llegue la factura real y alguien la corrija.
        neto: money(x.plantilla.importeEstimado),
        iva: 0,
        otros: 0,
        total: money(x.plantilla.importeEstimado),
        estado: 'pendiente' as const,
        recurrenteId: x.plantilla.id,
        observaciones: 'Generado desde Gastos fijos. Corregí el importe cuando llegue el comprobante.',
        usuarioId: usuarioId ?? null,
      }));
      return tx.insert(gastos).values(filas).returning({ id: gastos.id });
    });
    return { creados: creados.length, periodo, gastos: creados.map((g) => g.id) };
  }

  /** 'YYYY-MM' → primer y último instante del mes. */
  private rangoPeriodo(periodo: string) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(periodo ?? '').trim());
    if (!m) throw new BadRequestException('El período se indica como AAAA-MM (por ejemplo 2026-08).');
    const anio = Number(m[1]);
    const mes = Number(m[2]);
    if (mes < 1 || mes > 12) throw new BadRequestException('Mes inválido.');
    const inicio = new Date(anio, mes - 1, 1, 0, 0, 0, 0);
    const fin = new Date(anio, mes, 0, 23, 59, 59, 999);
    return { inicio, fin };
  }

  /** Día de vencimiento dentro del mes, recortado al último día real (31 → 28/30). */
  private vencimientoDe(inicioMes: Date, dia: number) {
    const ultimo = new Date(inicioMes.getFullYear(), inicioMes.getMonth() + 1, 0).getDate();
    return new Date(inicioMes.getFullYear(), inicioMes.getMonth(), Math.min(dia, ultimo), 0, 0, 0, 0);
  }
}

/* ------------------------------- Controller ------------------------------- */

@Controller('gastos')
export class GastosController {
  constructor(private readonly svc: GastosService) {}

  /* Las rutas fijas van ANTES de `:id`: Nest resuelve por orden de declaración. */
  @Get('bootstrap') bootstrap() { return this.svc.bootstrap(); }
  @Get('pendientes') pendientes() { return this.svc.pendientes(); }
  @Get('cuentas-a-pagar') cuentas(@Query() q: any) { return this.svc.cuentasAPagar(q ?? {}); }
  @Get('resumen') resumen(@Query() q: any) { return this.svc.resumen(q ?? {}); }

  @Get('categorias') categorias() { return this.svc.listCategorias(); }
  @Post('categorias') crearCategoria(@Body() dto: CategoriaDto) { return this.svc.crearCategoria(dto); }
  @Patch('categorias/:id') editarCategoria(@Param('id', ParseIntPipe) id: number, @Body() dto: CategoriaDto) {
    return this.svc.editarCategoria(id, dto);
  }
  @Delete('categorias/:id') borrarCategoria(@Param('id', ParseIntPipe) id: number) {
    return this.svc.borrarCategoria(id);
  }

  @Get('recurrentes') recurrentes() { return this.svc.listRecurrentes(); }
  @Post('recurrentes') crearRecurrente(@Body() dto: RecurrenteDto) { return this.svc.crearRecurrente(dto); }
  @Patch('recurrentes/:id') editarRecurrente(@Param('id', ParseIntPipe) id: number, @Body() dto: RecurrenteDto) {
    return this.svc.editarRecurrente(id, dto);
  }
  @Delete('recurrentes/:id') borrarRecurrente(@Param('id', ParseIntPipe) id: number) {
    return this.svc.borrarRecurrente(id);
  }
  @Get('recurrentes/periodo/:periodo') previa(@Param('periodo') periodo: string) {
    return this.svc.previsualizarPeriodo(periodo);
  }
  @Post('recurrentes/generar') generar(@Body() body: any) {
    return this.svc.generarPeriodo(body?.periodo, body?.usuarioId, body?.ids);
  }

  @Get('adjuntos/:id') adjunto(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    return this.svc.verAdjunto(id, res);
  }
  @Delete('adjuntos/:id') borrarAdjunto(@Param('id', ParseIntPipe) id: number) {
    return this.svc.borrarAdjunto(id);
  }

  @Get() list(@Query() q: any) { return this.svc.list(q ?? {}); }
  @Post() crear(@Body() dto: GastoDto) { return this.svc.crear(dto); }

  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }
  @Patch(':id') editar(@Param('id', ParseIntPipe) id: number, @Body() dto: GastoDto) {
    return this.svc.editar(id, dto);
  }
  @Post(':id/anular') anular(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.anular(id, body?.motivo);
  }
  @Post(':id/pagos') pagar(@Param('id', ParseIntPipe) id: number, @Body() dto: PagoDto) {
    return this.svc.pagar(id, dto);
  }
  /** Usar un pago a cuenta que ya existe. Quitarlo se hace desde Pagos. */
  @Post(':id/aplicar-pago') aplicarPago(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.aplicarPago(id, Number(body?.pagoId), Number(body?.importe), body?.usuarioId);
  }
  @Post(':id/adjuntos') subir(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.subirAdjunto(id, body);
  }
}

@Module({
  imports: [PagosModule],
  controllers: [GastosController],
  providers: [GastosService],
  exports: [GastosService],
})
export class GastosModule {}
