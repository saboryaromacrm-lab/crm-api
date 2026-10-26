/**
 * CAMBIOS DE MERCADERÍA CON EL PROVEEDOR (0202, 26/10/2026, pedido del dueño)
 * ============================================================================
 * El proveedor reconoce mercadería (vencidos, fallados): se la llevás y te la
 * repone en otra entrega —a veces con otro producto o sabor, a veces en partes,
 * a veces recién en el próximo envío—. Decisiones del dueño:
 *
 *   · SE MIDE POR VALOR A COSTO: lo que mandás suma lo que te debe; lo que
 *     repone (sea lo que sea) lo descuenta por su costo. Las unidades se
 *     muestran, pero lo que cierra la cuenta es la plata a costo.
 *   · EL STOCK SALE AL MANDARLA (movimiento `cambio_proveedor`, no es pérdida):
 *     la mercadería ya no está en el local. Lo repuesto entra con el mismo tipo.
 *   · EL FALTANTE QUEDA PENDIENTE: el cambio se completa solo cuando lo
 *     repuesto alcanza lo mandado; no se da por perdido ni pasa a plata.
 *
 * No toca la cuenta corriente ni los gastos: es mercadería por mercadería. Un
 * envío cargado por error se ANULA mientras no tenga nada repuesto (el stock
 * vuelve). El costo de cada renglón se congela al cargarlo, como en una venta.
 */
import {
  BadRequestException, Body, Controller, Get, Inject, Injectable, Module, NotFoundException, Param, ParseIntPipe, Post, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';
import { and, asc, desc, eq, ilike, inArray, ne, sql } from 'drizzle-orm';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  presentaciones, productoProveedores, productos, proveedorReposicionItems, proveedorReposiciones, proveedores, stock, sucursales,
} from '../db/schema';
import { InventarioModule } from '../inventario/inventario.module';
import { InventarioService } from '../inventario/inventario.service';
import { costosFormato, escalaPaquete, formatoDeCosto } from '../inventario/pricing';

const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
/** Lo repuesto alcanza lo mandado con un centavo de tolerancia. */
const EPS = 0.01;
const MOV = 'cambio_proveedor' as const;

class RenglonDto {
  @IsInt() productoId!: number;
  @IsOptional() @IsInt() presentacionId?: number | null;
  @IsNumber() @Min(0.001) cantidad!: number;
}
class MandarDto {
  @IsInt() proveedorId!: number;
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsString() @MaxLength(300) nota?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => RenglonDto)
  items!: RenglonDto[];
}
class RecibirDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => RenglonDto)
  items!: RenglonDto[];
}

@Injectable()
export class ReposicionesService {
  constructor(@Inject(DRIZZLE) private readonly db: Database, private readonly inv: InventarioService) {}

  /**
   * El costo NETO de hoy de cada renglón, el mismo que se congela en una venta
   * (formato de costo del proveedor que fija el precio): el paquete hereda el
   * del kilo por su tamaño y su merma.
   */
  private async conCosto(tx: Database, items: RenglonDto[]) {
    const ids = [...new Set(items.map((it) => it.productoId))];
    const presIds = [...new Set(items.map((it) => it.presentacionId).filter((x): x is number => !!x))];
    const [prods, provs] = await Promise.all([
      tx.select().from(productos).where(inArray(productos.id, ids)),
      tx.select().from(productoProveedores).where(inArray(productoProveedores.productoId, ids)),
    ]);
    const pres = presIds.length ? await tx.select().from(presentaciones).where(inArray(presentaciones.id, presIds)) : [];
    return items.map((it) => {
      const prod = prods.find((p) => p.id === it.productoId);
      if (!prod) throw new BadRequestException('Uno de los productos ya no existe.');
      const p = it.presentacionId ? pres.find((x) => x.id === it.presentacionId && x.productoId === prod.id) : null;
      if (it.presentacionId && !p) throw new BadRequestException(`El envasado elegido no es de ${prod.nombre}.`);
      const cf = costosFormato(formatoDeCosto(prod as any, provs.filter((x) => x.productoId === prod.id)) as any, prod.iva);
      const costo = cf.costoNetoUnitario * (p ? escalaPaquete(p.tamKg, prod.merma) : 1);
      return { productoId: prod.id, presentacionId: p?.id ?? null, cantidad: Number(it.cantidad), costoUnitario: Math.round(costo * 1e4) / 1e4 };
    });
  }

