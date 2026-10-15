/**
 * PEDIDOS DE FRACCIONADO DE LA DISTRIBUIDORA (0169, 15/10/2026, pedido del dueño)
 * ============================================================================
 * Los locales le piden paquetes a la Distribuidora con el pedido entre
 * sucursales; la Distribuidora no podía pedirse a sí misma. Esto es esa lista:
 * qué paquetes armar para su propia góndola, guardada e imprimible.
 *
 *   · PENDIENTE: se arma, se edita, se imprime o se descarta. No toca stock.
 *   · HECHO: el fraccionador carga lo fraccionado desde el pedido (el registro
 *     de siempre, precargado) y en la MISMA transacción que mueve el stock el
 *     pedido se cierra y apunta a ese registro (`opFraccionarRegistro` con `pedidoId`).
 *     Lo fraccionado de verdad se lee del registro, no se copia.
 *
 * Solo la Distribuidora: la sucursal la pone el servidor.
 */
import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, Injectable,
  NotFoundException, Param, ParseIntPipe, Post, Put,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { Auth, Permiso, Sesion } from '../auth/auth.decoradores';
import { tienePermiso } from '../auth/auth.guard';
import { DRIZZLE, Database } from '../db/drizzle';
import { fraccionPedidoItems, fraccionPedidos, presentaciones, productos, sucursales, usuarios } from '../db/schema';

/** Cuántos pedidos hechos se muestran debajo de los pendientes. */
const HECHOS_A_LA_VISTA = 30;

class RenglonPedidoDto {
  @IsInt() presentacionId!: number;
  @IsInt() @Min(1, { message: 'Los paquetes van desde 1.' }) @Max(100_000) paquetes!: number;
}

class PedidoFraccionDto {
  @IsArray() @ArrayNotEmpty({ message: 'Pedí al menos un paquete.' }) @ArrayMaxSize(1000)
  @ValidateNested({ each: true }) @Type(() => RenglonPedidoDto)
  items!: RenglonPedidoDto[];
  @IsOptional() @IsString() @MaxLength(300) observaciones?: string;
}

export const codigoPedidoFraccion = (id: number) => `PF${String(id).padStart(4, '0')}`;

