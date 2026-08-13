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
  BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Injectable,
  Module, NotFoundException, Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString,
  Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { Auth, Permiso, Sesion } from '../auth/auth.decoradores';
import { esJefe, sucursalDeOperacion } from '../auth/auth.guard';
import { clientes, presupuestoItems, presupuestos, stock } from '../db/schema';
import { InventarioModule } from '../inventario/inventario.module';
import { InventarioService } from '../inventario/inventario.service';
import { ConfiguracionModule, ConfiguracionService } from '../configuracion/configuracion.module';
import { ClientesModule, ClientesService } from '../clientes/clientes.module';

const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export const ENTREGAS = new Set(['retiro', 'cadete', 'camioneta']);

/**
 * TOPES DE LOS NÚMEROS DEL RENGLÓN.
 *
 * Los siete endpoints recibían `@Body() any`, así que el `ValidationPipe` no
 * miraba nada y `totales()` hacía `Number(it.precioLista) || 0`. `Number('1e999')`
 * es `Infinity`, que es truthy y sobrevive al `|| 0`: las tres columnas de
 * totales son `double precision` y Postgres GUARDA `Infinity`. Después el
 * documento vuelve con los totales en `null` (JSON no tiene Infinity) y queda
 * una fila rota que no se puede editar ni borrar desde la pantalla. La variante
 * silenciosa era peor: `descuento: -900` multiplica por diez el total del papel
 * que se le manda al cliente por WhatsApp.
 */
const MAX_CANTIDAD = 1_000_000;
const MAX_PRECIO = 100_000_000;

class PresupuestoItemDto {
  @IsInt() productoId!: number;
  @IsOptional() @IsInt() presentacionId?: number | null;
  @IsOptional() @IsString() @MaxLength(200) nombre?: string;
  @IsOptional() @IsString() @MaxLength(200) detalle?: string;
  @IsNumber() @Min(0) @Max(MAX_CANTIDAD) cantidad!: number;
  @IsNumber() @Min(0) @Max(MAX_PRECIO) precioLista!: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) descuento?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) iva?: number;
  @IsOptional() @IsString() @MaxLength(60) lista?: string;
  /** El ID de la lista con la que se cotiza (0060): es lo que el POS verifica al cerrar. */
  @IsOptional() @IsInt() listaId?: number | null;
  @IsOptional() @IsString() @MaxLength(120) ofertaNombre?: string;
}

class CrearPresupuestoDto {
  @IsInt() clienteId!: number;
  /** Pista: para el vendedor la sucursal sale de su sesión (`sucursalDeOperacion`). */
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsInt() usuarioId?: number;
  @IsOptional() @IsInt() vendedorId?: number | null;
  @IsOptional() @IsString() entrega?: string;
  @IsOptional() @IsString() @MaxLength(500) observaciones?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => PresupuestoItemDto)
  items!: PresupuestoItemDto[];
}

class ActualizarPresupuestoDto {
  @IsOptional() @IsInt() clienteId?: number;
  @IsOptional() @IsInt() vendedorId?: number | null;
  @IsOptional() @IsString() entrega?: string;
  @IsOptional() @IsString() @MaxLength(500) observaciones?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PresupuestoItemDto)
  items?: PresupuestoItemDto[];
}

class ArmarItemDto {
  @IsInt() itemId!: number;
  @IsOptional() @IsNumber() @Min(0) @Max(MAX_CANTIDAD) cantidadArmada?: number;
  @IsOptional() @IsString() @MaxLength(200) motivo?: string;
}
class ArmarDto {
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ArmarItemDto)
  items?: ArmarItemDto[];
}

class AceptarOrdenDto {
  @IsOptional() @IsInt() usuarioId?: number;
  @IsOptional() @IsInt() clienteId?: number;
  @IsOptional() @IsBoolean() crearCliente?: boolean;
}
class CancelarDto {
  @IsOptional() @IsInt() usuarioId?: number;
  @IsOptional() @IsString() @MaxLength(300) motivo?: string;
}
class DelegarDto {
  @IsOptional() @IsInt() vendedorId?: number | null;
}

