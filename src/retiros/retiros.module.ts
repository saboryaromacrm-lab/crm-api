/**
 * RETIROS SIN COSTO (0146, 8/10/2026, pedido del dueño)
 * ============================================================================
 * Los socios se llevan mercadería. En el POS se arma el ticket como siempre,
 * pero con un cliente marcado «Retiros sin costo»: no se cobra nada, baja el
 * stock y queda el COSTO REAL de cada renglón en la ficha del cliente, para
 * saber cuánto se consume a costo.
 *
 * NO TOCA NADA DE LAS VENTAS, a propósito:
 *   · documento propio (`retiros` + `retiro_items`), nunca una fila de
 *     `ventas`: no entra al arqueo, a la facturación de ARCA, al IVA, al
 *     ranking de clientes ni a las métricas de ventas o de rentabilidad;
 *   · el stock sale con su propio tipo de movimiento ('retiro'), que ninguna
 *     suma de ventas ni de pérdidas lee (todas filtran por tipo);
 *   · no pide caja abierta, medios de pago ni factura;
 *   · y del otro lado, la venta rechaza a un cliente de retiros
 *     (`exigirNoEsRetiro` en ventas.module): nunca se cruzan.
 *
 * Mismas reglas de mostrador que una venta (granel solo-para-fraccionar,
 * archivados, Coffit, enteros por unidad) y la misma baja de stock con
 * candado. Sin permitir negativo: un retiro no inventa stock.
 *
 * Lo registra cualquiera que cobra en el POS (decisión del dueño: sin PIN).
 * Queda firmado y a la vista en Gerencia › Auditoría. Anularlo devuelve el
 * stock (jefes). Marcar a un cliente es solo del superadmin.
 */
import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Injectable, Module, NotFoundException,
  Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';
import { eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { esJefe, soloSuSucursal, sucursalDeOperacion } from '../auth/auth.guard';
import {
  auditoria, clientes, presentaciones, productoProveedores, productos, retiroItems, retiros,
} from '../db/schema';
import { InventarioModule } from '../inventario/inventario.module';
import { InventarioService } from '../inventario/inventario.service';
import { costosFormato, escalaPaquete, formatoDeCosto } from '../inventario/pricing';
import { VentasModule, VentasService } from '../ventas/ventas.module';
import { resolverOperador } from '../usuarios/usuarios.module';

/** Marcar a un cliente: llave fuera del catálogo, solo el superadmin. */
const PERMISO_MARCAR = 'clientes.retiros';
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const DIA = /^\d{4}-\d{2}-\d{2}$/;

class RenglonRetiroDto {
  @IsInt() productoId!: number;
  @IsOptional() @IsInt() presentacionId?: number | null;
  @IsNumber() @Min(0.001) cantidad!: number;
}
class CrearRetiroDto {
  @IsInt() clienteId!: number;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => RenglonRetiroDto) items!: RenglonRetiroDto[];
  /** El ticket del POS donde se armó: se descarta al registrar (deja de estar abierto). */
  @IsOptional() @IsInt() borradorId?: number;
  /** El relevo de caja (0088): firma quien está parado en el POS. */
  @IsOptional() @IsInt() operadorId?: number;
  @IsBoolean() confirmado!: boolean;
}
class AnularRetiroDto {
  @IsString() @MaxLength(300) motivo!: string;
}
class MarcaClienteDto {
  @IsBoolean() retiroSinCosto!: boolean;
}

