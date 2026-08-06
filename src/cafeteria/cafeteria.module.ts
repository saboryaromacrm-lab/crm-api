/**
 * CAFETERÍA — el puente con coffit (fase 1: solo CRM).
 * ============================================================================
 * El dueño tiene DOS negocios con el MISMO CUIT: la distribuidora (este
 * sistema) y una cafetería cuyo stock maneja OTRO sistema (coffit). El envío
 * NO es una transferencia entre sucursales — no hay receptor en el CRM — sino
 * un PUNTO DE SALIDA: la mercadería egresa del stock valorizada A COSTO
 * congelado, queda el remito (imprimible/exportable para coffit) y ahí termina
 * la responsabilidad del CRM.
 *
 * Reglas que NO se negocian:
 *  - El CRM nunca muestra existencias de Cafetería (coffit es el dueño).
 *  - El envío va a COSTO: la ganancia aparece donde se genera (cuando el café
 *    vende), no en un traspaso interno.
 *  - El destino de cada renglón (venta | uso) es un DATO PARA COFFIT: le dice
 *    al import si eso es producto de góndola o insumo de receta.
 *  - La vuelta existe desde el día 1: la devolución reingresa a costo.
 */
import {
  Body, Controller, Get, Inject, Injectable, Module, Param, ParseIntPipe, Post, Query,
  BadRequestException, NotFoundException,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, ValidateNested,
} from 'class-validator';
import { and, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  enviosCafeteria, envioCafeteriaItems, gastos, presentaciones, productoProveedores,
  productos, sucursales, usuarios,
} from '../db/schema';
import { InventarioModule } from '../inventario/inventario.module';
import { InventarioService } from '../inventario/inventario.service';
import { costoNetoEntry, formatoActivo } from '../inventario/pricing';

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** Mismo parseo local que Gastos: 'AAAA-MM-DD' pelado se correría un día (UTC−3). */
function fechaLocal(v?: string | null) {
  if (!v) return null;
  const s = String(v).trim();
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s);
}

class EnvioItemDto {
  @IsInt() productoId!: number;
  @IsOptional() @IsInt() presentacionId?: number;
  @IsIn(['venta', 'uso']) destino!: 'venta' | 'uso';
  @IsNumber() cantidad!: number;
}

class CrearEnvioDto {
  @IsOptional() @IsIn(['envio', 'devolucion']) tipo?: 'envio' | 'devolucion';
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsString() fecha?: string;
  @IsOptional() @IsString() observaciones?: string;
  @IsOptional() @IsInt() usuarioId?: number;
  @IsArray() @ValidateNested({ each: true }) @Type(() => EnvioItemDto) items!: EnvioItemDto[];
}

class AnularEnvioDto {
  @IsString() motivo!: string;
  @IsOptional() @IsInt() usuarioId?: number;
}

