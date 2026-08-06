/**
 * PRESUPUESTOS — la bandeja de entrada de los pedidos mayoristas
 * ============================================================================
 * Hoy llegan por WhatsApp; mañana entrarán solos desde la tienda web. El
 * presupuesto NO es fiscal ni toca la caja: es la palabra dada al cliente,
 * con ciclo de vida:
 *
 *   borrador ── enviar ──► enviado ── confirmar ──► confirmado ── (POS) ──► cerrado
 *   (se cotiza             (precios congelados      (¡RESERVA de stock!      (venta real,
 *    en el POS)             + vencimiento)           el vendedor arma)        ref. ventaId)
 *
 * "Vencido" se calcula al mirarlo (enviado + fecha pasada): sin relojería.
 * Un confirmado nunca vence solo — tiene mercadería apartada — se cierra o se
 * cancela a mano (y cancelar libera la reserva).
 *
 * El CIERRE vive en VentasService.create (dto.presupuestoId): reclama el
 * estado y libera la reserva DENTRO de la transacción de la venta.
 */
import {
  BadRequestException, Body, Controller, Get, Inject, Injectable,
  Module, NotFoundException, Param, ParseIntPipe, Patch, Post,
} from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { clientes, presupuestoItems, presupuestos, stock } from '../db/schema';
import { InventarioModule } from '../inventario/inventario.module';
import { InventarioService } from '../inventario/inventario.service';
import { ConfiguracionModule, ConfiguracionService } from '../configuracion/configuracion.module';
import { ClientesModule, ClientesService } from '../clientes/clientes.module';

const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export const ENTREGAS = new Set(['retiro', 'cadete', 'camioneta']);