/** Lo que la sesión habilita, igual que en Ventas y Cobranzas. */
export interface OpcionesPresupuesto {
  soloSuSucursal?: number;
}

@Injectable()
export class PresupuestosService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly inv: InventarioService,
    private readonly cfg: ConfiguracionService,
    private readonly clientesSvc: ClientesService,
  ) {}

  /**
   * La sucursal del documento tiene que ser la de quien lo toca.
   *
   * Los siete endpoints de escritura no miraban ninguna: con `ventas.presupuestos`
   * se confirmaba un pedido de Fontana y quedaban 400 unidades de ALLÁ en
   * `comprometido`, sacadas de una góndola que quien pedía no había pisado nunca
   * — repetido sobre lo que más rota, es dejar a otra sucursal sin poder vender.
   * Y al revés, `cancelar` sobre el pedido confirmado de otro le liberaba la
   * reserva al vendedor que lo estaba armando.
   */
  private exigirSucursal(p: { sucursalId: number }, opciones: OpcionesPresupuesto) {
    if (opciones.soloSuSucursal && p.sucursalId !== opciones.soloSuSucursal) {
      throw new ForbiddenException('Ese presupuesto es de otra sucursal.');
    }
  }

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
        lista: String(it.lista ?? ''),
        /* El id de la lista con la que se cotizó (0060). `lista` de al lado es su
         * nombre para el papel; este es el que el sistema puede verificar cuando
         * el pedido se cierra en el POS. */
        listaId: it.listaId ? Number(it.listaId) : null,
        ofertaNombre: String(it.ofertaNombre ?? ''), motivo: '',
      };
    }).filter((it: any) => it.productoId && it.cantidad > 0);
    return { limpios, subtotalNeto: money(neto), ivaTotal: money(iva), total: money(neto + iva) };
  }

  private async getRow(id: number) {
    const [p] = await this.db.select().from(presupuestos).where(eq(presupuestos.id, id)).limit(1);
    if (!p) throw new NotFoundException('Presupuesto inexistente.');
    return p;
  }

  /**
   * El listado, CON TECHO Y CON FILTROS. Antes se bajaba la tabla entera con
   * todos sus renglones en dos consultas, y las tres pantallas que lo usan lo
   * pedían así: al año de operación son miles de documentos con decenas de miles
   * de renglones en cada apertura, más los datos de contacto (nombre, DNI,
   * teléfono) de cada pedido web viajando siempre. Órdenes web además lo
   * recargaba con un poller cada 30 segundos.
   *
   * El `limit` por defecto es generoso a propósito: las pantallas de hoy no
   * paginan, así que un techo chico les escondería documentos sin avisar. Lo que
   * cierra el crecimiento es que ahora se puede filtrar por estado y sucursal.
   */
  async list(filtros: {
    estado?: string; origen?: string; sucursalId?: number; limit?: number;
  } = {}) {
    const where = [
      filtros.estado ? eq(presupuestos.estado, filtros.estado as any) : undefined,
      filtros.origen ? eq(presupuestos.origen, filtros.origen) : undefined,
      filtros.sucursalId ? eq(presupuestos.sucursalId, filtros.sucursalId) : undefined,
    ].filter(Boolean);
    const limit = Math.min(Math.max(Number(filtros.limit) || 500, 1), 2000);

    const ps = await this.db.select().from(presupuestos)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(presupuestos.id))
      .limit(limit);
    if (!ps.length) return [];
    // Los renglones SOLO de los que se devuelven, no toda la tabla hija.
    const its = await this.db.select().from(presupuestoItems)
      .where(inArray(presupuestoItems.presupuestoId, ps.map((p) => p.id)));
    return ps.map((p) => ({ ...p, items: its.filter((i) => i.presupuestoId === p.id) }));
  }

  async crear(dto: CrearPresupuestoDto, sucursalId: number) {
    if (!dto?.clienteId) throw new BadRequestException('Elegí el cliente del presupuesto.');
    const { limpios, subtotalNeto, ivaTotal, total } = this.totales(dto.items);
    if (!limpios.length) throw new BadRequestException('Agregá al menos un renglón.');
    const entrega = ENTREGAS.has(dto.entrega as string) ? dto.entrega! : 'retiro';
    return this.db.transaction(async (tx) => {
      const [p] = await tx.insert(presupuestos).values({
        clienteId: Number(dto.clienteId), sucursalId,
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
  async actualizar(id: number, dto: ActualizarPresupuestoDto, opciones: OpcionesPresupuesto = {}) {
    const p = await this.getRow(id);
    this.exigirSucursal(p, opciones);
    if (p.estado !== 'borrador') throw new BadRequestException('Solo un borrador se edita — usá "Reabrir" para re-cotizar.');
    const { limpios, subtotalNeto, ivaTotal, total } = this.totales(dto.items ?? []);
    if (!limpios.length) throw new BadRequestException('Agregá al menos un renglón.');
    await this.db.transaction(async (tx) => {
      await tx.update(presupuestos).set({
        clienteId: dto.clienteId != null ? Number(dto.clienteId) : p.clienteId,
        vendedorId: dto.vendedorId !== undefined ? dto.vendedorId : p.vendedorId,
        entrega: ENTREGAS.has(dto.entrega as string) ? dto.entrega! : p.entrega,
        observaciones: dto.observaciones != null ? String(dto.observaciones).trim() : p.observaciones,
        subtotalNeto, ivaTotal, total,
      }).where(eq(presupuestos.id, id));
      await tx.delete(presupuestoItems).where(eq(presupuestoItems.presupuestoId, id));
      await tx.insert(presupuestoItems).values(limpios.map((it) => ({ ...it, presupuestoId: id })));
    });
    return { ok: true };
  }

  /** borrador → enviado: congela la palabra y arranca el reloj de validez. */
  async enviar(id: number, opciones: OpcionesPresupuesto = {}) {
    this.exigirSucursal(await this.getRow(id), opciones);
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
  async reabrir(id: number, opciones: OpcionesPresupuesto = {}) {
    this.exigirSucursal(await this.getRow(id), opciones);
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
  async confirmar(id: number, usuarioId?: number, opciones: OpcionesPresupuesto = {}) {
    return this.db.transaction(async (tx) => {
      const [p] = await tx.select().from(presupuestos).where(eq(presupuestos.id, id)).limit(1);
      if (!p) throw new NotFoundException('Presupuesto inexistente.');
      /* Confirmar RESERVA stock: sin esto se apartaba mercadería de una sucursal
       * ajena, que es denegación de venta con solo poder cotizar. */
      this.exigirSucursal(p, opciones);
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
  async armar(id: number, o: ArmarDto, opciones: OpcionesPresupuesto = {}) {
    const p = await this.getRow(id);
    this.exigirSucursal(p, opciones);
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
  async delegar(id: number, vendedorId: number | null, opciones: OpcionesPresupuesto = {}) {
    const p = await this.getRow(id);
    this.exigirSucursal(p, opciones);
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
  async aceptar(id: number, o: AceptarOrdenDto, opciones: OpcionesPresupuesto = {}) {
    const p = await this.getRow(id);
    this.exigirSucursal(p, opciones);
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
  async cancelar(id: number, usuarioId?: number, motivo?: string, opciones: OpcionesPresupuesto = {}) {
    return this.db.transaction(async (tx) => {
      const [p] = await tx.select().from(presupuestos).where(eq(presupuestos.id, id)).limit(1);
      if (!p) throw new NotFoundException('Presupuesto inexistente.');
      /* Cancelar LIBERA la reserva: sin esto se le desarmaba el pedido al
       * vendedor de otra sucursal que lo estaba preparando. */
      this.exigirSucursal(p, opciones);
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

/**
 * El presupuesto es la pantalla `ventas.presupuestos`, o la acción
 * `presupuestos` para el que cotiza desde el punto de venta.
 *
 * Las ÓRDENES WEB viven en la misma tabla pero son otra pantalla
 * (`ventas.ordenes`): quien atiende los pedidos del sitio acepta y cancela sin
 * tener por qué poder armar una cotización a mano, así que esos tres endpoints
 * y las lecturas aceptan las dos llaves.
 */
@Controller('presupuestos')
@Permiso('ventas.presupuestos', 'presupuestos')
export class PresupuestosController {
  constructor(private readonly svc: PresupuestosService) {}

  /**
   * Lo que la sesión habilita. El jefe atraviesa sucursales; el vendedor no sale
   * de la suya, ni para tocar ni para ver.
   */
  private opciones(sesion: Sesion): OpcionesPresupuesto {
    return { soloSuSucursal: esJefe(sesion) ? undefined : sesion.sucursalId };
  }

  /*
   * El listado se FILTRA POR SUCURSAL para el que no es jefe, del lado del
   * servidor y no de la pantalla. Además de no mostrarle documentos ajenos, evita
   * lo que el candado nuevo dejaría a la vista: una lista llena de botones que
   * devuelven 403. Mismo criterio que el listado de ventas.
   */
  @Get() @Permiso('ventas.presupuestos', 'presupuestos', 'ventas.ordenes')
  list(
    @Auth() sesion: Sesion,
    @Query('estado') estado?: string,
    @Query('origen') origen?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.list({
      estado, origen,
      sucursalId: esJefe(sesion) ? undefined : sesion.sucursalId,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('ordenes/pendientes') @Permiso('ventas.presupuestos', 'presupuestos', 'ventas.ordenes')
  ordenesPendientes() { return this.svc.ordenesPendientes(); }

  @Get(':id/orden') @Permiso('ventas.presupuestos', 'presupuestos', 'ventas.ordenes')
  orden(@Param('id', ParseIntPipe) id: number) { return this.svc.orden(id); }

  @Post()
  crear(@Body() dto: CrearPresupuestoDto, @Auth() sesion: Sesion) {
    const sucursalId = sucursalDeOperacion(sesion, dto.sucursalId);
    if (!sucursalId) throw new BadRequestException('Tu sesión no tiene sucursal: volvé a entrar eligiéndola.');
    return this.svc.crear(dto, sucursalId);
  }

  @Post(':id/aceptar') @Permiso('ventas.presupuestos', 'presupuestos', 'ventas.ordenes')
  aceptar(@Param('id', ParseIntPipe) id: number, @Body() dto: AceptarOrdenDto, @Auth() sesion: Sesion) {
    return this.svc.aceptar(id, dto ?? {}, this.opciones(sesion));
  }

  @Patch(':id')
  actualizar(@Param('id', ParseIntPipe) id: number, @Body() dto: ActualizarPresupuestoDto, @Auth() sesion: Sesion) {
    return this.svc.actualizar(id, dto ?? {}, this.opciones(sesion));
  }

  @Post(':id/enviar')
  enviar(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) {
    return this.svc.enviar(id, this.opciones(sesion));
  }

  @Post(':id/reabrir')
  reabrir(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) {
    return this.svc.reabrir(id, this.opciones(sesion));
  }

  @Post(':id/confirmar')
  confirmar(@Param('id', ParseIntPipe) id: number, @Body() dto: CancelarDto, @Auth() sesion: Sesion) {
    return this.svc.confirmar(id, dto?.usuarioId, this.opciones(sesion));
  }

  @Post(':id/armar')
  armar(@Param('id', ParseIntPipe) id: number, @Body() dto: ArmarDto, @Auth() sesion: Sesion) {
    return this.svc.armar(id, dto ?? {}, this.opciones(sesion));
  }

  @Post(':id/delegar')
  delegar(@Param('id', ParseIntPipe) id: number, @Body() dto: DelegarDto, @Auth() sesion: Sesion) {
    return this.svc.delegar(id, dto?.vendedorId ?? null, this.opciones(sesion));
  }

  @Post(':id/cancelar') @Permiso('ventas.presupuestos', 'presupuestos', 'ventas.ordenes')
  cancelar(@Param('id', ParseIntPipe) id: number, @Body() dto: CancelarDto, @Auth() sesion: Sesion) {
    return this.svc.cancelar(id, dto?.usuarioId, dto?.motivo, this.opciones(sesion));
  }
}

@Module({
  imports: [InventarioModule, ConfiguracionModule, ClientesModule],
  controllers: [PresupuestosController],
  providers: [PresupuestosService],
  exports: [PresupuestosService],
})
export class PresupuestosModule {}