@Injectable()
export class RetirosService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly inv: InventarioService,
    private readonly ventas: VentasService,
  ) {}

  async crear(dto: CrearRetiroDto, sesion: Sesion) {
    if (dto.confirmado !== true) throw new BadRequestException('Confirmá el retiro.');
    const sucursalId = sucursalDeOperacion(sesion);
    if (!sucursalId) throw new BadRequestException('Tu sesión no tiene sucursal: volvé a entrar eligiéndola.');
    const items = dto.items.map((it) => ({ productoId: it.productoId, presentacionId: it.presentacionId ?? null, cantidad: Number(it.cantidad) }));
    await this.ventas.validarRenglonesMostrador(items);
    const autor = await resolverOperador(this.db, dto.operadorId, sesion?.usuarioId);

    const r = await this.db.transaction(async (tx) => {
      const [cli] = await tx.select().from(clientes).where(eq(clientes.id, dto.clienteId)).limit(1);
      if (!cli) throw new NotFoundException('Cliente inexistente.');
      if (!cli.activo) throw new BadRequestException('El cliente está desactivado.');
      if (!cli.retiroSinCosto) throw new BadRequestException(`${cli.nombre} no es de «Retiros sin costo»: a este cliente se le cobra como una venta.`);

      /* EL COSTO REAL DEL DÍA, el mismo que congela una venta (0072): neto +
       * la parte sin factura entera; el paquete, sus kilos más la merma. */
      const ids = [...new Set(items.map((it) => it.productoId))];
      const [prods, provs, press] = await Promise.all([
        tx.select().from(productos).where(inArray(productos.id, ids)),
        tx.select().from(productoProveedores).where(inArray(productoProveedores.productoId, ids)),
        tx.select().from(presentaciones).where(inArray(presentaciones.productoId, ids)),
      ]);
      const prodDe = new Map(prods.map((p) => [p.id, p]));
      const presDe = new Map(press.map((p) => [p.id, p]));
      const renglones = items.map((it) => {
        const p = prodDe.get(it.productoId);
        if (!p) throw new BadRequestException('Uno de los artículos no existe.');
        const pres = it.presentacionId ? presDe.get(it.presentacionId) : null;
        if (it.presentacionId && (!pres || pres.productoId !== p.id)) throw new BadRequestException(`El envasado no es de ${p.nombre}.`);
        const cf = costosFormato(formatoDeCosto(p, provs.filter((x) => x.productoId === p.id) as any[]) as any, p.iva);
        const escala = pres ? escalaPaquete(Number(pres.tamKg), Number(p.merma) || 0) : 1;
        /* El nombre, como lo escribe el ticket de venta. */
        return { ...it, nombre: `${p.nombre}${pres ? ` (${pres.tamKg} kg)` : ''}`, costoUnitario: cf.costoNetoUnitario * escala };
      });
      const costoTotal = r2(renglones.reduce((s, x) => s + x.costoUnitario * x.cantidad, 0));
      const [ret] = await tx.insert(retiros).values({ clienteId: cli.id, sucursalId, usuarioId: autor, costoTotal }).returning();
      await tx.insert(retiroItems).values(renglones.map((x) => ({
        retiroId: ret.id, productoId: x.productoId, presentacionId: x.presentacionId, nombre: x.nombre, cantidad: x.cantidad, costoUnitario: x.costoUnitario,
      })));
      await this.inv.egresarStockItems(tx, {
        sucursalId, usuarioId: autor, tipoMovimiento: 'retiro',
        descripcion: `Retiro sin costo #${ret.id} · ${cli.nombre}`, items,
      });
      return { ok: true, id: ret.id, cliente: cli.nombre, costoTotal, renglones: renglones.length };
    });

    /* El ticket del POS deja de estar abierto, con las mismas reglas que
     * «Descartar» (otra sucursal, un QR de Mercado Pago vivo). Si no se puede,
     * el retiro igual quedó bien hecho, y ese ticket no se puede cobrar: su
     * cliente es de retiros (`exigirNoEsRetiro`). */
    if (dto.borradorId) {
      try { await this.ventas.descartar(dto.borradorId, { soloSuSucursal: esJefe(sesion) ? undefined : sesion.sucursalId }); } catch { /* ver arriba */ }
    }
    return r;
  }

  /** La ficha del cliente: sus retiros con renglones, quién y dónde, y el total a costo del período. */
  async delCliente(clienteId: number, q: { desde?: string; hasta?: string }) {
    const desde = DIA.test(q.desde ?? '') ? sql` AND r.fecha >= (${q.desde}::date::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires')` : sql``;
    const hasta = DIA.test(q.hasta ?? '') ? sql` AND r.fecha < ((${q.hasta}::date + 1)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires')` : sql``;
    const res: any = await this.db.execute(sql`
      SELECT r.id, r.fecha, r.costo_total AS "costoTotal", r.anulado_en AS "anuladoEn", r.anulado_motivo AS "anuladoMotivo",
             s.nombre AS sucursal, u.nombre AS usuario, ua.nombre AS "anuladoPor",
             (SELECT json_agg(json_build_object('nombre', i.nombre, 'cantidad', i.cantidad, 'costoUnitario', i.costo_unitario) ORDER BY i.id)
                FROM retiro_items i WHERE i.retiro_id = r.id) AS items
        FROM retiros r
        LEFT JOIN sucursales s ON s.id = r.sucursal_id
        LEFT JOIN usuarios u ON u.id = r.usuario_id
        LEFT JOIN usuarios ua ON ua.id = r.anulado_por
       WHERE r.cliente_id = ${clienteId} ${desde} ${hasta}
       ORDER BY r.fecha DESC
       LIMIT 500`);
    const filas = (res.rows ?? res) as any[];
    return {
      retiros: filas.map((x) => ({ ...x, costoTotal: r2(x.costoTotal), items: x.items ?? [] })),
      costoTotal: r2(filas.filter((x) => !x.anuladoEn).reduce((s, x) => s + Number(x.costoTotal), 0)),
    };
  }

  /** Anular: la mercadería vuelve al stock con el mismo tipo de movimiento. Solo jefes, con motivo. */
  async anular(id: number, motivo: string, sesion: Sesion) {
    if (!esJefe(sesion)) throw new ForbiddenException('Un retiro lo anula un administrador.');
    const texto = String(motivo ?? '').trim();
    if (texto.length < 3) throw new BadRequestException('Escribí por qué se anula el retiro.');
    return this.db.transaction(async (tx) => {
      const [ret] = await tx.select().from(retiros).where(eq(retiros.id, id)).limit(1).for('update');
      if (!ret) throw new NotFoundException('Retiro inexistente.');
      if (ret.anuladoEn) throw new BadRequestException('Ese retiro ya estaba anulado.');
      const mia = soloSuSucursal(sesion);
      if (mia != null && ret.sucursalId !== mia) throw new ForbiddenException('Ese retiro es de otra sucursal.');
      const its = await tx.select().from(retiroItems).where(eq(retiroItems.retiroId, id));
      await tx.update(retiros).set({ anuladoEn: new Date(), anuladoPor: sesion?.usuarioId ?? null, anuladoMotivo: texto.slice(0, 300) }).where(eq(retiros.id, id));
      if (ret.sucursalId) {
        await this.inv.reingresarStockItems(tx, {
          sucursalId: ret.sucursalId, usuarioId: sesion?.usuarioId ?? null, tipoMovimiento: 'retiro',
          descripcion: `Anulación del retiro sin costo #${id}: ${texto}`,
          items: its.map((x) => ({ productoId: x.productoId, presentacionId: x.presentacionId, cantidad: x.cantidad })),
        });
      }
      return { ok: true };
    });
  }

  /** La marca del cliente (solo el superadmin), firmada en la auditoría. */
  async marcarCliente(id: number, valor: boolean, sesion: Sesion) {
    return this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(clientes).where(eq(clientes.id, id)).limit(1).for('update');
      if (!c) throw new NotFoundException('Cliente inexistente.');
      if (c.esConsumidorFinal && valor) throw new BadRequestException('El Consumidor Final es el cliente del mostrador: no puede ser de retiros.');
      if (c.ctaCteHabilitada && valor) throw new BadRequestException(`${c.nombre} tiene cuenta corriente: los retiros no se cobran nunca. Usá un cliente aparte para los retiros.`);
      if (c.retiroSinCosto === valor) return { ok: true, retiroSinCosto: valor };
      await tx.update(clientes).set({ retiroSinCosto: valor }).where(eq(clientes.id, id));
      await tx.insert(auditoria).values({
        usuarioId: sesion?.usuarioId ?? null, entidad: 'cliente', entidadId: id, ambito: 'Clientes', detalle: c.nombre,
        campo: 'Retiros sin costo', antes: c.retiroSinCosto ? 'Sí' : 'No', despues: valor ? 'Sí' : 'No',
      });
      return { ok: true, retiroSinCosto: valor };
    });
  }

  /**
   * Para Métricas: lo retirado a costo en el período, por persona. Separado de
   * las ventas: no se suma a nada ni se resta de la ganancia.
   */
  async resumen(q: { desde?: string; hasta?: string; sucursalId?: string }) {
    if (!DIA.test(q.desde ?? '') || !DIA.test(q.hasta ?? '')) throw new BadRequestException('Elegí el período.');
    const suc = Number(q.sucursalId) || null;
    const res: any = await this.db.execute(sql`
      SELECT c.id AS "clienteId", c.nombre AS cliente, count(*)::int AS retiros, coalesce(sum(r.costo_total), 0) AS costo
        FROM retiros r JOIN clientes c ON c.id = r.cliente_id
       WHERE r.anulado_en IS NULL
         AND r.fecha >= (${q.desde}::date::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires')
         AND r.fecha < ((${q.hasta}::date + 1)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires')
         ${suc ? sql` AND r.sucursal_id = ${suc}` : sql``}
       GROUP BY c.id, c.nombre
       ORDER BY 4 DESC`);
    const porPersona = ((res.rows ?? res) as any[]).map((x) => ({ ...x, costo: r2(x.costo) }));
    return { costo: r2(porPersona.reduce((s, x) => s + x.costo, 0)), retiros: porPersona.reduce((s, x) => s + x.retiros, 0), porPersona };
  }
}

