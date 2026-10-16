/**
 * PEDIDOS DE FRACCIONADO (0169 y 0170, pedidos del dueño)
 * ============================================================================
 * Dos orígenes, el mismo pedido (paquetes de granel que hay que armar):
 *
 * DE LA DISTRIBUIDORA (0169) — la lista para su propia góndola.
 *   · PENDIENTE: se arma, se edita, se imprime o se descarta. No toca stock.
 *   · HECHO: el fraccionador carga lo fraccionado desde el pedido (el registro
 *     de siempre, precargado) y en la MISMA transacción que mueve el stock el
 *     pedido se cierra y apunta a ese registro (`opFraccionarRegistro` con `pedidoId`).
 *
 * DE LA CAJA (0170) — «un paquete de avena de 400 g» para el cliente que espera.
 *   · PENDIENTE: el cajero lo pidió; fraccionado lo ve en el aviso (suena).
 *   · ARMANDO: alguien lo tomó y eligió el operador que lo arma.
 *   · HECHO: «Listo» registra el fraccionado con ese operador, todo junto.
 *   · RECHAZADO: «No se puede», con el motivo. El cajero ve cómo terminó hasta
 *     que lo marca visto.
 *   · CANCELADO (0171): el cajero que lo pidió lo cancela entero o por renglón
 *     mientras no esté cerrado; lo cancelado queda marcado, no se borra.
 *
 * Lo fraccionado de verdad se lee del registro, no se copia. Solo existen en
 * la Distribuidora: la sucursal la pone el servidor.
 */
import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, Injectable,
  NotFoundException, Param, ParseIntPipe, Post, Put, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayNotEmpty, IsArray, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Auth, Permiso, Sesion } from '../auth/auth.decoradores';
import { tienePermiso } from '../auth/auth.guard';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  fraccionOperadores, fraccionPedidoItems, fraccionPedidos, presentaciones, productos, sucursales, usuarios,
} from '../db/schema';
import { InventarioService } from './inventario.service';

/** Cuántos pedidos hechos se muestran debajo de los pendientes. */
const HECHOS_A_LA_VISTA = 30;
/** El historial de la caja trae a lo sumo esto por consulta. */
const HISTORIAL_MAX = 500;
/** Cuánto sigue en el aviso de fraccionado lo que la caja canceló mientras se armaba. */
const CANCELADO_A_LA_VISTA = '3 minutes';
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

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

class TomarDto {
  @IsOptional() @IsInt() operadorId?: number;
}

class CancelarDto {
  /** Sin renglón: el pedido entero. */
  @IsOptional() @IsInt() itemId?: number;
}

class RechazarDto {
  @IsString() @IsNotEmpty({ message: 'Decí por qué no se puede.' }) @MaxLength(120) motivo!: string;
}

export const codigoPedidoFraccion = (id: number) => `PF${String(id).padStart(4, '0')}`;

