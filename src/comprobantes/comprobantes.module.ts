import {
  Body, Controller, Get, Inject, Injectable, Module, BadRequestException,
  NotFoundException, Param, ParseIntPipe, Post, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, ValidateNested,
} from 'class-validator';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { comprobantes, comprobanteItems, productoProveedores, proveedores } from '../db/schema';
import { InventarioModule } from '../inventario/inventario.module';
import { InventarioService } from '../inventario/inventario.service';
import { PreciosModule, PreciosService } from '../precios/precios.module';

const TIPOS = ['orden_compra', 'remito', 'factura', 'nota_credito', 'nota_debito'] as const;

class ComprobanteItemDto {
  @IsInt() productoId!: number;
  @IsOptional() @IsInt() presentacionId?: number;
  @IsNumber() cantidad!: number;
  @IsOptional() @IsNumber() costoUnitario?: number;
  @IsOptional() @IsNumber() descuento?: number;
  @IsOptional() @IsNumber() iva?: number;
}

/**
 * Costo que el comprobante deja como nuevo costo de catálogo. La factura ES la
 * lista de precios nueva del proveedor; sin esto, el costo cargado se queda
 * viejo en silencio y se vende con el margen equivocado.
 */
class ActualizarCostoDto {
  @IsInt() productoId!: number;
  @IsNumber() costo!: number;
  @IsOptional() @IsNumber() descuento?: number;
  @IsOptional() @IsNumber() flete?: number;
}

class CreateComprobanteDto {
  @IsIn(TIPOS as unknown as string[]) tipo!: (typeof TIPOS)[number];
  @IsOptional() @IsIn(['A', 'B', 'C', 'X']) letra?: 'A' | 'B' | 'C' | 'X';
  @IsOptional() @IsString() puntoVenta?: string;
  @IsOptional() @IsInt() numero?: number;
  @IsInt() proveedorId!: number;
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsIn(['borrador', 'confirmado', 'anulado']) estado?: 'borrador' | 'confirmado' | 'anulado';
  @IsOptional() @IsIn(['contado', 'cuenta_corriente']) condicionPago?: 'contado' | 'cuenta_corriente';
  @IsOptional() @IsBoolean() recepcion?: boolean;
  @IsOptional() @IsInt() refComprobanteId?: number;
  @IsOptional() @IsString() observaciones?: string;
  @IsOptional() @IsInt() usuarioId?: number;
  @IsOptional() @IsString() fecha?: string;
  @IsOptional() @IsString() fechaCarga?: string;
  @IsOptional() @IsString() vencimientoPago?: string;
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => ComprobanteItemDto)
  items!: ComprobanteItemDto[];
  /** Los que el usuario tildó en "diferencias de costo" al cargar el comprobante. */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ActualizarCostoDto)
  actualizarCostos?: ActualizarCostoDto[];
  /**
   * Productos cuyo proveedor activo pasa a ser el de este comprobante. Es una
   * decisión explícita del usuario en la recepción: cambia qué costo manda el
   * precio de venta, así que no puede ser automático.
   */
  @IsOptional() @IsArray() @IsInt({ each: true })
  activarProveedor?: number[];
}

