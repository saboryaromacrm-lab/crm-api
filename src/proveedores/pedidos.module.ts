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
 *                que mide además cuántos días tardó cada proveedor, y el
 *                banner de facturas sin cargar (7/11/2026, `sin-factura.ts`).
 *   retomar    → aparcado sin fecha: ni urge ni murió.
 *
 * CUALQUIER cambio de estado resetea los dos flags: solo significan algo
 * mientras la tarjeta está en Solicitado, y si vuelve, vuelve limpia.
 *
 * UNA SOLA TARJETA ABIERTA POR PROVEEDOR (0223, 7/11/2026: «quedan muchos
 * repetidos, el que creás con la orden de pedido y el de Solicitado»). La
 * orden de pedido y «Ya lo pedí» usan la que ya está (la pasan a Pedido y le
 * suman la nota); Solicitar saltea a los que ya están en el tablero.
 */
import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, Injectable, Module,
  NotFoundException, Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import {
  ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, MaxLength,
} from 'class-validator';
import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { Auth, CualquierUsuario, Permiso, type Sesion } from '../auth/auth.decoradores';
import { esJefe } from '../auth/auth.guard';
import { DRIZZLE, Database } from '../db/drizzle';
import { pedidosProveedor, productoProveedores, proveedores } from '../db/schema';
import { desdeDe, sinFactura } from './sin-factura';

const ESTADOS = ['solicitado', 'pedido', 'recibido', 'retomar'] as const;

class AltaPedidosDto {
  /** Alta de a varios: una tarjeta por proveedor, todas en Solicitado. */
  @IsArray() @ArrayMaxSize(100) @IsInt({ each: true }) proveedorIds!: number[];
  @IsOptional() @IsString() @MaxLength(2000) notas?: string;
}

/* 8000: la orden de pedido de Almacén (12/10/2026) anota la lista entera como nota. */
class PedidoDirectoDto {
  @IsInt() proveedorId!: number;
  @IsOptional() @IsString() @MaxLength(8000) notas?: string;
}

