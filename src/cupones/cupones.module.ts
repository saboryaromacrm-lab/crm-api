/**
 * CUPONES DE LA TIENDA MINORISTA (0190, 20/10/2026, pedido del dueño)
 * ============================================================================
 * La definición se arma en Tienda online › Configuración › Cupones; el cliente
 * escribe el código en el checkout. Las reglas y la cuenta viven en `reglas.ts`
 * (puras); acá, la base: el alta, los usos y lo que se mide.
 *
 * EL USO SE CUENTA POR PEDIDO, no por venta: un pedido pendiente ya ocupa su
 * cupo (si no, dos clientes usarían el último a la vez). El que se rechaza lo
 * devuelve solo (`cancelado` no cuenta). El alta del pedido traba la fila del
 * cupón (`FOR UPDATE`) mientras cuenta: dos pedidos simultáneos no se pasan del tope.
 *
 * LA RENTABILIDAD SE MIDE EN LAS VENTAS REALES: las que se cerraron en la caja
 * desde un pedido con cupón (y sus notas de crédito), todo neto como Métricas.
 */
import {
  BadRequestException, Body, Controller, Delete, Get, Inject, Injectable, Module, NotFoundException,
  Param, ParseIntPipe, Post, Put, Query,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { Auth, Permiso, Sesion } from '../auth/auth.decoradores';
import { DRIZZLE, Database } from '../db/drizzle';
import { cupones, productos } from '../db/schema';
import { aplicar, errorDeCupon, ENTREGAS_CUPON, TIPOS_CUPON, type Contexto, type Cupon, type Renglon } from './reglas';

const r2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
const N = (n: unknown) => Number(n) || 0;
/** Fin del día argentino de una fecha 'AAAA-MM-DD' (el cupón vale ese día entero). */
const finDelDia = (d: string) => new Date(`${d}T23:59:59-03:00`);
const inicioDelDia = (d: string) => new Date(`${d}T00:00:00-03:00`);
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

class CuponDto {
  @IsString() @MaxLength(30) codigo!: string;
  @IsOptional() @IsString() @MaxLength(200) descripcion?: string;
  @IsOptional() @IsBoolean() activo?: boolean;
  @IsIn(TIPOS_CUPON as unknown as string[]) tipo!: Cupon['tipo'];
  @IsOptional() @IsNumber() @Min(0) valor?: number;
  @IsOptional() @IsNumber() @Min(0) tope?: number;
  @IsOptional() @IsNumber() @Min(0) montoMinimo?: number;
  /** 'AAAA-MM-DD' (desde el comienzo del día) o vacío. */
  @IsOptional() @IsString() @Matches(/^(\d{4}-\d{2}-\d{2})?$/) desde?: string;
  /** 'AAAA-MM-DD' (hasta el final del día) o vacío. */
  @IsOptional() @IsString() @Matches(/^(\d{4}-\d{2}-\d{2})?$/) hasta?: string;
  @IsOptional() @IsString() @MaxLength(7) dias?: string;
  @IsOptional() @IsString() @MaxLength(5) horaDesde?: string;
  @IsOptional() @IsString() @MaxLength(5) horaHasta?: string;
  @IsOptional() @IsString() @MaxLength(60) mediosPago?: string;
  @IsOptional() @IsIn(ENTREGAS_CUPON as unknown as string[]) entrega?: string;
  @IsOptional() @IsString() @MaxLength(2000) marcas?: string;
  @IsOptional() @IsString() @MaxLength(2000) categorias?: string;
  @IsOptional() @IsInt() @Min(0) usosMax?: number;
  @IsOptional() @IsInt() @Min(0) usosPorCliente?: number;
  @IsOptional() @IsBoolean() soloPrimeraCompra?: boolean;
}

/** CSV de ids sin repetidos, ordenado (como las listas de las ofertas). */
const idsCsv = (s?: string) => [...new Set(String(s ?? '').split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => n > 0))]
  .sort((a, b) => a - b).join(',');