@Injectable()
export class ComprobantesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly inv: InventarioService,
    private readonly precios: PreciosService,
  ) {}

  private async withItems(c: any) {
    const items = await this.db.select().from(comprobanteItems).where(eq(comprobanteItems.comprobanteId, c.id));
    return { ...c, items };
  }

  async list(q: { proveedorId?: number; tipo?: string; estado?: string }) {
    const conds: any[] = [];
    if (q.proveedorId) conds.push(eq(comprobantes.proveedorId, Number(q.proveedorId)));
    if (q.tipo) conds.push(eq(comprobantes.tipo, q.tipo as any));
    if (q.estado) conds.push(eq(comprobantes.estado, q.estado as any));
    const where = conds.length ? and(...conds) : undefined;
    const rows = await this.db.select().from(comprobantes).where(where).orderBy(desc(comprobantes.id));
    return Promise.all(rows.map((c) => this.withItems(c)));
  }

  async get(id: number) {
    const [c] = await this.db.select().from(comprobantes).where(eq(comprobantes.id, id)).limit(1);
    if (!c) throw new NotFoundException('Comprobante inexistente.');
    return this.withItems(c);
  }

  async create(dto: CreateComprobanteDto) {
    const [prov] = await this.db.select().from(proveedores).where(eq(proveedores.id, dto.proveedorId)).limit(1);
    if (!prov) throw new BadRequestException('Proveedor inválido.');
    if (!dto.items?.length) throw new BadRequestException('Agregá al menos un ítem.');

    // Un proveedor monotributista o exento NO discrimina IVA: asumir 21% inflaría
    // el total del comprobante y ensuciaría el libro de IVA compras.
    const discrimina = prov.condicionIva === 'responsable_inscripto';
    const ivaDefault = discrimina ? 21 : 0;

    // Totales
    let subtotalNeto = 0;
    let ivaTotal = 0;
    const items = dto.items.map((it) => {
      const cantidad = Number(it.cantidad) || 0;
      const costo = Number(it.costoUnitario) || 0;
      const desc = Number(it.descuento) || 0;
      const ivaP = it.iva != null ? Number(it.iva) : ivaDefault;
      const neto = cantidad * costo * (1 - desc / 100);
      subtotalNeto += neto;
      ivaTotal += neto * ivaP / 100;
      return { ...it, iva: ivaP, subtotal: neto };
    });
    const total = subtotalNeto + ivaTotal;
    const estado = dto.estado ?? 'confirmado';
    const ingresaStock = estado !== 'anulado' && !!dto.recepcion && (dto.tipo === 'remito' || dto.tipo === 'factura');
    if (ingresaStock && !dto.sucursalId) throw new BadRequestException('Indicá la sucursal de recepción.');

    const id = await this.db.transaction(async (tx) => {
      const [c] = await tx.insert(comprobantes).values({
        tipo: dto.tipo, letra: dto.letra ?? 'A', puntoVenta: dto.puntoVenta ?? '0001', numero: dto.numero ?? null,
        fecha: dto.fecha ? new Date(dto.fecha) : undefined,
        fechaCarga: dto.fechaCarga ? new Date(dto.fechaCarga) : undefined, proveedorId: prov.id, sucursalId: dto.sucursalId ?? null,
        estado, condicionPago: dto.condicionPago ?? 'cuenta_corriente',
        vencimientoPago: dto.vencimientoPago ? new Date(dto.vencimientoPago) : null,
        recepcion: !!dto.recepcion, subtotalNeto, ivaTotal, total,
        refComprobanteId: dto.refComprobanteId ?? null, observaciones: dto.observaciones ?? '', usuarioId: dto.usuarioId ?? null,
      }).returning();

      await tx.insert(comprobanteItems).values(items.map((it) => ({
        comprobanteId: c.id, productoId: it.productoId, presentacionId: it.presentacionId ?? null,
        cantidad: Number(it.cantidad) || 0, costoUnitario: Number(it.costoUnitario) || 0,
        descuento: Number(it.descuento) || 0, iva: it.iva, subtotal: it.subtotal,
      })));

      if (ingresaStock) {
        await this.inv.ingresarStockItems(tx, {
          sucursalId: dto.sucursalId, proveedorId: prov.id, proveedorNombre: prov.nombre, usuarioId: dto.usuarioId,
          descripcion: `Recepción ${dto.tipo} ${c.puntoVenta}-${c.numero ?? c.id}`, items: dto.items,
        });
      }

      /**
       * Los costos que el usuario aceptó actualizar viajan en la MISMA
       * transacción que el comprobante: o queda todo o no queda nada. Se hace
       * después del ingreso de stock porque ese paso puede crear la entrada
       * producto/proveedor que recién entonces existe para actualizar.
       */
      const pedidos = (dto.actualizarCostos ?? []).filter((x) => Number(x.costo) > 0);
      if (pedidos.length) {
        const entradas = await tx.select().from(productoProveedores)
          .where(and(
            eq(productoProveedores.proveedorId, prov.id),
            inArray(productoProveedores.productoId, pedidos.map((x) => x.productoId)),
          ));
        const porProducto = new Map(entradas.map((e: any) => [e.productoId, e.id]));
        const cambios = pedidos
          .map((x) => {
            const id = porProducto.get(x.productoId);
            return id ? { id, costo: x.costo, descuento: x.descuento, flete: x.flete } : null;
          })
          .filter(Boolean) as any[];

        if (cambios.length) {
          await this.precios.actualizarCostos({
            cambios,
            origen: 'recepcion',
            motivo: `${dto.tipo} ${c.puntoVenta}-${c.numero ?? c.id} · ${prov.nombre}`,
            usuarioId: dto.usuarioId,
            comprobanteId: c.id,
          } as any, tx);
        }
      }

      // Y el cambio de proveedor activo, si el usuario lo tildó. Va después de
      // actualizar costos para que el precio nuevo salga con el costo nuevo.
      if (dto.activarProveedor?.length) {
        await this.precios.activarProveedor({
          productoIds: dto.activarProveedor,
          proveedorId: prov.id,
          origen: 'recepcion',
          motivo: `${dto.tipo} ${c.puntoVenta}-${c.numero ?? c.id} · ${prov.nombre}`,
          usuarioId: dto.usuarioId,
          comprobanteId: c.id,
        }, tx);
      }
      return c.id;
    });
    return this.get(id);
  }

  /** Saldo de cuenta corriente del proveedor: facturas + ND (cta. cte.) − NC. */
  async cuenta(proveedorId: number) {
    const cs = await this.db.select().from(comprobantes)
      .where(and(eq(comprobantes.proveedorId, proveedorId), eq(comprobantes.estado, 'confirmado')))
      .orderBy(desc(comprobantes.id));
    let saldo = 0;
    for (const c of cs) {
      if ((c.tipo === 'factura' || c.tipo === 'nota_debito') && c.condicionPago === 'cuenta_corriente') saldo += c.total;
      else if (c.tipo === 'nota_credito') saldo -= c.total;
    }
    return { proveedorId, saldo, comprobantes: cs };
  }
}

@Controller('comprobantes')
export class ComprobantesController {
  constructor(private readonly svc: ComprobantesService) {}

  @Get()
  list(@Query('proveedorId') proveedorId?: string, @Query('tipo') tipo?: string, @Query('estado') estado?: string) {
    return this.svc.list({ proveedorId: proveedorId ? Number(proveedorId) : undefined, tipo, estado });
  }

  @Get('cuenta/:proveedorId')
  cuenta(@Param('proveedorId', ParseIntPipe) proveedorId: number) {
    return this.svc.cuenta(proveedorId);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.svc.get(id);
  }

  @Post()
  create(@Body() dto: CreateComprobanteDto) {
    return this.svc.create(dto);
  }
}

@Module({
  imports: [InventarioModule, PreciosModule],
  controllers: [ComprobantesController],
  providers: [ComprobantesService],
})
export class ComprobantesModule {}