  /** Lo mandado, lo repuesto y lo que falta de cada cambio (a costo). */
  private saldos() {
    const valor = (sentido: string) => sql<number>`coalesce(sum(${proveedorReposicionItems.cantidad} * ${proveedorReposicionItems.costoUnitario})
      filter (where ${proveedorReposicionItems.sentido} = ${sentido}), 0)::float8`;
    const unidades = (sentido: string) => sql<number>`coalesce(sum(${proveedorReposicionItems.cantidad})
      filter (where ${proveedorReposicionItems.sentido} = ${sentido}), 0)::float8`;
    return { mandado: valor('envio'), repuesto: valor('recepcion'), unidadesMandadas: unidades('envio'), unidadesRepuestas: unidades('recepcion') };
  }

  async listar(q: { estado?: string; proveedorId?: number }) {
    const conds: any[] = [];
    if (q.estado === 'pendientes' || !q.estado) conds.push(eq(proveedorReposiciones.estado, 'pendiente'));
    else if (q.estado === 'completos') conds.push(eq(proveedorReposiciones.estado, 'completo'));
    else conds.push(ne(proveedorReposiciones.estado, 'anulado'));
    if (q.proveedorId) conds.push(eq(proveedorReposiciones.proveedorId, q.proveedorId));
    const filas = await this.db.select({
      id: proveedorReposiciones.id, proveedorId: proveedorReposiciones.proveedorId, proveedorNombre: proveedores.nombre,
      sucursalNombre: sucursales.nombre, estado: proveedorReposiciones.estado, nota: proveedorReposiciones.nota,
      creadoEn: proveedorReposiciones.creadoEn, completadoEn: proveedorReposiciones.completadoEn, ...this.saldos(),
    }).from(proveedorReposiciones)
      .innerJoin(proveedores, eq(proveedores.id, proveedorReposiciones.proveedorId))
      .innerJoin(sucursales, eq(sucursales.id, proveedorReposiciones.sucursalId))
      .leftJoin(proveedorReposicionItems, eq(proveedorReposicionItems.reposicionId, proveedorReposiciones.id))
      .where(and(...conds))
      .groupBy(proveedorReposiciones.id, proveedores.nombre, sucursales.nombre)
      .orderBy(desc(proveedorReposiciones.creadoEn))
      .limit(300);
    return filas.map((f) => ({ ...f, mandado: money(f.mandado), repuesto: money(f.repuesto), debe: money(Math.max(0, f.mandado - f.repuesto)) }));
  }

  /** Lo que cada proveedor te debe en cambios pendientes (para su tarjeta en Pedidos). */
  async pendientesPorProveedor() {
    const filas = await this.listar({ estado: 'pendientes' });
    const por = new Map<number, { proveedorId: number; cambios: number; debe: number }>();
    for (const f of filas) {
      const x = por.get(f.proveedorId) ?? { proveedorId: f.proveedorId, cambios: 0, debe: 0 };
      x.cambios += 1; x.debe = money(x.debe + f.debe);
      por.set(f.proveedorId, x);
    }
    return [...por.values()];
  }

  async detalle(id: number) {
    const [cab] = (await this.listar({ estado: 'todos' })).filter((f) => f.id === id);
    const [anulado] = cab ? [] : await this.db.select({ id: proveedorReposiciones.id }).from(proveedorReposiciones).where(eq(proveedorReposiciones.id, id)).limit(1);
    if (!cab) throw new NotFoundException(anulado ? 'Ese cambio está anulado.' : 'Ese cambio no existe.');
    const items = await this.db.select({
      id: proveedorReposicionItems.id, sentido: proveedorReposicionItems.sentido, fecha: proveedorReposicionItems.fecha,
      productoId: proveedorReposicionItems.productoId, nombre: productos.nombre, presentacionId: proveedorReposicionItems.presentacionId,
      tamKg: presentaciones.tamKg, tipo: productos.tipo, cantidad: proveedorReposicionItems.cantidad, costoUnitario: proveedorReposicionItems.costoUnitario,
    }).from(proveedorReposicionItems)
      .innerJoin(productos, eq(productos.id, proveedorReposicionItems.productoId))
      .leftJoin(presentaciones, eq(presentaciones.id, proveedorReposicionItems.presentacionId))
      .where(eq(proveedorReposicionItems.reposicionId, id))
      .orderBy(asc(proveedorReposicionItems.fecha), asc(proveedorReposicionItems.id));
    return { ...cab, items: items.map((it) => ({ ...it, subtotal: money(it.cantidad * it.costoUnitario) })) };
  }