@Controller('retiros')
export class RetirosController {
  constructor(private readonly svc: RetirosService) {}

  /* El mismo permiso que cobrar en el POS: lo registra quien está en la caja (sin PIN, decisión del dueño). */
  @Post() @Permiso('ventas')
  crear(@Body() dto: CrearRetiroDto, @Auth() sesion: Sesion) { return this.svc.crear(dto, sesion); }

  @Get('resumen') @Permiso('gerencia.metricas')
  resumen(@Query() q: { desde?: string; hasta?: string; sucursalId?: string }) { return this.svc.resumen(q ?? {}); }

  @Get('cliente/:id') @Permiso('ventas.clientes')
  delCliente(@Param('id', ParseIntPipe) id: number, @Query() q: { desde?: string; hasta?: string }) { return this.svc.delCliente(id, q ?? {}); }

  @Post(':id/anular') @Permiso('ventas.clientes')
  anular(@Param('id', ParseIntPipe) id: number, @Body() dto: AnularRetiroDto, @Auth() sesion: Sesion) { return this.svc.anular(id, dto.motivo, sesion); }

  @Patch('cliente/:id/marca') @Permiso(PERMISO_MARCAR)
  marcar(@Param('id', ParseIntPipe) id: number, @Body() dto: MarcaClienteDto, @Auth() sesion: Sesion) {
    return this.svc.marcarCliente(id, dto.retiroSinCosto, sesion);
  }
}

@Module({
  imports: [InventarioModule, VentasModule],
  controllers: [RetirosController],
  providers: [RetirosService],
})
export class RetirosModule {}