@Injectable()
export class CuponesService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /* ============================== LA DEFINICIÓN ============================== */

  private normalizar(dto: CuponDto) {
    const tipo = dto.tipo;
    const fila = {
      codigo: String(dto.codigo ?? '').trim().toUpperCase(),
      descripcion: String(dto.descripcion ?? '').trim(),
      activo: dto.activo ?? true,
      tipo,
      valor: tipo === 'envio_gratis' ? 0 : N(dto.valor),
      tope: tipo === 'porcentaje' ? N(dto.tope) : 0,
      montoMinimo: N(dto.montoMinimo),
      desde: dto.desde && FECHA.test(dto.desde) ? inicioDelDia(dto.desde) : null,
      hasta: dto.hasta && FECHA.test(dto.hasta) ? finDelDia(dto.hasta) : null,
      dias: String(dto.dias ?? '').trim() === '1111111' ? '' : String(dto.dias ?? '').trim(),
      horaDesde: String(dto.horaDesde ?? '').trim(),
      horaHasta: String(dto.horaHasta ?? '').trim(),
      mediosPago: [...new Set(String(dto.mediosPago ?? '').split(',').map((m) => m.trim()).filter(Boolean))].sort().join(','),
      /* El envío gratis es, por definición, con envío. */
      entrega: tipo === 'envio_gratis' ? 'envio' : String(dto.entrega ?? ''),
      marcas: idsCsv(dto.marcas),
      categorias: idsCsv(dto.categorias),
      usosMax: N(dto.usosMax),
      usosPorCliente: dto.usosPorCliente == null ? 1 : N(dto.usosPorCliente),
      soloPrimeraCompra: dto.soloPrimeraCompra ?? false,
    };
    const error = errorDeCupon(fila);
    if (error) throw new BadRequestException(error);
    return fila;
  }

  private async exigirCodigoLibre(codigo: string, salvo: number | null) {
    const [otro] = await this.db.select({ id: cupones.id }).from(cupones).where(eq(cupones.codigo, codigo)).limit(1);
    if (otro && otro.id !== salvo) throw new BadRequestException(`Ya hay un cupón con el código ${codigo}.`);
  }

  async crear(dto: CuponDto, usuarioId: number | null) {
    const fila = this.normalizar(dto);
    await this.exigirCodigoLibre(fila.codigo, null);
    const [c] = await this.db.insert(cupones).values({ ...fila, creadoPor: usuarioId }).returning();
    return c;
  }

  /**
   * Editar uno YA USADO no cambia los pedidos hechos: el descuento quedó
   * congelado en cada uno. El código tampoco: los pedidos lo guardan escrito.
   */
  async editar(id: number, dto: CuponDto) {
    const fila = this.normalizar(dto);
    await this.exigirCodigoLibre(fila.codigo, id);
    const [c] = await this.db.update(cupones).set({ ...fila, actualizadoEn: new Date() }).where(eq(cupones.id, id)).returning();
    if (!c) throw new NotFoundException('Ese cupón ya no existe.');
    return c;
  }

  /** Usado en un pedido → se desactiva (los pedidos y las ventas lo nombran). Sin usar → se borra. */
  async borrar(id: number) {
    const usado = await this.db.execute(sql`SELECT 1 FROM presupuestos WHERE cupon_id = ${id} LIMIT 1`);
    if (usado.rows.length) {
      const [c] = await this.db.update(cupones).set({ activo: false, actualizadoEn: new Date() }).where(eq(cupones.id, id)).returning();
      if (!c) throw new NotFoundException('Ese cupón ya no existe.');
      return { ok: true, desactivado: true };
    }
    const [c] = await this.db.delete(cupones).where(eq(cupones.id, id)).returning({ id: cupones.id });
    if (!c) throw new NotFoundException('Ese cupón ya no existe.');
    return { ok: true, desactivado: false };
  }

  /* ============================== EL USO ============================== */

  /**
   * El cupón sobre un pedido de la tienda. `renglones` llegan como los arma la
   * tienda (con su % de barrio); acá se les suma marca y categoría. `tx` +
   * `trabar`: el alta del pedido, que cuenta los usos con la fila trabada.
   */
  async evaluar(
    codigo: string,
    pedido: { renglones: Omit<Renglon, 'marcaId' | 'categoriaId'>[]; telefono: string; primeraCompra: boolean } & Omit<Contexto, 'usos' | 'usosCliente' | 'primeraCompra'>,
    tx: Database = this.db, trabar = false,
  ) {
    const cod = String(codigo ?? '').trim().toUpperCase();
    if (!cod) return null;
    const [c] = await tx.select().from(cupones).where(eq(cupones.codigo, cod)).limit(1);
    if (!c) return { cupon: null, resultado: { vale: false as const, motivo: 'Ese cupón no existe o ya no está activo.' } };
    if (trabar) await tx.execute(sql`SELECT id FROM cupones WHERE id = ${c.id} FOR UPDATE`);
    const [u] = (await tx.execute(sql`
      SELECT count(*)::int AS usos, count(*) FILTER (WHERE web_cliente->>'telefono' = ${pedido.telefono})::int AS cliente
      FROM presupuestos WHERE cupon_id = ${c.id} AND estado <> 'cancelado'`)).rows as any[];
    const ids = [...new Set(pedido.renglones.map((r) => r.productoId))];
    const prods = ids.length
      ? await tx.select({ id: productos.id, marcaId: productos.marcaId, categoriaId: productos.categoriaId }).from(productos).where(inArray(productos.id, ids))
      : [];
    const porId = new Map(prods.map((p) => [p.id, p]));
    const renglones: Renglon[] = pedido.renglones.map((r) => ({
      ...r, marcaId: porId.get(r.productoId)?.marcaId ?? null, categoriaId: porId.get(r.productoId)?.categoriaId ?? null,
    }));
    return {
      cupon: c,
      resultado: aplicar(c, renglones, {
        ahora: pedido.ahora, entrega: pedido.entrega, medioPago: pedido.medioPago, subtotal: pedido.subtotal,
        usos: N(u?.usos), usosCliente: N(u?.cliente), primeraCompra: pedido.primeraCompra,
      }),
    };
  }

  /* ============================== LA PANTALLA Y LO MEDIDO ============================== */

  /**
   * Cada cupón con sus usos y lo que dejó. `desde`/`hasta` acotan por la fecha
   * del pedido (vacío = toda la historia).
   *
   *   · usos: pedidos por estado (pendiente / en curso / cerrado en venta / rechazado);
   *   · ventas: las cerradas en la caja desde esos pedidos, menos sus notas de
   *     crédito. Venta neta, costo, ganancia (solo de lo que tiene costo), lo que
   *     descontó el cupón (neto, de sus renglones) y el envío que regaló (neto);
   *   · ganancia sin el cupón y ganancia después del envío regalado;
   *   · ticket promedio contra el de los pedidos minoristas SIN cupón del período.
   */
  async listar(desde?: string, hasta?: string) {
    const d = desde && FECHA.test(desde) ? inicioDelDia(desde) : null;
    const h = hasta && FECHA.test(hasta) ? finDelDia(hasta) : null;
    const enRango = (col: string) => sql.raw(`${d ? `${col} >= '${d.toISOString()}'` : 'true'} AND ${h ? `${col} <= '${h.toISOString()}'` : 'true'}`);
    const [todos, usos, ventas, referencia] = await Promise.all([
      this.db.select().from(cupones).orderBy(asc(cupones.id)),
      this.db.execute(sql`
        SELECT cupon_id,
          count(*) FILTER (WHERE estado <> 'cancelado')::int AS total,
          count(*) FILTER (WHERE estado = 'pendiente')::int AS pendientes,
          count(*) FILTER (WHERE estado IN ('borrador', 'enviado', 'confirmado'))::int AS en_curso,
          count(*) FILTER (WHERE estado = 'cerrado')::int AS cerrados,
          count(*) FILTER (WHERE estado = 'cancelado')::int AS rechazados,
          coalesce(sum(cupon_descuento) FILTER (WHERE estado <> 'cancelado'), 0)::float8 AS prometido,
          count(*) FILTER (WHERE estado <> 'cancelado' AND (web_cliente->>'primeraCompra') = 'true')::int AS nuevos,
          coalesce(sum(cupon_envio) FILTER (WHERE estado = 'cerrado'), 0)::float8 AS envio_regalado
        FROM presupuestos WHERE cupon_id IS NOT NULL AND ${enRango('fecha')} GROUP BY 1`),
      this.db.execute(sql`
        WITH base AS (
          SELECT v.id, p.cupon_id FROM ventas v JOIN presupuestos p ON p.id = v.presupuesto_id
          WHERE p.cupon_id IS NOT NULL AND v.estado IN ('confirmada', 'pendiente_cae') AND ${enRango('p.fecha')}
        ), todas AS (
          SELECT b.cupon_id, v.id, v.subtotal_neto, (v.tipo::text LIKE 'nota_credito%') AS nota
          FROM base b JOIN ventas v ON v.id = b.id
          UNION ALL
          SELECT b.cupon_id, n.id, n.subtotal_neto, true
          FROM base b JOIN ventas n ON n.ref_venta_id = b.id
          WHERE n.estado IN ('confirmada', 'pendiente_cae') AND n.tipo::text LIKE 'nota_credito%'
        )
        SELECT t.cupon_id,
          count(*) FILTER (WHERE NOT t.nota)::int AS tickets,
          sum(t.subtotal_neto * CASE WHEN t.nota THEN -1 ELSE 1 END)::float8 AS neta,
          coalesce(sum(i.costeado * CASE WHEN t.nota THEN -1 ELSE 1 END), 0)::float8 AS costeado,
          coalesce(sum(i.costo * CASE WHEN t.nota THEN -1 ELSE 1 END), 0)::float8 AS costo,
          coalesce(sum(i.cupon * CASE WHEN t.nota THEN -1 ELSE 1 END), 0)::float8 AS cupon,
          coalesce(sum(i.sin_costo), 0)::int AS sin_costo
        FROM todas t
          LEFT JOIN LATERAL (
            SELECT sum(vi.subtotal) FILTER (WHERE vi.costo_unitario IS NOT NULL) AS costeado,
              sum(vi.cantidad * vi.costo_unitario) AS costo,
              sum(vi.cupon_descuento) FILTER (WHERE vi.cupon_id = t.cupon_id) AS cupon,
              count(*) FILTER (WHERE vi.costo_unitario IS NULL) AS sin_costo
            FROM venta_items vi WHERE vi.venta_id = t.id
          ) i ON true
        GROUP BY 1`),
      this.db.execute(sql`
        SELECT count(*)::int AS tickets, coalesce(avg(v.subtotal_neto), 0)::float8 AS promedio
        FROM ventas v JOIN presupuestos p ON p.id = v.presupuesto_id
        WHERE p.modo_tienda = 'minorista' AND p.cupon_id IS NULL AND v.estado IN ('confirmada', 'pendiente_cae')
          AND v.tipo::text NOT LIKE 'nota_credito%' AND ${enRango('p.fecha')}`),
    ]);
    const usoDe = new Map((usos.rows as any[]).map((x) => [Number(x.cupon_id), x]));
    const ventaDe = new Map((ventas.rows as any[]).map((x) => [Number(x.cupon_id), x]));
    const ref = (referencia.rows as any[])[0];
    return {
      referencia: { ticketsSinCupon: N(ref?.tickets), ticketPromedioSinCupon: r2(ref?.promedio) },
      cupones: todos.map((c) => {
        const u = usoDe.get(c.id);
        const v = ventaDe.get(c.id);
        const ganancia = N(v?.costeado) - N(v?.costo);
        /* El envío de la tienda lleva IVA 21 % (así lo carga la caja al cerrar el pedido). */
        const envioNeto = N(u?.envio_regalado) / 1.21;
        const tickets = N(v?.tickets);
        return {
          ...c,
          usos: {
            total: N(u?.total), pendientes: N(u?.pendientes), enCurso: N(u?.en_curso), cerrados: N(u?.cerrados),
            rechazados: N(u?.rechazados), clientesNuevos: N(u?.nuevos), descuentoPrometido: r2(u?.prometido),
          },
          ventas: {
            tickets,
            ventaNeta: r2(v?.neta),
            costeado: r2(v?.costeado),
            costo: r2(v?.costo),
            ganancia: r2(ganancia),
            margen: N(v?.costeado) > 0 ? r2((ganancia / N(v?.costeado)) * 100) : null,
            descuentoCupon: r2(v?.cupon),
            envioRegalado: r2(envioNeto),
            gananciaSinCupon: r2(ganancia + N(v?.cupon)),
            gananciaFinal: r2(ganancia - envioNeto),
            ticketPromedio: tickets > 0 ? r2(N(v?.neta) / tickets) : null,
            sinCosto: N(v?.sin_costo),
          },
        };
      }),
    };
  }
}

/** La pantalla del ERP: quien configura la tienda online. */
@Controller('cupones')
@Permiso('web.configuracion')
export class CuponesController {
  constructor(private readonly svc: CuponesService) {}

  @Get() listar(@Query('desde') desde?: string, @Query('hasta') hasta?: string) { return this.svc.listar(desde, hasta); }
  @Post() crear(@Body() dto: CuponDto, @Auth() sesion: Sesion) { return this.svc.crear(dto, sesion.usuarioId); }
  @Put(':id') editar(@Param('id', ParseIntPipe) id: number, @Body() dto: CuponDto) { return this.svc.editar(id, dto); }
  @Delete(':id') borrar(@Param('id', ParseIntPipe) id: number) { return this.svc.borrar(id); }
}

@Module({ controllers: [CuponesController], providers: [CuponesService], exports: [CuponesService] })
export class CuponesModule {}