  /**
   * Los productos para elegir: los del proveedor (o todos, si `todos`) que
   * coinciden con lo buscado, cada envasado por separado, con lo disponible
   * en la sucursal y su costo de hoy. Para mandar solo sirven los que hay.
   */
  async productos(q: { proveedorId?: number; sucursalId?: number; buscar?: string; todos?: boolean }) {
    const conds: any[] = [ne(productos.estado, 'archivado')];
    if (q.buscar?.trim()) conds.push(ilike(productos.nombre, `%${q.buscar.trim()}%`));
    if (!q.todos && q.proveedorId) {
      conds.push(sql`exists (select 1 from ${productoProveedores} pp where pp.producto_id = ${productos.id} and pp.proveedor_id = ${q.proveedorId})`);
    }
    const prods = await this.db.select({ id: productos.id, nombre: productos.nombre, tipo: productos.tipo })
      .from(productos).where(and(...conds)).orderBy(asc(productos.nombre)).limit(80);
    if (!prods.length) return [];
    const ids = prods.map((p) => p.id);
    const pres = await this.db.select().from(presentaciones).where(inArray(presentaciones.productoId, ids)).orderBy(asc(presentaciones.tamKg));
    const st = q.sucursalId
      ? await this.db.select({ productoId: stock.productoId, presentacionId: stock.presentacionId, cantidad: stock.cantidad }).from(stock)
        .where(and(eq(stock.sucursalId, q.sucursalId), eq(stock.estado, 'disponible'), inArray(stock.productoId, ids)))
      : [];
    const disp = (productoId: number, presentacionId: number | null) =>
      st.find((s) => s.productoId === productoId && (s.presentacionId ?? null) === presentacionId)?.cantidad ?? 0;
    const opciones = prods.flatMap((p) => [
      { productoId: p.id, presentacionId: null as number | null, nombre: p.nombre, unidad: p.tipo === 'granel' ? 'kg' : 'u', disponible: disp(p.id, null) },
      ...pres.filter((x) => x.productoId === p.id).map((x) => ({
        productoId: p.id, presentacionId: x.id, nombre: `${p.nombre} · ${x.tamKg >= 1 ? `${x.tamKg} kg` : `${Math.round(x.tamKg * 1000)} g`}`,
        unidad: 'u', disponible: disp(p.id, x.id),
      })),
    ]);
    const costos = await this.conCosto(this.db, opciones.map((o) => ({ productoId: o.productoId, presentacionId: o.presentacionId, cantidad: 1 })));
    return opciones.map((o, i) => ({ ...o, costoUnitario: costos[i].costoUnitario }));
  }

  async mandar(dto: MandarDto, s: Sesion) {
    const sucursalId = dto.sucursalId ?? s.sucursalId;
    const [prov] = await this.db.select({ id: proveedores.id, nombre: proveedores.nombre }).from(proveedores).where(eq(proveedores.id, dto.proveedorId)).limit(1);
    if (!prov) throw new BadRequestException('Elegí el proveedor.');
    const id = await this.db.transaction(async (tx) => {
      const renglones = await this.conCosto(tx as any, dto.items);
      const [cab] = await tx.insert(proveedorReposiciones).values({
        proveedorId: prov.id, sucursalId, nota: (dto.nota ?? '').trim(), usuarioId: s.usuarioId,
      }).returning({ id: proveedorReposiciones.id });
      /* Sale lo DISPONIBLE con la misma regla que la caja: si no alcanza y el
         producto tiene control de stock, el helper corta todo; sin control
         (`stockLibre`) sale igual y la pantalla ya avisó en rojo. */
      await this.inv.egresarStockItems(tx, {
        sucursalId, usuarioId: s.usuarioId, tipoMovimiento: MOV,
        descripcion: `Cambio #${cab.id}: mandado a ${prov.nombre}`, items: renglones,
      });
      await tx.insert(proveedorReposicionItems).values(renglones.map((r) => ({ ...r, reposicionId: cab.id, sentido: 'envio' as const, usuarioId: s.usuarioId })));
      return cab.id;
    });
    return this.detalle(id);
  }