@Injectable()
export class PedidosFraccionService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** La Distribuidora: el único lugar donde existen estos pedidos. */
  async distribuidora(tx: any = this.db) {
    const [d] = await tx.select({ id: sucursales.id, nombre: sucursales.nombre }).from(sucursales)
      .where(and(eq(sucursales.tipo, 'distribuidora'), eq(sucursales.activa, true))).orderBy(sucursales.id).limit(1);
    if (!d) throw new BadRequestException('No hay una Distribuidora activa.');
    return d;
  }

  /** Los pendientes (todos) y los últimos hechos, con sus renglones y, en los hechos, lo que se fraccionó. */
  async listar() {
    const dist = await this.distribuidora();
    const r: any = await this.db.execute(sql`
      (SELECT * FROM fraccion_pedidos WHERE sucursal_id = ${dist.id} AND estado = 'pendiente' ORDER BY creado_en)
      UNION ALL
      (SELECT * FROM fraccion_pedidos WHERE sucursal_id = ${dist.id} AND estado = 'hecho' ORDER BY hecho_en DESC LIMIT ${HECHOS_A_LA_VISTA})`);
    const cab = (r.rows ?? r) as any[];
    if (!cab.length) return { distribuidora: dist, pedidos: [] };
    const ids = cab.map((c) => c.id);
    const regs = cab.map((c) => c.fraccionamiento_id).filter(Boolean);
    const usrIds = [...new Set(cab.flatMap((c) => [c.usuario_id, c.hecho_por]).filter(Boolean))];
    const [items, hecho, usrs] = await Promise.all([
      this.db.select({
        id: fraccionPedidoItems.id, pedidoId: fraccionPedidoItems.pedidoId, productoId: fraccionPedidoItems.productoId,
        presentacionId: fraccionPedidoItems.presentacionId, tamKg: fraccionPedidoItems.tamKg, paquetes: fraccionPedidoItems.paquetes,
        nombre: productos.nombre,
      }).from(fraccionPedidoItems).innerJoin(productos, eq(productos.id, fraccionPedidoItems.productoId))
        .where(inArray(fraccionPedidoItems.pedidoId, ids)).orderBy(productos.nombre, desc(fraccionPedidoItems.tamKg)),
      regs.length
        ? this.db.execute(sql`
            SELECT fraccionamiento_id AS reg, producto_id AS p, presentacion_id AS pr, sum(paquetes)::int AS n
              FROM fraccionamiento_items WHERE fraccionamiento_id IN (${sql.join(regs.map((x) => sql`${x}`), sql`, `)})
             GROUP BY 1, 2, 3`)
        : Promise.resolve({ rows: [] }),
      usrIds.length
        ? this.db.select({ id: usuarios.id, nombre: usuarios.nombre }).from(usuarios).where(inArray(usuarios.id, usrIds as number[]))
        : Promise.resolve([] as { id: number; nombre: string }[]),
    ]);
    const nombreUsr = new Map(usrs.map((u) => [u.id, u.nombre]));
    const fraccionado = new Map<string, number>();
    for (const x of ((hecho as any).rows ?? hecho) as any[]) fraccionado.set(`${x.reg}:${x.p}:${x.pr}`, Number(x.n));
    return {
      distribuidora: dist,
      pedidos: cab.map((c) => {
        const suyos = items.filter((it) => it.pedidoId === c.id).map((it) => ({
          ...it,
          fraccionados: c.estado === 'hecho' ? (fraccionado.get(`${c.fraccionamiento_id}:${it.productoId}:${it.presentacionId}`) ?? 0) : null,
        }));
        return {
          id: c.id, codigo: codigoPedidoFraccion(c.id), estado: c.estado, observaciones: c.observaciones,
          creadoEn: c.creado_en, actualizadoEn: c.actualizado_en, usuario: nombreUsr.get(c.usuario_id) ?? null,
          hechoEn: c.hecho_en, hechoPor: nombreUsr.get(c.hecho_por) ?? null, fraccionamientoId: c.fraccionamiento_id,
          items: suyos,
          paquetes: suyos.reduce((a, it) => a + it.paquetes, 0),
          kg: Math.round(suyos.reduce((a, it) => a + it.paquetes * it.tamKg, 0) * 1000) / 1000,
        };
      }),
    };
  }

  /** Los renglones validados: paquetes de un granel que no esté archivado, sin repetir (el mismo paquete dos veces suma). */
  private async renglones(tx: any, dto: PedidoFraccionDto) {
    const porPres = new Map<number, number>();
    for (const it of dto.items) porPres.set(it.presentacionId, (porPres.get(it.presentacionId) ?? 0) + it.paquetes);
    const press = await tx.select({
      id: presentaciones.id, productoId: presentaciones.productoId, tamKg: presentaciones.tamKg,
      tipo: productos.tipo, estado: productos.estado, nombre: productos.nombre,
    }).from(presentaciones).innerJoin(productos, eq(productos.id, presentaciones.productoId))
      .where(inArray(presentaciones.id, [...porPres.keys()]));
    if (press.length !== porPres.size) throw new BadRequestException('Uno de los paquetes ya no existe: actualizá la pantalla.');
    for (const p of press) {
      if (p.tipo !== 'granel') throw new BadRequestException(`${p.nombre} no es a granel: no se fracciona.`);
      if (p.estado === 'archivado') throw new BadRequestException(`${p.nombre} está archivado: no se fracciona.`);
    }
    return press.map((p: any) => ({ productoId: p.productoId, presentacionId: p.id, tamKg: Number(p.tamKg), paquetes: porPres.get(p.id)! }));
  }

  async crear(dto: PedidoFraccionDto, usuarioId: number | null) {
    const id = await this.db.transaction(async (tx) => {
      const dist = await this.distribuidora(tx);
      const filas = await this.renglones(tx, dto);
      const [c] = await tx.insert(fraccionPedidos).values({
        sucursalId: dist.id, observaciones: (dto.observaciones ?? '').trim(), usuarioId,
      }).returning({ id: fraccionPedidos.id });
      await tx.insert(fraccionPedidoItems).values(filas.map((f: any) => ({ ...f, pedidoId: c.id })));
      return c.id;
    });
    return { ok: true, id, codigo: codigoPedidoFraccion(id) };
  }

  /** Con candado: un pedido que se está cargando como fraccionado ya no se toca. */
  private async pendiente(tx: any, id: number) {
    const [c] = await tx.select().from(fraccionPedidos).where(eq(fraccionPedidos.id, id)).limit(1).for('update');
    if (!c) throw new NotFoundException('Ese pedido no existe.');
    if (c.estado !== 'pendiente') throw new BadRequestException(`${codigoPedidoFraccion(id)} ya está hecho: no se cambia.`);
    return c;
  }

  async editar(id: number, dto: PedidoFraccionDto) {
    await this.db.transaction(async (tx) => {
      await this.pendiente(tx, id);
      const filas = await this.renglones(tx, dto);
      await tx.delete(fraccionPedidoItems).where(eq(fraccionPedidoItems.pedidoId, id));
      await tx.insert(fraccionPedidoItems).values(filas.map((f: any) => ({ ...f, pedidoId: id })));
      await tx.update(fraccionPedidos).set({ observaciones: (dto.observaciones ?? '').trim(), actualizadoEn: new Date() })
        .where(eq(fraccionPedidos.id, id));
    });
    return { ok: true, id, codigo: codigoPedidoFraccion(id) };
  }

  /** Descartar un pendiente: nunca movió nada, así que se borra (como el borrador de un pedido entre sucursales). */
  async descartar(id: number) {
    await this.db.transaction(async (tx) => {
      await this.pendiente(tx, id);
      await tx.delete(fraccionPedidos).where(eq(fraccionPedidos.id, id));
    });
    return { ok: true };
  }
}

/** Armar, editar y descartar pide también «Pedir y recibir mercadería». */
function exigirPedir(sesion: Sesion) {
  if (!tienePermiso(sesion?.permisos ?? [], ['pedidos'])) {
    throw new ForbiddenException('Armar pedidos de fraccionado pide el permiso «Pedir y recibir mercadería».');
  }
}

@Controller('pedidos-fraccion')
@Permiso('almacen.fraccionamiento')
export class PedidosFraccionController {
  constructor(private readonly svc: PedidosFraccionService) {}

  @Get() listar() { return this.svc.listar(); }

  @Post() crear(@Body() dto: PedidoFraccionDto, @Auth() sesion: Sesion) {
    exigirPedir(sesion);
    return this.svc.crear(dto, sesion?.usuarioId ?? null);
  }

  @Put(':id') editar(@Param('id', ParseIntPipe) id: number, @Body() dto: PedidoFraccionDto, @Auth() sesion: Sesion) {
    exigirPedir(sesion);
    return this.svc.editar(id, dto);
  }

  @Delete(':id') descartar(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) {
    exigirPedir(sesion);
    return this.svc.descartar(id);
  }
}
