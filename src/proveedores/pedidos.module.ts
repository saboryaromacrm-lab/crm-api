/**
 * PEDIDOS AL PROVEEDOR — el kanban de la app externa, tal cual (0068)
 * ============================================================================
 * Pizarra interna entre el admin y el encargado de compras: a quién hay que
 * pedirle, a quién ya se le pidió, qué llegó. Es información de coordinación —
 * NO toca stock ni deuda (eso pasa al confirmar la factura en Compras), y los
 * ítems van en texto libre a propósito: son notas de pedido informales.
 *
 * Los cuatro estados y sus reglas (heredadas de la app, verificadas contra su
 * código):
 *   solicitado → hay que pedirle. Acá viven los dos flags auxiliares:
 *     · pedidoEnviado: "ya le mandé el pedido por WhatsApp y espero que
 *       confirmen" — puro visual.
 *     · revisadoAt: "ya revisé su stock y todavía no hace falta" — es FECHA
 *       para poder decir "lo viste hace 4 días".
 *   pedido     → confirmado con el proveedor (queda fechaPedido).
 *   recibido   → llegó (queda fechaRecepcion) — alimenta la pestaña Ingresos,
 *                que mide además cuántos días tardó cada proveedor.
 *   retomar    → aparcado sin fecha: ni urge ni murió.
 *
 * CUALQUIER cambio de estado resetea los dos flags: solo significan algo
 * mientras la tarjeta está en Solicitado, y si vuelve, vuelve limpia.
 */