@Injectable()
export class CafeteriaService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly inv: InventarioService,
  ) {}

  /**
   * Crea un envío (o una devolución) y mueve el stock en la MISMA transacción.
   * El costo se congela acá, del formato ACTIVO de cada producto: el remito
   * tiene que decir lo mismo dentro de seis meses, cambie lo que cambie el
   * proveedor. Presentación fraccionada → costo del paquete ($/kg × tamaño).
   */
  async crear(o: CrearEnvioDto) {
    const tipo = o.tipo === 'devolucion' ? 'devolucion' : 'envio';
    const items = (o.items || []).filter((it) => Number(it.cantidad) > 0);
    if (!items.length) throw new BadRequestException('Agregá al menos un renglón con cantidad.');

    return this.db.transaction(async (tx) => {
      const sucId = o.sucursalId
        || (await tx.select().from(sucursales).where(eq(sucursales.tipo, 'distribuidora')).limit(1))[0]?.id;
      if (!sucId) throw new BadRequestException('No hay sucursal de origen.');

      const ids = [...new Set(items.map((it) => it.productoId))];
      const provs = await tx.select().from(productoProveedores)
        .where(inArray(productoProveedores.productoId, ids));

      // Primero se valúa y arma TODO; el stock se mueve al final con los
      // helpers del inventario (validan disponible y registran movimientos).
      let total = 0;
      const filas: any[] = [];
      for (const it of items) {
        const [prod] = await tx.select().from(productos).where(eq(productos.id, it.productoId)).limit(1);
        if (!prod) throw new BadRequestException('Producto inválido en el detalle.');
        let pres: any = null;
        if (it.presentacionId) {
          [pres] = await tx.select().from(presentaciones).where(eq(presentaciones.id, it.presentacionId)).limit(1);
          if (!pres || pres.productoId !== prod.id) throw new BadRequestException(`Presentación inválida para ${prod.nombre}.`);
        }
        const cnKg = costoNetoEntry(formatoActivo(provs.filter((p: any) => p.productoId === prod.id)) as any, prod.iva);
        const costoU = pres ? cnKg * (pres.tamKg ?? 1) : cnKg;
        const cantidad = Number(it.cantidad);
        total += costoU * cantidad;

        const esKg = prod.tipo === 'granel' && !pres;
        const tam = pres ? (pres.tamKg < 1 ? `${Math.round(pres.tamKg * 1000)} g` : `${pres.tamKg} kg`) : '';
        filas.push({
          productoId: prod.id,
          presentacionId: pres?.id ?? null,
          destino: it.destino === 'uso' ? 'uso' : 'venta',
          cantidad,
          costoUnitario: costoU,
          nombre: pres ? `${prod.nombre} · ${tam}` : prod.nombre,
          unidad: esKg ? 'kg' : 'u.',
          // La clave del mapeo en coffit: el código de la ETIQUETA que viaja
          // (la presentación fraccionada tiene el suyo propio).
          codigoBarras: (pres?.codigoBarras || prod.codigoBarras || ''),
          codigoPropio: prod.codigoPropio || '',
        });
      }

      const [envio] = await tx.insert(enviosCafeteria).values({
        codigo: '', tipo, fecha: fechaLocal(o.fecha) ?? new Date(), sucursalId: sucId,
        usuarioId: o.usuarioId ?? null, estado: 'confirmado', totalCosto: r2(total),
        observaciones: (o.observaciones ?? '').trim(),
      }).returning();
      const codigo = (tipo === 'envio' ? 'CAF' : 'CAFD') + String(envio.id).padStart(4, '0');
      await tx.update(enviosCafeteria).set({ codigo }).where(eq(enviosCafeteria.id, envio.id));
      await tx.insert(envioCafeteriaItems).values(filas.map((f) => ({ ...f, envioId: envio.id })));

      const paraStock = {
        sucursalId: sucId,
        usuarioId: o.usuarioId ?? null,
        items: filas.map((f) => ({ productoId: f.productoId, presentacionId: f.presentacionId, cantidad: f.cantidad })),
      };
      if (tipo === 'envio') {
        await this.inv.egresarStockItems(tx, {
          ...paraStock, tipoMovimiento: 'envio_cafeteria',
          descripcion: `${codigo}: envío a Cafetería (coffit)`,
        });
      } else {
        await this.inv.reingresarStockItems(tx, {
          ...paraStock, descripcion: `${codigo}: devolución desde Cafetería`,
        });
      }
      return { ok: true, id: envio.id, codigo, totalCosto: r2(total) };
    });
  }

  async list(q: { desde?: string; hasta?: string; tipo?: string; limit?: number }) {
    const conds: any[] = [];
    const desde = fechaLocal(q.desde);
    const hasta = fechaLocal(q.hasta);
    if (desde) conds.push(gte(enviosCafeteria.fecha, desde));
    if (hasta) { hasta.setHours(23, 59, 59, 999); conds.push(lte(enviosCafeteria.fecha, hasta)); }
    if (q.tipo === 'envio' || q.tipo === 'devolucion') conds.push(eq(enviosCafeteria.tipo, q.tipo as any));
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 300);

    const rows = await this.db.select({
      id: enviosCafeteria.id, codigo: enviosCafeteria.codigo, tipo: enviosCafeteria.tipo,
      fecha: enviosCafeteria.fecha, sucursalId: enviosCafeteria.sucursalId,
      estado: enviosCafeteria.estado, totalCosto: enviosCafeteria.totalCosto,
      observaciones: enviosCafeteria.observaciones,
      sucursalNombre: sucursales.nombre, usuarioNombre: usuarios.nombre,
    }).from(enviosCafeteria)
      .leftJoin(sucursales, eq(sucursales.id, enviosCafeteria.sucursalId))
      .leftJoin(usuarios, eq(usuarios.id, enviosCafeteria.usuarioId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(enviosCafeteria.id))
      .limit(limit);

    const cuenta = await this.db.select({
      envioId: envioCafeteriaItems.envioId,
      renglones: sql<number>`count(*)`,
    }).from(envioCafeteriaItems)
      .where(inArray(envioCafeteriaItems.envioId, rows.length ? rows.map((r) => r.id) : [-1]))
      .groupBy(envioCafeteriaItems.envioId);
    const porEnvio = new Map(cuenta.map((c) => [c.envioId, Number(c.renglones)]));
    return rows.map((r) => ({ ...r, renglones: porEnvio.get(r.id) ?? 0 }));
  }

  async get(id: number) {
    const [envio] = await this.db.select({
      id: enviosCafeteria.id, codigo: enviosCafeteria.codigo, tipo: enviosCafeteria.tipo,
      fecha: enviosCafeteria.fecha, sucursalId: enviosCafeteria.sucursalId,
      estado: enviosCafeteria.estado, totalCosto: enviosCafeteria.totalCosto,
      observaciones: enviosCafeteria.observaciones, motivoAnulacion: enviosCafeteria.motivoAnulacion,
      sucursalNombre: sucursales.nombre, usuarioNombre: usuarios.nombre,
    }).from(enviosCafeteria)
      .leftJoin(sucursales, eq(sucursales.id, enviosCafeteria.sucursalId))
      .leftJoin(usuarios, eq(usuarios.id, enviosCafeteria.usuarioId))
      .where(eq(enviosCafeteria.id, id)).limit(1);
    if (!envio) throw new NotFoundException('Envío inexistente.');
    const items = await this.db.select().from(envioCafeteriaItems)
      .where(eq(envioCafeteriaItems.envioId, id))
      .orderBy(envioCafeteriaItems.id);
    return { ...envio, items };
  }

  /**
   * Anular revierte el stock con la operación contraria (el envío reingresa;
   * la devolución vuelve a egresar — y si ese stock ya no está, se rechaza:
   * un inventario en negativo no se recupera más).
   */
  async anular(id: number, o: AnularEnvioDto) {
    if (!o.motivo?.trim()) throw new BadRequestException('Escribí por qué se anula.');
    return this.db.transaction(async (tx) => {
      const [envio] = await tx.select().from(enviosCafeteria).where(eq(enviosCafeteria.id, id)).limit(1);
      if (!envio) throw new NotFoundException('Envío inexistente.');
      // Reclamo atómico del estado: dos anulaciones simultáneas duplicarían el reingreso.
      const gano = await tx.update(enviosCafeteria)
        .set({ estado: 'anulado', motivoAnulacion: o.motivo.trim() })
        .where(and(eq(enviosCafeteria.id, id), eq(enviosCafeteria.estado, 'confirmado')))
        .returning({ id: enviosCafeteria.id });
      if (!gano.length) throw new BadRequestException('El envío ya está anulado.');

      const items = await tx.select().from(envioCafeteriaItems).where(eq(envioCafeteriaItems.envioId, id));
      const paraStock = {
        sucursalId: envio.sucursalId,
        usuarioId: o.usuarioId ?? null,
        items: items.map((f) => ({ productoId: f.productoId, presentacionId: f.presentacionId, cantidad: f.cantidad })),
      };
      if (envio.tipo === 'envio') {
        await this.inv.reingresarStockItems(tx, {
          ...paraStock, descripcion: `${envio.codigo}: envío a Cafetería ANULADO — reingreso`,
        });
      } else {
        await this.inv.egresarStockItems(tx, {
          ...paraStock, tipoMovimiento: 'envio_cafeteria',
          descripcion: `${envio.codigo}: devolución de Cafetería ANULADA — vuelve a salir`,
        });
      }
      return { ok: true };
    });
  }

  /**
   * La foto de gestión del período: cuánto le costó la cafetería al negocio.
   * Envíos MENOS devoluciones (a costo) MÁS los gastos imputados a ella. Las
   * ventas las tiene coffit — la rentabilidad es la resta entre los dos.
   */
  async resumen(q: { desde?: string; hasta?: string }) {
    const desde = fechaLocal(q.desde);
    const hasta = fechaLocal(q.hasta);
    if (hasta) hasta.setHours(23, 59, 59, 999);
    const condsEnvio: any[] = [eq(enviosCafeteria.estado, 'confirmado')];
    const condsGasto: any[] = [eq(gastos.negocio, 'cafeteria'), ne(gastos.estado, 'anulado')];
    if (desde) { condsEnvio.push(gte(enviosCafeteria.fecha, desde)); condsGasto.push(gte(gastos.fecha, desde)); }
    if (hasta) { condsEnvio.push(lte(enviosCafeteria.fecha, hasta)); condsGasto.push(lte(gastos.fecha, hasta)); }

    const porTipo = await this.db.select({
      tipo: enviosCafeteria.tipo,
      total: sql<number>`coalesce(sum(${enviosCafeteria.totalCosto}), 0)`,
      cantidad: sql<number>`count(*)`,
    }).from(enviosCafeteria).where(and(...condsEnvio)).groupBy(enviosCafeteria.tipo);
    const [g] = await this.db.select({
      total: sql<number>`coalesce(sum(${gastos.total}), 0)`,
      cantidad: sql<number>`count(*)`,
    }).from(gastos).where(and(...condsGasto));

    const enviado = Number(porTipo.find((x) => x.tipo === 'envio')?.total ?? 0);
    const devuelto = Number(porTipo.find((x) => x.tipo === 'devolucion')?.total ?? 0);
    const gastosCafe = Number(g?.total ?? 0);
    return {
      enviado: r2(enviado),
      devuelto: r2(devuelto),
      mercaderiaNeta: r2(enviado - devuelto),
      gastos: r2(gastosCafe),
      gastosCantidad: Number(g?.cantidad ?? 0),
      costoTotal: r2(enviado - devuelto + gastosCafe),
    };
  }
}

@Controller('cafeteria')
export class CafeteriaController {
  constructor(private readonly svc: CafeteriaService) {}

  @Get('envios') list(
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('tipo') tipo?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.list({ desde, hasta, tipo, limit: limit ? Number(limit) : undefined });
  }

  @Get('resumen') resumen(@Query('desde') desde?: string, @Query('hasta') hasta?: string) {
    return this.svc.resumen({ desde, hasta });
  }

  @Get('envios/:id') get(@Param('id', ParseIntPipe) id: number) {
    return this.svc.get(id);
  }

  @Post('envios') crear(@Body() dto: CrearEnvioDto) {
    return this.svc.crear(dto);
  }

  @Post('envios/:id/anular') anular(@Param('id', ParseIntPipe) id: number, @Body() dto: AnularEnvioDto) {
    return this.svc.anular(id, dto);
  }
}

@Module({
  imports: [InventarioModule],
  controllers: [CafeteriaController],
  providers: [CafeteriaService],
  exports: [CafeteriaService],
})
export class CafeteriaModule {}
