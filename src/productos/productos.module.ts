import {
  Body, Controller, Delete, Get, Inject, Injectable, Module, BadRequestException,
  NotFoundException, Param, ParseIntPipe, Patch, Post, Put,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString } from 'class-validator';
import { and, eq, gt } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { ConfiguracionModule, ConfiguracionService } from '../configuracion/configuracion.module';
import { productos, presentaciones, productoProveedores, listasPrecio, stock } from '../db/schema';
import { costoNetoEntry, precioLista, precioPresentacion } from '../inventario/pricing';

class CreateProductoDto {
  @IsString() nombre!: string;
  @IsOptional() @IsString() marca?: string;
  @IsOptional() @IsString() categoria?: string;
  @IsOptional() @IsNumber() iva?: number;
  @IsOptional() @IsString() codigoBarras?: string;
  @IsOptional() @IsBoolean() esGranel?: boolean;
}
class UpdateProductoDto {
  @IsString() nombre!: string;
  @IsOptional() @IsString() marca?: string;
  @IsOptional() @IsString() categoria?: string;
  @IsOptional() @IsNumber() iva?: number;
  @IsOptional() @IsString() codigoBarras?: string;
}

@Injectable()
export class ProductosService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly cfg: ConfiguracionService,
  ) {}

  /** Arma un producto con sus datos comerciales anidados + costo/precios computados. */
  private async assemble(prod: any) {
    const [pres, provs, listas, cfg] = await Promise.all([
      this.db.select().from(presentaciones).where(eq(presentaciones.productoId, prod.id)),
      this.db.select().from(productoProveedores).where(eq(productoProveedores.productoId, prod.id)),
      this.db.select().from(listasPrecio).where(eq(listasPrecio.productoId, prod.id)),
      this.cfg.get('ventas'),
    ]);
    const active = provs.find((p) => p.proveedorId === prod.proveedorActivoId) || provs[0] || null;
    const costoNeto = costoNetoEntry(active);
    const opts = { iva: prod.iva, redondeo: cfg.redondeoPrecio };
    return {
      ...prod,
      costoNeto,
      presentaciones: pres.map((pr) => ({ ...pr, precio: precioPresentacion(costoNeto, pr, listas[0]?.ganancia ?? 0, opts) })),
      proveedores: provs.map((pv) => ({ ...pv, costoNeto: costoNetoEntry(pv) })),
      listasPrecio: listas.map((l) => ({ ...l, precio: precioLista(costoNeto, l.ganancia, opts) })),
    };
  }

  async list() {
    const rows = await this.db.select().from(productos).orderBy(productos.id);
    return Promise.all(rows.map((p) => this.assemble(p)));
  }

  async get(id: number) {
    const [p] = await this.db.select().from(productos).where(eq(productos.id, id)).limit(1);
    if (!p) throw new NotFoundException('Producto inexistente.');
    return this.assemble(p);
  }

  async create(dto: CreateProductoDto) {
    const [p] = await this.db.insert(productos).values({
      nombre: dto.nombre.trim(), marca: (dto.marca ?? '').trim(), categoria: dto.categoria ?? 'General',
      iva: dto.iva ?? 21, tipo: dto.esGranel ? 'granel' : 'entero',
      codigoBarras: (dto.codigoBarras ?? '').trim(),
    }).returning();
    return this.assemble(p);
  }

  async update(id: number, dto: UpdateProductoDto) {
    const [p] = await this.db.select().from(productos).where(eq(productos.id, id)).limit(1);
    if (!p) throw new NotFoundException('Producto inexistente.');
    const [upd] = await this.db.update(productos).set({
      nombre: dto.nombre.trim(), marca: (dto.marca ?? '').trim(), categoria: dto.categoria ?? p.categoria,
      iva: dto.iva ?? p.iva,
      codigoBarras: (dto.codigoBarras ?? p.codigoBarras ?? '').trim(),
    }).where(eq(productos.id, id)).returning();
    return this.assemble(upd);
  }

  async remove(id: number) {
    const conStock = await this.db.select().from(stock).where(and(eq(stock.productoId, id), gt(stock.cantidad, 1e-9))).limit(1);
    if (conStock[0]) throw new BadRequestException('No se puede eliminar: el producto tiene stock.');
    await this.db.delete(productos).where(eq(productos.id, id));
    return { ok: true };
  }

  /** Reemplaza las presentaciones del producto (granel). */
  async setPresentaciones(id: number, items: any[]) {
    const [p] = await this.db.select().from(productos).where(eq(productos.id, id)).limit(1);
    if (!p) throw new NotFoundException('Producto inexistente.');
    if (p.tipo !== 'granel') throw new BadRequestException('Solo los productos a granel tienen presentaciones.');
    await this.db.delete(presentaciones).where(eq(presentaciones.productoId, id));
    const valid = (items || []).filter((x) => Number(x.tamKg) > 0);
    if (valid.length) {
      await this.db.insert(presentaciones).values(valid.map((x) => ({ productoId: id, tamKg: Number(x.tamKg), recargo: Number(x.recargo) || 0, codigoBarras: (x.codigoBarras ?? '').trim() })));
    }
    return this.get(id);
  }

  /** Reemplaza los costos por proveedor y fija el proveedor activo. */
  async setProveedores(id: number, dto: { proveedores: any[]; proveedorActivoId?: number | null }) {
    const [p] = await this.db.select().from(productos).where(eq(productos.id, id)).limit(1);
    if (!p) throw new NotFoundException('Producto inexistente.');
    await this.db.delete(productoProveedores).where(eq(productoProveedores.productoId, id));
    const valid = (dto.proveedores || []).filter((e) => Number(e.proveedorId));
    if (valid.length) {
      await this.db.insert(productoProveedores).values(valid.map((e) => ({
        productoId: id, proveedorId: Number(e.proveedorId), costo: Number(e.costo) || 0,
        descuento: Number(e.descuento) || 0, flete: Number(e.flete) || 0,
      })));
    }
    const act = Number(dto.proveedorActivoId);
    const activoId = valid.find((e) => Number(e.proveedorId) === act) ? act : (valid[0] ? Number(valid[0].proveedorId) : null);
    await this.db.update(productos).set({ proveedorActivoId: activoId }).where(eq(productos.id, id));
    return this.get(id);
  }

  /** Reemplaza las listas de precio (% de ganancia). */
  async setListas(id: number, items: any[]) {
    const [p] = await this.db.select().from(productos).where(eq(productos.id, id)).limit(1);
    if (!p) throw new NotFoundException('Producto inexistente.');
    await this.db.delete(listasPrecio).where(eq(listasPrecio.productoId, id));
    const valid = (items || []).map((l, i) => ({ nombre: (l.nombre || '').trim() || `Lista ${i + 1}`, ganancia: Number(l.ganancia) || 0 }))
      .filter((l) => l.nombre);
    if (valid.length) {
      await this.db.insert(listasPrecio).values(valid.map((l) => ({ productoId: id, nombre: l.nombre, ganancia: l.ganancia })));
    }
    return this.get(id);
  }
}

@Controller('productos')
export class ProductosController {
  constructor(private readonly svc: ProductosService) {}

  @Get() list() { return this.svc.list(); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }
  @Post() create(@Body() dto: CreateProductoDto) { return this.svc.create(dto); }
  @Patch(':id') update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateProductoDto) { return this.svc.update(id, dto); }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }

  @Put(':id/presentaciones')
  setPresentaciones(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.setPresentaciones(id, body?.presentaciones ?? body);
  }

  @Put(':id/proveedores')
  setProveedores(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.setProveedores(id, body);
  }

  @Put(':id/listas')
  setListas(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.setListas(id, body?.listasPrecio ?? body);
  }
}

@Module({
  imports: [ConfiguracionModule],
  controllers: [ProductosController],
  providers: [ProductosService],
  exports: [ProductosService],
})
export class ProductosModule {}