class EditarPedidoDto {
  @IsOptional() @IsInt() proveedorId?: number;
  @IsOptional() @IsString() @MaxLength(8000) notas?: string;
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
   * LA ÚLTIMA VEZ QUE ENTRÓ SU MERCADERÍA (26/10/2026, pedido del dueño): el
   * último comprobante confirmado de este proveedor que ingresó stock, con
   * cuánto entró de cada producto y el bulto con que se cargó (0161), para
   * comparar al armar el pedido nuevo. Un renglón por producto: la bonificación
   * (renglón a costo 0) se suma al total y se informa aparte (`sinCargo`). `ingreso: null` si nunca entró nada
   * (en un objeto: un `null` suelto viaja como cuerpo vacío). Sin costos.
   */
  async ultimoIngresoDe(proveedorId: number) {
    const r = await this.db.execute(sql`
      select c.id, c.tipo, c.letra, c.punto_venta as "puntoVenta", c.numero, c.fecha, coalesce(su.nombre, '') as sucursal,
        coalesce((
          select json_agg(json_build_object('nombre', x.nombre, 'granel', x.granel, 'tamKg', x.tam_kg,
                   'cantidad', x.cantidad, 'sinCargo', x.sin_cargo, 'porBulto', x.por_bulto, 'porDisplay', x.por_display) order by x.orden)
          from (
            select p.nombre, p.tipo = 'granel' as granel, pr.tam_kg, min(ci.id) as orden,
              sum(ci.cantidad) as cantidad,
              coalesce(sum(ci.cantidad) filter (where ci.costo_unitario <= 0), 0) as sin_cargo,
              max(ci.por_bulto) filter (where ci.costo_unitario > 0) as por_bulto,
              max(ci.por_display) filter (where ci.costo_unitario > 0) as por_display
            from comprobante_items ci join productos p on p.id = ci.producto_id
            left join presentaciones pr on pr.id = ci.presentacion_id
            where ci.comprobante_id = c.id
            group by p.id, pr.id
          ) x
        ), '[]'::json) as items
      from comprobantes c left join sucursales su on su.id = c.sucursal_id
      where c.proveedor_id = ${proveedorId} and c.estado = 'confirmado' and c.recepcion
        and c.tipo in ('factura', 'remito', 'liquidacion')
      order by c.fecha desc, c.id desc
      limit 1`);
    return { ingreso: r.rows[0] ?? null };
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

  /**
   * LO QUE LLEGÓ Y SU FACTURA NO SE CARGÓ (7/11/2026): el banner de
   * administración. Las tarjetas en «Recibido» que nadie dio por resueltas,
   * contra los comprobantes que entraron stock de esos proveedores; la regla
   * que los empareja, en `sin-factura.ts`.
   */
  async sinFactura() {
    const r = await this.db.execute(sql`
      select pp.id, pp.proveedor_id as "proveedorId", pr.nombre as proveedor, pp.notas,
        pp.fecha_pedido as "fechaPedido", pp.fecha_recepcion as "fechaRecepcion"
      from pedidos_proveedor pp join proveedores pr on pr.id = pp.proveedor_id
      where pp.estado = 'recibido' and pp.fecha_recepcion is not null and pp.factura_resuelta_en is null`);
    const recibidas = (r.rows as any[]).map((x) => ({
      ...x, fechaPedido: x.fechaPedido ? new Date(x.fechaPedido) : null, fechaRecepcion: new Date(x.fechaRecepcion),
    }));
    if (!recibidas.length) return { pedidos: [] };
    const provs = [...new Set(recibidas.map((x) => x.proveedorId as number))];
    const c = await this.db.execute(sql`
      select proveedor_id as "proveedorId", greatest(fecha, fecha_carga) as en
      from comprobantes
      where estado = 'confirmado' and recepcion and tipo in ('factura', 'remito', 'liquidacion')
        and proveedor_id in (${sql.join(provs.map((i) => sql`${i}`), sql`, `)})
        and greatest(fecha, fecha_carga) >= ${new Date(Math.min(...recibidas.map(desdeDe)))}`);
    const cargas = (c.rows as any[]).map((x) => ({ proveedorId: x.proveedorId as number, en: new Date(x.en) }));
    return { pedidos: sinFactura(recibidas, cargas) };
  }

  /** «Ya está» en el banner: deja de avisar por esta tarjeta, con quién y cuándo (0222). */
  async resolverFactura(id: number, usuarioId: number | null) {
    const [p] = await this.db.update(pedidosProveedor)
      .set({ facturaResueltaEn: new Date(), facturaResueltaPor: usuarioId })
      .where(and(eq(pedidosProveedor.id, id), eq(pedidosProveedor.estado, 'recibido')))
      .returning({ id: pedidosProveedor.id });
    if (!p) throw new NotFoundException('Ese pedido no está como recibido (¿lo borraron?). Actualizá la pantalla.');
    return { ok: true };
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

  /** La tarjeta abierta (no recibida) del proveedor: hay una sola (0223). */
  private async abiertaDe(proveedorId: number) {
    const [p] = await this.db.select().from(pedidosProveedor)
      .where(and(eq(pedidosProveedor.proveedorId, proveedorId), ne(pedidosProveedor.estado, 'recibido'))).limit(1);
    return p ?? null;
  }

  /** Volver una tarjeta al tablero (o pasarla a otro proveedor) no puede dejar dos del mismo. */
  private async sinOtraAbierta(proveedorId: number) {
    if (await this.abiertaDe(proveedorId)) {
      throw new BadRequestException('Ese proveedor ya tiene su tarjeta en el tablero: sumá la nota ahí.');
    }
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
    /* Los que ya tienen su tarjeta en el tablero no suman otra (el índice cubre los clics simultáneos). */
    const filas = await this.db.insert(pedidosProveedor).values(validos.map((p) => ({
      proveedorId: p.id,
      notas: (dto.notas ?? '').trim(),
      usuarioId,
    }))).onConflictDoNothing().returning({ id: pedidosProveedor.id });
    return { creados: filas.length, yaEstaban: validos.length - filas.length, ids: filas.map((f) => f.id) };
  }

  /**
   * "Ya lo pedí, registralo" (y la orden de pedido de Almacén): nace en Pedido
   * con fecha. Si el proveedor ya tiene su tarjeta abierta, es esa: pasa a
   * Pedido (sin pisar el día en que se pidió) y la nota nueva va debajo de la
   * que tenía. `yaEstaba` dice en qué columna estaba.
   */
  async directo(dto: PedidoDirectoDto, usuarioId: number | null): Promise<any> {
    await this.validarProveedor(dto.proveedorId);
    const notas = (dto.notas ?? '').trim();
    const abierta = await this.abiertaDe(dto.proveedorId);
    if (abierta) {
      await this.db.update(pedidosProveedor).set({
        estado: 'pedido',
        fechaPedido: abierta.fechaPedido ?? new Date(),
        pedidoEnviado: false,
        revisadoAt: null,
        notas: abierta.notas === notas ? notas : [abierta.notas.trim(), notas].filter(Boolean).join('\n\n'),
      }).where(eq(pedidosProveedor.id, abierta.id));
      return { ...(await this.get(abierta.id)), yaEstaba: abierta.estado };
    }
    const [p] = await this.db.insert(pedidosProveedor).values({
      proveedorId: dto.proveedorId,
      estado: 'pedido',
      fechaPedido: new Date(),
      notas,
      usuarioId,
    }).onConflictDoNothing().returning();
    /* Otro la creó en el mismo instante: ahora está, y se usa esa. */
    return p ? this.get(p.id) : this.directo(dto, usuarioId);
  }

  async editar(id: number, dto: EditarPedidoDto) {
    const actual = await this.get(id);
    if (dto.proveedorId != null && dto.proveedorId !== actual.proveedorId) {
      await this.validarProveedor(dto.proveedorId);
      if (actual.estado !== 'recibido') await this.sinOtraAbierta(dto.proveedorId);
    }
    await this.db.update(pedidosProveedor).set({
      ...(dto.proveedorId != null ? { proveedorId: dto.proveedorId } : {}),
      ...(dto.notas !== undefined ? { notas: dto.notas.trim() } : {}),
    }).where(eq(pedidosProveedor.id, id));
    return this.get(id);
  }

  async cambiarEstado(id: number, nuevo: (typeof ESTADOS)[number]) {
    const actual = await this.get(id);
    if (actual.estado === 'recibido' && nuevo !== 'recibido') await this.sinOtraAbierta(actual.proveedorId);
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
  /* Al escribir el pedido (26/10/2026): cuánto entró la última vez. */
  @Get('proveedor/:id/ultimo-ingreso') ultimoIngresoDe(@Param('id', ParseIntPipe) id: number) { return this.svc.ultimoIngresoDe(id); }
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

  /* El banner de facturas sin cargar (7/11/2026): administración, esté en la pantalla que esté. */
  @Get('sin-factura') @CualquierUsuario()
  sinFactura(@Auth() auth: Sesion) {
    if (!esJefe(auth)) throw new ForbiddenException('Las facturas sin cargar las ve administración.');
    return this.svc.sinFactura();
  }
  @Post(':id/factura-resuelta') @CualquierUsuario()
  facturaResuelta(@Param('id', ParseIntPipe) id: number, @Auth() auth: Sesion) {
    if (!esJefe(auth)) throw new ForbiddenException('Lo da por resuelto administración.');
    return this.svc.resolverFactura(id, auth.usuarioId ?? null);
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