import {
  BadRequestException, Body, Controller, Delete, Get, Inject, Injectable, Module,
  NotFoundException, Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import {
  ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, MaxLength,
} from 'class-validator';
import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { DRIZZLE, Database } from '../db/drizzle';
import { pedidosProveedor, productoProveedores, proveedores } from '../db/schema';

const ESTADOS = ['solicitado', 'pedido', 'recibido', 'retomar'] as const;

class AltaPedidosDto {
  /** Alta de a varios: una tarjeta por proveedor, todas en Solicitado. */
  @IsArray() @ArrayMaxSize(100) @IsInt({ each: true }) proveedorIds!: number[];
  @IsOptional() @IsString() @MaxLength(2000) notas?: string;
}

class PedidoDirectoDto {
  @IsInt() proveedorId!: number;
  @IsOptional() @IsString() @MaxLength(2000) notas?: string;
}

class EditarPedidoDto {
  @IsOptional() @IsInt() proveedorId?: number;
  @IsOptional() @IsString() @MaxLength(2000) notas?: string;
}

class EstadoPedidoDto {
  @IsIn(ESTADOS as unknown as string[]) estado!: (typeof ESTADOS)[number];
}

class RevisadoDto {
  @IsOptional() deshacer?: boolean;
}

@Injectable()
export class PedidosProveedorService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Cuántos productos del catálogo trae cada proveedor — la pista de la
   *  tarjeta ("trae 34 productos") para saber si vale la pena revisar stock. */
  private async productosPorProveedor(ids: number[]) {
    const map = new Map<number, number>();
    if (!ids.length) return map;
    const filas = await this.db.select({
      proveedorId: productoProveedores.proveedorId,
      n: sql<number>`count(*)::int`,
    }).from(productoProveedores)
      .where(inArray(productoProveedores.proveedorId, ids))
      .groupBy(productoProveedores.proveedorId);
    for (const f of filas) map.set(f.proveedorId, Number(f.n) || 0);
    return map;
  }

  private baseSelect() {
    return {
      id: pedidosProveedor.id,
      proveedorId: pedidosProveedor.proveedorId,
      proveedorNombre: sql<string>`coalesce(${proveedores.nombre}, '')`,
      estado: pedidosProveedor.estado,
      notas: pedidosProveedor.notas,
      fechaAlta: pedidosProveedor.fechaAlta,
      fechaPedido: pedidosProveedor.fechaPedido,
      fechaRecepcion: pedidosProveedor.fechaRecepcion,
      pedidoEnviado: pedidosProveedor.pedidoEnviado,
      revisadoAt: pedidosProveedor.revisadoAt,
    };
  }

  /**
   * «VER STOCK» desde la tarjeta (5/10/2026): los productos que trae este
   * proveedor (su lista de productos) con lo disponible en total y por
   * sucursal (también la que quedó en negativo: si no, el detalle no suma el
   * total), y lo que viene en camino. Los que menos tienen, primero: es lo
   * que se mira para armar el pedido. Una consulta.
   */
  async stockDe(proveedorId: number) {
    const r = await this.db.execute(sql`
      select p.id, p.nombre, p.codigo_propio as codigo, p.tipo, p.estado,
        coalesce(sum(st.cantidad) filter (where st.estado = 'disponible'), 0)::float as disponible,
        coalesce(sum(st.cantidad) filter (where st.estado = 'en_transito'), 0)::float as "enCamino",
        coalesce((
          select json_agg(json_build_object('sucursal', x.nombre, 'cantidad', x.c) order by x.nombre)
          from (
            select su.nombre, sum(s2.cantidad)::float as c from stock s2 join sucursales su on su.id = s2.sucursal_id
            where s2.producto_id = p.id and s2.estado = 'disponible' group by su.nombre
            having abs(sum(s2.cantidad)) > 1e-9
          ) x
        ), '[]'::json) as "porSucursal"
      from producto_proveedores pp
      join productos p on p.id = pp.producto_id
      left join stock st on st.producto_id = p.id
      where pp.proveedor_id = ${proveedorId} and p.estado <> 'archivado'
      group by p.id
      order by disponible asc, p.nombre`);
    return r.rows;
  }

  /**
   * «SUS ÚLTIMOS INGRESOS» (5/10/2026): las últimas facturas, remitos y
   * liquidaciones confirmadas de este proveedor, con qué trajo cada una.
   * Sin costos por renglón: el total del comprobante alcanza para ubicarlo.
   */
  async ingresosDe(proveedorId: number) {
    const r = await this.db.execute(sql`
      select c.id, c.tipo, c.letra, c.punto_venta as "puntoVenta", c.numero, c.fecha, c.total::float as total,
        c.recepcion, coalesce(su.nombre, '') as sucursal,
        coalesce((
          select json_agg(json_build_object('nombre', p.nombre, 'cantidad', ci.cantidad, 'tipo', p.tipo) order by ci.id)
          from comprobante_items ci join productos p on p.id = ci.producto_id where ci.comprobante_id = c.id
        ), '[]'::json) as items
      from comprobantes c left join sucursales su on su.id = c.sucursal_id
      where c.proveedor_id = ${proveedorId} and c.estado = 'confirmado' and c.tipo in ('factura', 'remito', 'liquidacion')
      order by c.fecha desc, c.id desc
      limit 15`);
    return r.rows;
  }

  /** El kanban: todo lo que NO está recibido (los recibidos son historial). */
  async kanban() {
    const filas = await this.db.select(this.baseSelect())
      .from(pedidosProveedor)
      .leftJoin(proveedores, eq(proveedores.id, pedidosProveedor.proveedorId))
      .where(ne(pedidosProveedor.estado, 'recibido'))
      .orderBy(desc(pedidosProveedor.fechaAlta), desc(pedidosProveedor.id));
    const prods = await this.productosPorProveedor([...new Set(filas.map((f) => f.proveedorId))]);
    return filas.map((f) => ({ ...f, productosProveedor: prods.get(f.proveedorId) ?? 0 }));
  }

  async get(id: number) {
    const [p] = await this.db.select(this.baseSelect())
      .from(pedidosProveedor)
      .leftJoin(proveedores, eq(proveedores.id, pedidosProveedor.proveedorId))
      .where(eq(pedidosProveedor.id, id)).limit(1);
    if (!p) throw new NotFoundException('Pedido inexistente.');
    return p;
  }

  private async validarProveedor(id: number) {
    const [p] = await this.db.select({ id: proveedores.id }).from(proveedores)
      .where(eq(proveedores.id, id)).limit(1);
    if (!p) throw new BadRequestException('Proveedor inválido.');
  }

  async alta(dto: AltaPedidosDto, usuarioId: number | null) {
    const ids = [...new Set(dto.proveedorIds)].filter((x) => x > 0);
    if (!ids.length) throw new BadRequestException('Elegí al menos un proveedor.');
    const validos = await this.db.select({ id: proveedores.id }).from(proveedores)
      .where(inArray(proveedores.id, ids));
    if (!validos.length) throw new BadRequestException('Ningún proveedor válido.');
    const filas = await this.db.insert(pedidosProveedor).values(validos.map((p) => ({
      proveedorId: p.id,
      notas: (dto.notas ?? '').trim(),
      usuarioId,
    }))).returning({ id: pedidosProveedor.id });
    return { creados: filas.length, ids: filas.map((f) => f.id) };
  }

  /** "Ya lo pedí por teléfono, registralo": nace directo en Pedido, con fecha. */
  async directo(dto: PedidoDirectoDto, usuarioId: number | null) {
    await this.validarProveedor(dto.proveedorId);
    const [p] = await this.db.insert(pedidosProveedor).values({
      proveedorId: dto.proveedorId,
      estado: 'pedido',
      fechaPedido: new Date(),
      notas: (dto.notas ?? '').trim(),
      usuarioId,
    }).returning();
    return this.get(p.id);
  }

  async editar(id: number, dto: EditarPedidoDto) {
    await this.get(id);
    if (dto.proveedorId != null) await this.validarProveedor(dto.proveedorId);
    await this.db.update(pedidosProveedor).set({
      ...(dto.proveedorId != null ? { proveedorId: dto.proveedorId } : {}),
      ...(dto.notas !== undefined ? { notas: dto.notas.trim() } : {}),
    }).where(eq(pedidosProveedor.id, id));
    return this.get(id);
  }

  async cambiarEstado(id: number, nuevo: (typeof ESTADOS)[number]) {
    const actual = await this.get(id);
    const set: any = {
      estado: nuevo,
      // Los flags son de Solicitado: cualquier movimiento los limpia (regla
      // de la app: si la tarjeta vuelve, vuelve limpia para marcarla de nuevo).
      pedidoEnviado: false,
      revisadoAt: null,
    };
    // Las fechas se ganan al avanzar y no se pisan si ya estaban: el pedido
    // que va y vuelve conserva cuándo se pidió de verdad.
    if (nuevo === 'pedido' && !actual.fechaPedido) set.fechaPedido = new Date();
    if (nuevo === 'recibido') {
      set.fechaRecepcion = new Date();
      if (!actual.fechaPedido) set.fechaPedido = new Date();
    }
    await this.db.update(pedidosProveedor).set(set).where(eq(pedidosProveedor.id, id));
    return this.get(id);
  }

  async toggleEnviado(id: number) {
    const p = await this.get(id);
    if (p.estado !== 'solicitado') {
      throw new BadRequestException('El tilde "pedido enviado" es de las tarjetas en Solicitado.');
    }
    await this.db.update(pedidosProveedor).set({ pedidoEnviado: !p.pedidoEnviado })
      .where(eq(pedidosProveedor.id, id));
    return this.get(id);
  }

  async marcarRevisado(id: number, deshacer: boolean) {
    const p = await this.get(id);
    if (p.estado !== 'solicitado') {
      throw new BadRequestException('"Ya lo vi" es de las tarjetas en Solicitado.');
    }
    await this.db.update(pedidosProveedor).set({ revisadoAt: deshacer ? null : new Date() })
      .where(eq(pedidosProveedor.id, id));
    return this.get(id);
  }

  /** Borrado FÍSICO a propósito: es una pizarra, no historia contable. */
  async borrar(id: number) {
    await this.get(id);
    await this.db.delete(pedidosProveedor).where(eq(pedidosProveedor.id, id));
    return { ok: true };
  }

  /** El historial de recibidos, con cuánto tardó cada uno. */
  async recibidos(q: { filtro?: string; proveedorId?: number; buscar?: string; page?: number; limit?: number }) {
    const conds: any[] = [eq(pedidosProveedor.estado, 'recibido')];
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    if (q.filtro === 'semana') {
      conds.push(gte(pedidosProveedor.fechaRecepcion, new Date(hoy.getTime() - 7 * 86400000)));
    } else if (q.filtro === 'mes') {
      conds.push(gte(pedidosProveedor.fechaRecepcion, new Date(hoy.getFullYear(), hoy.getMonth(), 1)));
    } else if (q.filtro === 'mes_ant') {
      conds.push(gte(pedidosProveedor.fechaRecepcion, new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1)));
      conds.push(sql`${pedidosProveedor.fechaRecepcion} < ${new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString()}`);
    }
    if (q.proveedorId) conds.push(eq(pedidosProveedor.proveedorId, q.proveedorId));
    if (q.buscar?.trim()) {
      const like = `%${q.buscar.trim()}%`;
      conds.push(sql`(${proveedores.nombre} ILIKE ${like} OR ${pedidosProveedor.notas} ILIKE ${like})`);
    }
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 50));

    const [meta] = await this.db.select({ n: sql<number>`count(*)::int` })
      .from(pedidosProveedor)
      .leftJoin(proveedores, eq(proveedores.id, pedidosProveedor.proveedorId))
      .where(and(...conds));

    const filas = await this.db.select(this.baseSelect())
      .from(pedidosProveedor)
      .leftJoin(proveedores, eq(proveedores.id, pedidosProveedor.proveedorId))
      .where(and(...conds))
      .orderBy(desc(pedidosProveedor.fechaRecepcion), desc(pedidosProveedor.id))
      .limit(limit).offset((page - 1) * limit);

    /* El promedio de demora pedido→recepción, sobre TODOS los recibidos con
     * fecha de pedido — es la referencia de "cuánto tarda", no un dato de la
     * página. Y el total del mes corriente para la tarjeta de arriba. */
    const [globales] = await this.db.select({
      promedioDias: sql<number>`coalesce(avg(extract(epoch from (${pedidosProveedor.fechaRecepcion} - ${pedidosProveedor.fechaPedido})) / 86400), 0)`,
      totalMes: sql<number>`count(*) filter (where ${pedidosProveedor.fechaRecepcion} >= ${new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString()})::int`,
    }).from(pedidosProveedor)
      .where(and(eq(pedidosProveedor.estado, 'recibido'), sql`${pedidosProveedor.fechaPedido} IS NOT NULL`));

    return {
      filas: filas.map((f) => ({
        ...f,
        dias: f.fechaPedido && f.fechaRecepcion
          ? Math.round((f.fechaRecepcion.getTime() - f.fechaPedido.getTime()) / 86400000)
          : null,
      })),
      total: Number(meta?.n) || 0,
      page,
      pages: Math.max(1, Math.ceil((Number(meta?.n) || 0) / limit)),
      promedioDias: Math.round((Number(globales?.promedioDias) || 0) * 10) / 10,
      totalMes: Number(globales?.totalMes) || 0,
    };
  }

  async stats() {
    const filas = await this.db.select({
      estado: pedidosProveedor.estado,
      n: sql<number>`count(*)::int`,
    }).from(pedidosProveedor).groupBy(pedidosProveedor.estado);
    const por: Record<string, number> = { solicitado: 0, pedido: 0, recibido: 0, retomar: 0 };
    for (const f of filas) por[f.estado] = Number(f.n) || 0;
    return { ...por, pendientes: por.solicitado + por.pedido };
  }
}