@Injectable()
export class PedidosFraccionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly inv: InventarioService,
  ) {}

  /** La Distribuidora: el único lugar donde existen estos pedidos. */
  async distribuidora(tx: any = this.db) {
    const [d] = await tx.select({ id: sucursales.id, nombre: sucursales.nombre }).from(sucursales)
      .where(and(eq(sucursales.tipo, 'distribuidora'), eq(sucursales.activa, true))).orderBy(sucursales.id).limit(1);
    if (!d) throw new BadRequestException('No hay una Distribuidora activa.');
    return d;
  }

  /**
   * Las cabeceras (filas crudas de `fraccion_pedidos`) con sus renglones, los
   * nombres de quién pidió, tomó y cerró, el operador y, en los hechos, cuánto
   * se fraccionó de cada renglón. Lo que la caja canceló (0171) va aparte, en
   * `cancelados`: no cuenta en los totales ni se arma.
   */
  private async armar(cab: any[]) {
    if (!cab.length) return [];
    const ids = cab.map((c) => c.id);
    const regs = cab.map((c) => c.fraccionamiento_id).filter(Boolean);
    const usrIds = [...new Set(cab.flatMap((c) => [c.usuario_id, c.hecho_por, c.tomado_por]).filter(Boolean))];
    const opIds = [...new Set(cab.map((c) => c.operador_id).filter(Boolean))];
    const [items, hecho, usrs, ops] = await Promise.all([
      this.db.select({
        id: fraccionPedidoItems.id, pedidoId: fraccionPedidoItems.pedidoId, productoId: fraccionPedidoItems.productoId,
        presentacionId: fraccionPedidoItems.presentacionId, tamKg: fraccionPedidoItems.tamKg, paquetes: fraccionPedidoItems.paquetes,
        canceladoEn: fraccionPedidoItems.canceladoEn, nombre: productos.nombre,
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
      opIds.length
        ? this.db.select({ id: fraccionOperadores.id, nombre: fraccionOperadores.nombre }).from(fraccionOperadores)
          .where(inArray(fraccionOperadores.id, opIds as number[]))
        : Promise.resolve([] as { id: number; nombre: string }[]),
    ]);
    const nombreUsr = new Map(usrs.map((u) => [u.id, u.nombre]));
    const nombreOp = new Map(ops.map((o) => [o.id, o.nombre]));
    const fraccionado = new Map<string, number>();
    for (const x of ((hecho as any).rows ?? hecho) as any[]) fraccionado.set(`${x.reg}:${x.p}:${x.pr}`, Number(x.n));
    return cab.map((c) => {
      const suyos = items.filter((it) => it.pedidoId === c.id && !it.canceladoEn).map((it) => ({
        ...it,
        fraccionados: c.estado === 'hecho' ? (fraccionado.get(`${c.fraccionamiento_id}:${it.productoId}:${it.presentacionId}`) ?? 0) : null,
      }));
      return {
        id: c.id, codigo: codigoPedidoFraccion(c.id), origen: c.origen, estado: c.estado, observaciones: c.observaciones,
        creadoEn: c.creado_en, actualizadoEn: c.actualizado_en, usuario: nombreUsr.get(c.usuario_id) ?? null,
        hechoEn: c.hecho_en, hechoPor: nombreUsr.get(c.hecho_por) ?? null, fraccionamientoId: c.fraccionamiento_id,
        tomadoEn: c.tomado_en, tomadoPor: nombreUsr.get(c.tomado_por) ?? null,
        operadorId: c.operador_id, operador: nombreOp.get(c.operador_id) ?? null,
        motivo: c.motivo, vistoEn: c.visto_en,
        items: suyos,
        cancelados: items.filter((it) => it.pedidoId === c.id && it.canceladoEn),
        paquetes: suyos.reduce((a, it) => a + it.paquetes, 0),
        kg: Math.round(suyos.reduce((a, it) => a + it.paquetes * it.tamKg, 0) * 1000) / 1000,
      };
    });
  }

  /** Filas crudas de una consulta SQL. */
  private async filas(q: any) { const r: any = await this.db.execute(q); return (r.rows ?? r) as any[]; }

  /* ============================ DISTRIBUIDORA ============================ */

  /** Los pendientes (todos) y los últimos hechos de la lista propia. */
  async listar() {
    const dist = await this.distribuidora();
    const cab = await this.filas(sql`
      (SELECT * FROM fraccion_pedidos WHERE sucursal_id = ${dist.id} AND origen = 'distribuidora' AND estado = 'pendiente' ORDER BY creado_en)
      UNION ALL
      (SELECT * FROM fraccion_pedidos WHERE sucursal_id = ${dist.id} AND origen = 'distribuidora' AND estado = 'hecho'
        ORDER BY hecho_en DESC LIMIT ${HECHOS_A_LA_VISTA})`);
    return { distribuidora: dist, pedidos: await this.armar(cab) };
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

  /** Un pedido nuevo con sus renglones, de la lista propia o de la caja. */
  private async insertar(dto: PedidoFraccionDto, usuarioId: number | null, origen: 'distribuidora' | 'caja', sucursalSesion?: number) {
    const id = await this.db.transaction(async (tx) => {
      const dist = await this.distribuidora(tx);
      if (sucursalSesion !== undefined && sucursalSesion !== dist.id) {
        throw new BadRequestException(`Pedir a fraccionado es solo en ${dist.nombre}.`);
      }
      const filas = await this.renglones(tx, dto);
      const [c] = await tx.insert(fraccionPedidos).values({
        sucursalId: dist.id, origen, observaciones: (dto.observaciones ?? '').trim(), usuarioId,
      }).returning({ id: fraccionPedidos.id });
      await tx.insert(fraccionPedidoItems).values(filas.map((f: any) => ({ ...f, pedidoId: c.id })));
      return c.id;
    });
    return { ok: true, id, codigo: codigoPedidoFraccion(id) };
  }

  crear(dto: PedidoFraccionDto, usuarioId: number | null) { return this.insertar(dto, usuarioId, 'distribuidora'); }

  /** Con candado: un pedido que se está cargando como fraccionado ya no se toca. */
  private async pendiente(tx: any, id: number) {
    const [c] = await tx.select().from(fraccionPedidos).where(eq(fraccionPedidos.id, id)).limit(1).for('update');
    if (!c) throw new NotFoundException('Ese pedido no existe.');
    if (c.origen !== 'distribuidora') throw new BadRequestException(`${codigoPedidoFraccion(id)} lo pidió la caja: se atiende desde el aviso.`);
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

  /* ================================ CAJA ================================ */

  /** El cajero pide: solo desde una sesión en la Distribuidora. */
  pedirDesdeCaja(dto: PedidoFraccionDto, sesion: Sesion) {
    return this.insertar(dto, sesion.usuarioId ?? null, 'caja', sesion.sucursalId);
  }

  /**
   * Lo que fraccionado tiene que atender (el aviso): pendientes y armándose, y
   * por unos minutos lo que la caja canceló cuando ya lo estaban armando (0171:
   * para que no lo terminen). Fuera de la Distribuidora no aplica y el ERP deja
   * de preguntar.
   */
  async abiertos(sesion: Sesion) {
    const dist = await this.distribuidora();
    if (sesion.sucursalId !== dist.id) return { aplica: false, pedidos: [] };
    const cab = await this.filas(sql`
      SELECT * FROM fraccion_pedidos
       WHERE sucursal_id = ${dist.id} AND origen = 'caja'
         AND (estado IN ('pendiente', 'armando')
              OR (estado = 'cancelado' AND tomado_en IS NOT NULL AND hecho_en > now() - ${CANCELADO_A_LA_VISTA}::interval))
       ORDER BY creado_en`);
    return { aplica: true, pedidos: await this.armar(cab) };
  }

  /** Los del cajero: los abiertos y los cerrados que todavía no vio (del último día). */
  async mios(usuarioId: number) {
    const cab = await this.filas(sql`
      SELECT * FROM fraccion_pedidos
       WHERE origen = 'caja' AND usuario_id = ${usuarioId} AND creado_en > now() - interval '1 day'
         AND (estado IN ('pendiente', 'armando') OR visto_en IS NULL)
       ORDER BY creado_en`);
    return this.armar(cab);
  }

  /** Con candado: el pedido de la caja en el estado esperado. */
  private async deCaja(tx: any, id: number, estados: string[]) {
    const [c] = await tx.select().from(fraccionPedidos).where(eq(fraccionPedidos.id, id)).limit(1).for('update');
    const codigo = codigoPedidoFraccion(id);
    if (!c || c.origen !== 'caja') throw new NotFoundException('Ese pedido de la caja no existe: actualizá la pantalla.');
    if (!estados.includes(c.estado)) {
      if (c.estado === 'armando') {
        const [op] = c.operadorId
          ? await tx.select({ nombre: fraccionOperadores.nombre }).from(fraccionOperadores).where(eq(fraccionOperadores.id, c.operadorId))
          : [];
        throw new BadRequestException(`${codigo} ya lo está armando ${op?.nombre ?? 'otro'}.`);
      }
      throw new BadRequestException(c.estado === 'pendiente' ? `${codigo} todavía no lo tomó nadie.`
        : c.estado === 'cancelado' ? `${codigo} lo canceló la caja.` : `${codigo} ya está cerrado.`);
    }
    return c;
  }

  /** «Lo armo»: queda tomado, con el operador que lo arma (el mismo que pide el registro). */
  async tomar(id: number, operadorId: number | undefined, usuarioId: number | null) {
    await this.db.transaction(async (tx) => {
      const c = await this.deCaja(tx, id, ['pendiente']);
      const op = await this.inv.operadorDeFraccion(tx, operadorId, c.sucursalId, true);
      await tx.update(fraccionPedidos).set({
        estado: 'armando', tomadoEn: new Date(), tomadoPor: usuarioId, operadorId: op, actualizadoEn: new Date(),
      }).where(eq(fraccionPedidos.id, id));
    });
    return { ok: true };
  }

  /**
   * «Listo»: registra el fraccionado de lo pedido con su operador. El registro
   * toma el candado del pedido, lee sus renglones vivos (lo cancelado no se
   * arma) y lo cierra en la misma transacción que mueve el stock: si no
   * alcanza el granel no se mueve nada y el pedido sigue armándose.
   */
  async listo(id: number, usuarioId: number | null) {
    const [c] = await this.db.select().from(fraccionPedidos).where(eq(fraccionPedidos.id, id)).limit(1);
    if (!c || c.origen !== 'caja') throw new NotFoundException('Ese pedido de la caja no existe: actualizá la pantalla.');
    return this.inv.opFraccionarRegistro({
      sucursalId: c.sucursalId, usuarioId: usuarioId ?? undefined, operadorId: c.operadorId ?? undefined, pedidoId: id,
      motivo: `Pedido de la caja ${codigoPedidoFraccion(id)}`,
    });
  }

  /** «No se puede»: con el motivo, que el cajero lee. */
  async rechazar(id: number, motivo: string, usuarioId: number | null) {
    const m = motivo.trim();
    if (!m) throw new BadRequestException('Decí por qué no se puede.');
    await this.db.transaction(async (tx) => {
      await this.deCaja(tx, id, ['pendiente', 'armando']);
      await tx.update(fraccionPedidos).set({
        estado: 'rechazado', motivo: m, hechoEn: new Date(), hechoPor: usuarioId, actualizadoEn: new Date(),
      }).where(eq(fraccionPedidos.id, id));
    });
    return { ok: true };
  }

  /**
   * CANCELAR (0171): el cajero que lo pidió saca un renglón (`itemId`) o el
   * pedido entero, mientras no esté cerrado. Nada se borra: el renglón queda
   * con `cancelado_en`; sin renglones vivos, el pedido pasa a `cancelado` y ya
   * queda visto para el cajero (lo hizo él). Si lo estaban armando, el aviso
   * de fraccionado lo muestra unos minutos para que no lo terminen.
   */
  async cancelar(id: number, itemId: number | undefined, usuarioId: number) {
    return this.db.transaction(async (tx) => {
      const c = await this.deCaja(tx, id, ['pendiente', 'armando']);
      if (c.usuarioId !== usuarioId) throw new ForbiddenException('Lo cancela el cajero que lo pidió.');
      const ahora = new Date();
      const vivos = and(eq(fraccionPedidoItems.pedidoId, id), isNull(fraccionPedidoItems.canceladoEn));
      if (itemId) {
        const [it] = await tx.update(fraccionPedidoItems).set({ canceladoEn: ahora })
          .where(and(vivos, eq(fraccionPedidoItems.id, itemId))).returning({ id: fraccionPedidoItems.id });
        if (!it) throw new BadRequestException('Ese renglón ya no está en el pedido: actualizá la pantalla.');
        const [queda] = await tx.select({ id: fraccionPedidoItems.id }).from(fraccionPedidoItems).where(vivos).limit(1);
        if (queda) {
          await tx.update(fraccionPedidos).set({ actualizadoEn: ahora }).where(eq(fraccionPedidos.id, id));
          return { ok: true, pedidoCancelado: false };
        }
      } else {
        await tx.update(fraccionPedidoItems).set({ canceladoEn: ahora }).where(vivos);
      }
      await tx.update(fraccionPedidos).set({
        estado: 'cancelado', motivo: 'Cancelado por la caja', hechoEn: ahora, hechoPor: usuarioId, vistoEn: ahora, actualizadoEn: ahora,
      }).where(eq(fraccionPedidos.id, id));
      return { ok: true, pedidoCancelado: true };
    });
  }

  /** El cajero ya vio cómo terminó: se le deja de mostrar. Solo los suyos. */
  async visto(id: number, usuarioId: number) {
    await this.db.update(fraccionPedidos).set({ vistoEn: new Date() }).where(and(
      eq(fraccionPedidos.id, id), eq(fraccionPedidos.origen, 'caja'), eq(fraccionPedidos.usuarioId, usuarioId),
      inArray(fraccionPedidos.estado, ['hecho', 'rechazado']),
    ));
    return { ok: true };
  }

  /** El registro de los pedidos de la caja entre dos días (hora argentina), del más nuevo al más viejo. */
  async historialCaja(desde?: string, hasta?: string) {
    if ((desde && !FECHA.test(desde)) || (hasta && !FECHA.test(hasta))) throw new BadRequestException('Fecha inválida.');
    const dist = await this.distribuidora();
    const dia = sql`(creado_en AT TIME ZONE 'America/Argentina/Buenos_Aires')::date`;
    const cab = await this.filas(sql`
      SELECT * FROM fraccion_pedidos
       WHERE sucursal_id = ${dist.id} AND origen = 'caja'
         ${desde ? sql`AND ${dia} >= ${desde}::date` : sql``}
         ${hasta ? sql`AND ${dia} <= ${hasta}::date` : sql``}
       ORDER BY creado_en DESC LIMIT ${HISTORIAL_MAX}`);
    return { pedidos: await this.armar(cab), tope: cab.length === HISTORIAL_MAX };
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

/** La caja pide (cualquier cajero); fraccionado atiende (quien fracciona). */
@Controller('pedidos-fraccion/caja')
export class PedidosCajaController {
  constructor(private readonly svc: PedidosFraccionService) {}

  @Post() @Permiso('ventas.pos')
  pedir(@Body() dto: PedidoFraccionDto, @Auth() sesion: Sesion) { return this.svc.pedirDesdeCaja(dto, sesion); }

  @Get('mios') @Permiso('ventas.pos')
  mios(@Auth() sesion: Sesion) { return this.svc.mios(sesion.usuarioId); }

  @Post(':id/visto') @Permiso('ventas.pos')
  visto(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) { return this.svc.visto(id, sesion.usuarioId); }

  @Post(':id/cancelar') @Permiso('ventas.pos')
  cancelar(@Param('id', ParseIntPipe) id: number, @Body() dto: CancelarDto, @Auth() sesion: Sesion) {
    return this.svc.cancelar(id, dto.itemId, sesion.usuarioId);
  }

  @Get('abiertos') @Permiso('fraccionar')
  abiertos(@Auth() sesion: Sesion) { return this.svc.abiertos(sesion); }

  @Post(':id/tomar') @Permiso('fraccionar')
  tomar(@Param('id', ParseIntPipe) id: number, @Body() dto: TomarDto, @Auth() sesion: Sesion) {
    return this.svc.tomar(id, dto.operadorId, sesion?.usuarioId ?? null);
  }

  @Post(':id/listo') @Permiso('fraccionar')
  listo(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) { return this.svc.listo(id, sesion?.usuarioId ?? null); }

  @Post(':id/rechazar') @Permiso('fraccionar')
  rechazar(@Param('id', ParseIntPipe) id: number, @Body() dto: RechazarDto, @Auth() sesion: Sesion) {
    return this.svc.rechazar(id, dto.motivo, sesion?.usuarioId ?? null);
  }

  @Get('historial') @Permiso('almacen.fraccionamiento')
  historial(@Query('desde') desde?: string, @Query('hasta') hasta?: string) { return this.svc.historialCaja(desde, hasta); }
}