@Injectable()
export class PresupuestosService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly inv: InventarioService,
    private readonly cfg: ConfiguracionService,
    private readonly clientesSvc: ClientesService,
  ) {}

  /** Normaliza renglones y calcula los totales que se CONGELAN en el documento. */
  private totales(items: any[]) {
    let neto = 0;
    let iva = 0;
    const limpios = (items ?? []).map((it: any) => {
      const cantidad = Number(it.cantidad) || 0;
      const precio = Number(it.precioLista) || 0;
      const desc = Number(it.descuento) || 0;
      const alic = Number.isFinite(Number(it.iva)) ? Number(it.iva) : 21;
      const netoItem = cantidad * precio * (1 - desc / 100);
      neto += netoItem;
      iva += netoItem * (alic / 100);
      return {
        productoId: Number(it.productoId), presentacionId: it.presentacionId || null,
        nombre: String(it.nombre ?? '').trim(), detalle: String(it.detalle ?? '').trim(),
        cantidad, cantidadArmada: null as number | null,
        precioLista: money(precio), descuento: desc, iva: alic,
        lista: String(it.lista ?? ''), ofertaNombre: String(it.ofertaNombre ?? ''), motivo: '',
      };
    }).filter((it: any) => it.productoId && it.cantidad > 0);
    return { limpios, subtotalNeto: money(neto), ivaTotal: money(iva), total: money(neto + iva) };
  }

  private async getRow(id: number) {
    const [p] = await this.db.select().from(presupuestos).where(eq(presupuestos.id, id)).limit(1);
    if (!p) throw new NotFoundException('Presupuesto inexistente.');
    return p;
  }

  async list() {
    const [ps, its] = await Promise.all([
      this.db.select().from(presupuestos).orderBy(desc(presupuestos.id)),
      this.db.select().from(presupuestoItems),
    ]);
    return ps.map((p) => ({ ...p, items: its.filter((i) => i.presupuestoId === p.id) }));
  }

  async crear(dto: any) {
    if (!dto?.clienteId || !dto?.sucursalId) throw new BadRequestException('Cliente y sucursal son obligatorios.');
    const { limpios, subtotalNeto, ivaTotal, total } = this.totales(dto.items);
    if (!limpios.length) throw new BadRequestException('Agregá al menos un renglón.');
    const entrega = ENTREGAS.has(dto.entrega) ? dto.entrega : 'retiro';
    return this.db.transaction(async (tx) => {
      const [p] = await tx.insert(presupuestos).values({
        clienteId: Number(dto.clienteId), sucursalId: Number(dto.sucursalId),
        usuarioId: dto.usuarioId ?? null, vendedorId: dto.vendedorId ?? dto.usuarioId ?? null,
        entrega, observaciones: String(dto.observaciones ?? '').trim(),
        subtotalNeto, ivaTotal, total,
      }).returning();
      const codigo = 'PR' + String(p.id).padStart(4, '0');
      await tx.update(presupuestos).set({ codigo }).where(eq(presupuestos.id, p.id));
      await tx.insert(presupuestoItems).values(limpios.map((it) => ({ ...it, presupuestoId: p.id })));
      return { ok: true, id: p.id, codigo };
    });
  }

  /**
   * Alta desde EL SITIO WEB: nace en `pendiente` — la bandeja de Órdenes.
   * `enviado` es la palabra de la casa, y un pedido que nadie miró todavía no
   * puede serla: alguien lo ACEPTA (pasa a enviado, con vencimiento y cliente
   * resuelto) o lo RECHAZA. Puede llegar SIN cliente (DNI desconocido): los
   * datos del formulario esperan en `webCliente` y el alta se decide al
   * aceptar. Los precios llegan YA recalculados por quien llama.
   */
  async crearDesdeWeb(dto: {
    clienteId: number | null; sucursalId: number; entrega?: string; observaciones?: string;
    items: any[]; webCliente?: { nombre: string; apellido: string; telefono: string; dni: string };
  }) {
    if (!dto?.sucursalId) throw new BadRequestException('Falta la sucursal.');
    if (!dto.clienteId && !dto.webCliente) throw new BadRequestException('Faltan los datos del cliente.');
    const { limpios, subtotalNeto, ivaTotal, total } = this.totales(dto.items);
    if (!limpios.length) throw new BadRequestException('El carrito está vacío.');
    const entrega = ENTREGAS.has(dto.entrega as string) ? dto.entrega : 'retiro';
    return this.db.transaction(async (tx) => {
      const [p] = await tx.insert(presupuestos).values({
        clienteId: dto.clienteId ? Number(dto.clienteId) : null,
        sucursalId: Number(dto.sucursalId),
        usuarioId: null, vendedorId: null,
        estado: 'pendiente', origen: 'web', vencimiento: null,
        webCliente: dto.webCliente ?? null,
        entrega, observaciones: (dto.observaciones ?? '').trim(),
        subtotalNeto, ivaTotal, total,
      }).returning();
      const codigo = 'PR' + String(p.id).padStart(4, '0');
      await tx.update(presupuestos).set({ codigo }).where(eq(presupuestos.id, p.id));
      await tx.insert(presupuestoItems).values(limpios.map((it) => ({ ...it, presupuestoId: p.id })));
      return { ok: true, id: p.id, codigo, total };
    });
  }

  /** Solo un BORRADOR se edita entero: enviado es palabra dada — se reabre para re-cotizar. */
  async actualizar(id: number, dto: any) {
    const p = await this.getRow(id);
    if (p.estado !== 'borrador') throw new BadRequestException('Solo un borrador se edita — usá "Reabrir" para re-cotizar.');
    const { limpios, subtotalNeto, ivaTotal, total } = this.totales(dto.items);
    if (!limpios.length) throw new BadRequestException('Agregá al menos un renglón.');
    await this.db.transaction(async (tx) => {
      await tx.update(presupuestos).set({
        clienteId: dto.clienteId != null ? Number(dto.clienteId) : p.clienteId,
        vendedorId: dto.vendedorId !== undefined ? dto.vendedorId : p.vendedorId,
        entrega: ENTREGAS.has(dto.entrega) ? dto.entrega : p.entrega,
        observaciones: dto.observaciones != null ? String(dto.observaciones).trim() : p.observaciones,
        subtotalNeto, ivaTotal, total,
      }).where(eq(presupuestos.id, id));
      await tx.delete(presupuestoItems).where(eq(presupuestoItems.presupuestoId, id));
      await tx.insert(presupuestoItems).values(limpios.map((it) => ({ ...it, presupuestoId: id })));
    });
    return { ok: true };
  }

  /** borrador → enviado: congela la palabra y arranca el reloj de validez. */
  async enviar(id: number) {
    await this.getRow(id);
    const cfgV = await this.cfg.get('ventas');
    const dias = Number(cfgV.presupuestoValidezDias) || 7;
    const gano = await this.db.update(presupuestos)
      .set({ estado: 'enviado', vencimiento: new Date(Date.now() + dias * 86400000) })
      .where(and(eq(presupuestos.id, id), eq(presupuestos.estado, 'borrador')))
      .returning({ id: presupuestos.id });
    if (!gano.length) throw new BadRequestException('Solo un borrador se envía — actualizá la pantalla.');
    return { ok: true, dias };
  }

  /** enviado (vigente o vencido) → borrador: para re-cotizar a precios de hoy. */
  async reabrir(id: number) {
    await this.getRow(id);
    const gano = await this.db.update(presupuestos)
      .set({ estado: 'borrador', vencimiento: null })
      .where(and(eq(presupuestos.id, id), eq(presupuestos.estado, 'enviado')))
      .returning({ id: presupuestos.id });
    if (!gano.length) throw new BadRequestException('Solo un enviado se reabre — actualizá la pantalla.');
    return { ok: true };
  }

  /**
   * enviado VIGENTE → confirmado: el cliente dijo que sí. Acá se RESERVA el
   * stock (disponible → comprometido) para que la caja no venda la mercadería
   * que el vendedor está apartando. Vencido no se confirma: se re-cotiza.
   */
  async confirmar(id: number, usuarioId?: number) {
    return this.db.transaction(async (tx) => {
      const [p] = await tx.select().from(presupuestos).where(eq(presupuestos.id, id)).limit(1);
      if (!p) throw new NotFoundException('Presupuesto inexistente.');
      if (p.estado !== 'enviado') throw new BadRequestException('Solo se confirma un presupuesto enviado.');
      if (p.vencimiento && p.vencimiento.getTime() < Date.now()) {
        throw new BadRequestException('El presupuesto venció: reabrilo y re-cotizalo — los precios pueden haber cambiado.');
      }
      const cfgV = await this.cfg.get('ventas');
      const reservar = !!cfgV.presupuestoReservaStock;
      const gano = await tx.update(presupuestos)
        .set({ estado: 'confirmado', reservado: reservar })
        .where(and(eq(presupuestos.id, id), eq(presupuestos.estado, 'enviado')))
        .returning({ id: presupuestos.id });
      if (!gano.length) throw new BadRequestException('El presupuesto cambió de estado — actualizá la pantalla.');
      if (reservar) {
        const items = await tx.select().from(presupuestoItems).where(eq(presupuestoItems.presupuestoId, id));
        await this.inv.reservarItems(tx, {
          sucursalId: p.sucursalId, usuarioId: usuarioId ?? null,
          descripcion: `${p.codigo}: reserva por presupuesto confirmado`,
          items,
        });
      }
      return { ok: true, reservado: reservar };
    });
  }

  /** El vendedor carga lo que ARMÓ de verdad (pedida / armada / motivo). */
  async armar(id: number, o: { items?: { itemId: number; cantidadArmada?: number; motivo?: string }[] }) {
    const p = await this.getRow(id);
    if (p.estado !== 'confirmado') throw new BadRequestException('El armado se carga con el presupuesto confirmado.');
    for (const it of o.items ?? []) {
      const patch: any = {};
      if (it.cantidadArmada != null) {
        const c = Number(it.cantidadArmada);
        if (!Number.isFinite(c) || c < 0) throw new BadRequestException('Cantidad armada inválida.');
        patch.cantidadArmada = c;
      }
      if (it.motivo != null) patch.motivo = String(it.motivo).trim();
      if (Object.keys(patch).length) {
        await this.db.update(presupuestoItems)
          .set(patch)
          .where(and(eq(presupuestoItems.id, Number(it.itemId)), eq(presupuestoItems.presupuestoId, id)));
      }
    }
    return { ok: true };
  }

  /** Delegar el armado/cierre a un vendedor (su bandeja). */
  async delegar(id: number, vendedorId: number | null) {
    const p = await this.getRow(id);
    if (p.estado === 'cerrado' || p.estado === 'cancelado') {
      throw new BadRequestException('Ese presupuesto ya está terminado.');
    }
    await this.db.update(presupuestos).set({ vendedorId: vendedorId ?? null }).where(eq(presupuestos.id, id));
    return { ok: true };
  }

  /* ---------------- Órdenes web (bandeja de pedidos del sitio) ---------------- */

  /** Cuántos pedidos web esperan revisión. Barato a propósito: se pollea. */
  async ordenesPendientes() {
    const [r] = await this.db.select({ n: sql<number>`count(*)::int` }).from(presupuestos)
      .where(and(eq(presupuestos.estado, 'pendiente'), eq(presupuestos.origen, 'web')));
    return { pendientes: Number(r?.n) || 0 };
  }

  /**
   * La orden con sus renglones Y el stock disponible de cada uno en la
   * sucursal del pedido: el faltante se ve ANTES de aceptar, no al confirmar.
   */
  async orden(id: number) {
    const p = await this.getRow(id);
    const [items, st] = await Promise.all([
      this.db.select().from(presupuestoItems).where(eq(presupuestoItems.presupuestoId, id)),
      this.db.select().from(stock)
        .where(and(eq(stock.sucursalId, p.sucursalId), eq(stock.estado, 'disponible'))),
    ]);
    const disponibleDe = (it: any) => st
      .filter((s) => s.productoId === it.productoId && (s.presentacionId ?? null) === (it.presentacionId ?? null))
      .reduce((a, s) => a + s.cantidad, 0);
    return {
      ...p,
      items: items.map((it) => {
        const disponible = money(disponibleDe(it));
        return { ...it, disponible, alcanza: disponible + 1e-9 >= it.cantidad };
      }),
    };
  }

  /**
   * pendiente → enviado: alguien de la casa ACEPTÓ el pedido web.
   * El cliente se resuelve acá — en orden de prioridad:
   *   1. `clienteId` del body: el admin lo adjudicó a mano a un cliente existente.
   *   2. El que ya traía la orden (el DNI matcheó al entrar).
   *   3. El DNI matchea AHORA (se dio de alta mientras la orden esperaba).
   *   4. `crearCliente: true`: alta desde los datos del formulario (la pregunta
   *      "¿agregarlo como cliente nuevo?" que respondió el admin en el CRM).
   * Sin ninguna de las cuatro, la aceptación se rechaza con el porqué.
   */
  async aceptar(id: number, o: { usuarioId?: number; clienteId?: number; crearCliente?: boolean }) {
    const p = await this.getRow(id);
    if (p.estado !== 'pendiente') throw new BadRequestException('Solo una orden pendiente se acepta — actualizá la pantalla.');
    const wc: any = p.webCliente ?? {};

    let clienteId = p.clienteId;
    if (o?.clienteId) {
      const [c] = await this.db.select().from(clientes).where(eq(clientes.id, Number(o.clienteId))).limit(1);
      if (!c) throw new BadRequestException('Ese cliente no existe.');
      clienteId = c.id;
    } else if (!clienteId) {
      const dni = String(wc.dni ?? '').replace(/\D/g, '');
      const [ya] = dni
        ? await this.db.select().from(clientes)
          .where(and(eq(clientes.tipoDoc, 'dni'), eq(clientes.numeroDoc, dni))).limit(1)
        : [];
      if (ya) {
        clienteId = ya.id;
      } else if (o?.crearCliente) {
        const c = await this.clientesSvc.create({
          nombre: `${wc.nombre ?? ''} ${wc.apellido ?? ''}`.trim(),
          tipoDoc: 'dni', numeroDoc: dni, telefono: String(wc.telefono ?? ''),
          condicionIva: 'consumidor_final',
        } as any);
        clienteId = c.id;
      } else {
        throw new BadRequestException('La orden no tiene cliente: agregalo como nuevo o asignale uno existente.');
      }
    }

    const cfgV = await this.cfg.get('ventas');
    const dias = Number(cfgV.presupuestoValidezDias) || 7;
    const gano = await this.db.update(presupuestos)
      .set({
        estado: 'enviado', clienteId, usuarioId: o?.usuarioId ?? null,
        vencimiento: new Date(Date.now() + dias * 86400000),
      })
      .where(and(eq(presupuestos.id, id), eq(presupuestos.estado, 'pendiente')))
      .returning({ id: presupuestos.id });
    if (!gano.length) throw new BadRequestException('La orden cambió de estado — actualizá la pantalla.');
    return { ok: true, clienteId };
  }

  /** Cancela en cualquier estado abierto; si había reserva, la libera. */
  async cancelar(id: number, usuarioId?: number, motivo?: string) {
    return this.db.transaction(async (tx) => {
      const [p] = await tx.select().from(presupuestos).where(eq(presupuestos.id, id)).limit(1);
      if (!p) throw new NotFoundException('Presupuesto inexistente.');
      if (p.estado === 'cerrado' || p.estado === 'cancelado') {
        throw new BadRequestException('Ese presupuesto ya está terminado.');
      }
      const nota = String(motivo ?? '').trim();
      const gano = await tx.update(presupuestos)
        .set({
          estado: 'cancelado',
          ...(nota ? { observaciones: [p.observaciones, `Rechazado: ${nota}`].filter(Boolean).join(' · ') } : {}),
        })
        .where(and(eq(presupuestos.id, id), eq(presupuestos.estado, p.estado)))
        .returning({ id: presupuestos.id });
      if (!gano.length) throw new BadRequestException('El presupuesto cambió de estado — actualizá la pantalla.');
      if (p.estado === 'confirmado' && p.reservado) {
        const items = await tx.select().from(presupuestoItems).where(eq(presupuestoItems.presupuestoId, id));
        await this.inv.reservarItems(tx, {
          sucursalId: p.sucursalId, usuarioId: usuarioId ?? null, liberar: true,
          descripcion: `${p.codigo}: cancelado, reserva liberada`,
          items,
        });
      }
      return { ok: true };
    });
  }
}