@Controller('pedidos-proveedor')
@Permiso('proveedores.pedidos')
export class PedidosProveedorController {
  constructor(private readonly svc: PedidosProveedorService) {}

  @Get() kanban() { return this.svc.kanban(); }
  /* El menú del nombre en la tarjeta (5/10/2026): su stock y sus últimos ingresos. */
  @Get('proveedor/:id/stock') stockDe(@Param('id', ParseIntPipe) id: number) { return this.svc.stockDe(id); }
  @Get('proveedor/:id/ingresos') ingresosDe(@Param('id', ParseIntPipe) id: number) { return this.svc.ingresosDe(id); }
  @Get('stats') stats() { return this.svc.stats(); }
  @Get('recibidos') recibidos(
    @Query('filtro') filtro?: string,
    @Query('proveedorId') proveedorId?: string,
    @Query('buscar') buscar?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.recibidos({
      filtro,
      proveedorId: proveedorId ? Number(proveedorId) : undefined,
      buscar,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post() alta(@Body() dto: AltaPedidosDto, @Auth() auth: Sesion) {
    return this.svc.alta(dto, auth.usuarioId ?? null);
  }
  @Post('directo') directo(@Body() dto: PedidoDirectoDto, @Auth() auth: Sesion) {
    return this.svc.directo(dto, auth.usuarioId ?? null);
  }
  @Patch(':id') editar(@Param('id', ParseIntPipe) id: number, @Body() dto: EditarPedidoDto) {
    return this.svc.editar(id, dto);
  }
  @Patch(':id/estado') estado(@Param('id', ParseIntPipe) id: number, @Body() dto: EstadoPedidoDto) {
    return this.svc.cambiarEstado(id, dto.estado);
  }
  @Post(':id/enviado') enviado(@Param('id', ParseIntPipe) id: number) {
    return this.svc.toggleEnviado(id);
  }
  @Post(':id/revisado') revisado(@Param('id', ParseIntPipe) id: number, @Body() dto: RevisadoDto) {
    return this.svc.marcarRevisado(id, !!dto?.deshacer);
  }
  @Delete(':id') borrar(@Param('id', ParseIntPipe) id: number) {
    return this.svc.borrar(id);
  }
}

@Module({
  controllers: [PedidosProveedorController],
  providers: [PedidosProveedorService],
})
export class PedidosProveedorModule {}