  /**
   * Lo que trajo el proveedor (cualquier producto o sabor, todo o una parte):
   * entra al stock de la sucursal del cambio y descuenta lo que debe por su
   * costo. Cuando lo repuesto alcanza lo mandado, el cambio queda completo.
   */
  async recibir(id: number, dto: RecibirDto, s: Sesion) {
    await this.db.transaction(async (tx) => {
      const [cab] = await tx.select().from(proveedorReposiciones).where(eq(proveedorReposiciones.id, id)).for('update').limit(1);
      if (!cab) throw new NotFoundException('Ese cambio no existe.');
      if (cab.estado !== 'pendiente') throw new BadRequestException(cab.estado === 'completo' ? 'Ese cambio ya está completo.' : 'Ese cambio está anulado.');
      const [prov] = await tx.select({ nombre: proveedores.nombre }).from(proveedores).where(eq(proveedores.id, cab.proveedorId)).limit(1);
      const renglones = await this.conCosto(tx as any, dto.items);
      await this.inv.ingresarStockItems(tx, {
        sucursalId: cab.sucursalId, usuarioId: s.usuarioId, tipoMovimiento: MOV, proveedorNombre: prov?.nombre ?? '',
        descripcion: `Cambio #${id}: repuesto por ${prov?.nombre ?? 'el proveedor'}`, items: renglones,
      });
      await tx.insert(proveedorReposicionItems).values(renglones.map((r) => ({ ...r, reposicionId: id, sentido: 'recepcion' as const, usuarioId: s.usuarioId })));
      const [x] = await tx.select(this.saldos()).from(proveedorReposicionItems).where(eq(proveedorReposicionItems.reposicionId, id));
      if (x.repuesto + EPS >= x.mandado) {
        await tx.update(proveedorReposiciones).set({ estado: 'completo', completadoEn: new Date() }).where(eq(proveedorReposiciones.id, id));
      }
    });
    return this.detalle(id);
  }

  /** Un envío cargado por error: se anula mientras no tenga nada repuesto, y el stock vuelve. */
  async anular(id: number, s: Sesion) {
    await this.db.transaction(async (tx) => {
      const [cab] = await tx.select().from(proveedorReposiciones).where(eq(proveedorReposiciones.id, id)).for('update').limit(1);
      if (!cab || cab.estado === 'anulado') throw new NotFoundException('Ese cambio no existe o ya está anulado.');
      const items = await tx.select().from(proveedorReposicionItems).where(eq(proveedorReposicionItems.reposicionId, id));
      if (items.some((it) => it.sentido === 'recepcion')) {
        throw new BadRequestException('El proveedor ya repuso parte de este cambio: no se anula. Queda pendiente hasta que reponga el resto.');
      }
      await this.inv.ingresarStockItems(tx, {
        sucursalId: cab.sucursalId, usuarioId: s.usuarioId, tipoMovimiento: MOV,
        descripcion: `Cambio #${id} anulado: vuelve al stock`, items,
      });
      await tx.update(proveedorReposiciones).set({ estado: 'anulado' }).where(eq(proveedorReposiciones.id, id));
    });
    return { ok: true };
  }
}

/* El permiso es el de Pedidos: quien maneja las entregas con el proveedor maneja sus cambios. */
@Controller('reposiciones')
@Permiso('proveedores.pedidos')
export class ReposicionesController {
  constructor(private readonly svc: ReposicionesService) {}

  @Get() listar(@Query('estado') estado?: string, @Query('proveedorId') proveedorId?: string) {
    return this.svc.listar({ estado: ['pendientes', 'completos', 'todos'].includes(String(estado)) ? estado : 'pendientes', proveedorId: Number(proveedorId) || undefined });
  }

  @Get('por-proveedor') pendientesPorProveedor() { return this.svc.pendientesPorProveedor(); }

  /* Lo disponible es el de la sucursal con que se entró (de donde sale y adonde entra la mercadería). */
  @Get('productos') productos(
    @Auth() s: Sesion, @Query('proveedorId') proveedorId?: string, @Query('buscar') buscar?: string, @Query('todos') todos?: string,
  ) {
    return this.svc.productos({ proveedorId: Number(proveedorId) || undefined, sucursalId: s.sucursalId, buscar, todos: todos === '1' });
  }

  @Get(':id') detalle(@Param('id', ParseIntPipe) id: number) { return this.svc.detalle(id); }
  @Post() mandar(@Body() dto: MandarDto, @Auth() s: Sesion) { return this.svc.mandar(dto, s); }
  @Post(':id/recibir') recibir(@Param('id', ParseIntPipe) id: number, @Body() dto: RecibirDto, @Auth() s: Sesion) { return this.svc.recibir(id, dto, s); }
  @Post(':id/anular') anular(@Param('id', ParseIntPipe) id: number, @Auth() s: Sesion) { return this.svc.anular(id, s); }
}

@Module({
  imports: [InventarioModule],
  controllers: [ReposicionesController],
  providers: [ReposicionesService],
})
export class ReposicionesModule {}