@Controller('presupuestos')
export class PresupuestosController {
  constructor(private readonly svc: PresupuestosService) {}
  @Get() list() { return this.svc.list(); }
  @Get('ordenes/pendientes') ordenesPendientes() { return this.svc.ordenesPendientes(); }
  @Get(':id/orden') orden(@Param('id', ParseIntPipe) id: number) { return this.svc.orden(id); }
  @Post() crear(@Body() body: any) { return this.svc.crear(body ?? {}); }
  @Post(':id/aceptar') aceptar(@Param('id', ParseIntPipe) id: number, @Body() body: any) { return this.svc.aceptar(id, body ?? {}); }
  @Patch(':id') actualizar(@Param('id', ParseIntPipe) id: number, @Body() body: any) { return this.svc.actualizar(id, body ?? {}); }
  @Post(':id/enviar') enviar(@Param('id', ParseIntPipe) id: number) { return this.svc.enviar(id); }
  @Post(':id/reabrir') reabrir(@Param('id', ParseIntPipe) id: number) { return this.svc.reabrir(id); }
  @Post(':id/confirmar') confirmar(@Param('id', ParseIntPipe) id: number, @Body() body: any) { return this.svc.confirmar(id, body?.usuarioId); }
  @Post(':id/armar') armar(@Param('id', ParseIntPipe) id: number, @Body() body: any) { return this.svc.armar(id, body ?? {}); }
  @Post(':id/delegar') delegar(@Param('id', ParseIntPipe) id: number, @Body() body: any) { return this.svc.delegar(id, body?.vendedorId ?? null); }
  @Post(':id/cancelar') cancelar(@Param('id', ParseIntPipe) id: number, @Body() body: any) { return this.svc.cancelar(id, body?.usuarioId, body?.motivo); }
}

@Module({
  imports: [InventarioModule, ConfiguracionModule, ClientesModule],
  controllers: [PresupuestosController],
  providers: [PresupuestosService],
  exports: [PresupuestosService],
})
export class PresupuestosModule {}
