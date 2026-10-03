/**
 * COBRO CON QR DE MERCADO PAGO (0126, 30/9/2026 — pedido del dueño)
 * ============================================================================
 * «Que quede pago pendiente y cuando impacta, que se cierre sola la venta.»
 *
 * MODELO: QR FIJO POR CAJA (API de Orders, modo estático). Cada computadora
 * que cobra tiene su caja en Mercado Pago con un QR impreso en el mostrador.
 * El ERP le manda el monto a ESA caja; el cliente escanea, ve el monto y paga.
 *
 * EL CIRCUITO:
 *   1. La caja pide el cobro (`POST /mercadopago/cobros`): se valida el ticket
 *      y los pagos, se guarda CÓMO se va a cerrar la venta (factura o ticket,
 *      los otros medios si es mixto, factura a CUIT…) y se crea la orden.
 *      Desde ahí el ticket queda trabado (ver `sinCobroQrVivo` en Ventas).
 *   2. El cliente paga. Mercado Pago avisa (`POST /mercadopago/webhook`).
 *   3. El ERP NO le cree al aviso: pide la orden con su token
 *      (`GET /v1/orders/{id}`) y recién si está `processed`, por el monto y
 *      la referencia de ESE cobro, cierra la venta con el mismo camino que la
 *      caja (`VentasService.confirmar`) — stock, caja, factura, todo igual.
 *   4. Red por si el aviso no llega: la caja consulta mientras espera y un
 *      reloj revisa cada 20 s los cobros que siguen esperando.
 *   5. Segunda vía (3/10/2026): si la orden no dice que se pagó, se busca el
 *      PAGO por la referencia del cobro. Y si igual no aparece, la caja tiene
 *      «El cliente ya pagó: buscar el pago» — pagos aprobados por el monto,
 *      la caja elige uno, se verifica en Mercado Pago y se cierra.
 *   Cada consulta deja escrito en el cobro qué contestó Mercado Pago.
 *
 * NUNCA SE PIERDE UN PAGO: si entró la plata pero la venta no pudo cerrarse
 * (sin stock, precio cambiado…), el cobro queda en `error` con el motivo y el
 * número de operación, a la vista de la caja, con «Reintentar».
 */
import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Inject, Injectable, Logger, Module,
  NotFoundException, OnModuleDestroy, OnModuleInit, Param, ParseIntPipe, Post, Query, Req,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { Auth, Permiso, Publico, type Sesion } from '../auth/auth.decoradores';
import { esJefe } from '../auth/auth.guard';
import { mpCajas, mpCobros, mpSucursales, sucursales, terminales } from '../db/schema';
import { terminalPorToken } from '../sucursales/sucursales.module';
import { VentasModule, VentasService } from '../ventas/ventas.module';
import { MP, firmaValida, importeMp, mp, pagoDeOrden, pagoSirve, resumenPago } from './api';

/* ------------------------------- DTOs ------------------------------- */

class PagoOtroDto {
  @IsIn(['efectivo', 'transferencia', 'tarjeta_debito', 'tarjeta_credito', 'qr', 'otro']) medio!: string;
  @IsNumber() @Min(0) @Max(100_000_000) importe!: number;
}

/** Lo que se hace con la venta cuando el pago entra: lo mismo que manda el cobro de siempre. */
class ConfirmarQrDto {
  @IsIn(['ticket', 'factura']) tipo!: 'ticket' | 'factura';
  @IsOptional() @IsInt() cajaSesionId?: number;
  @IsOptional() @IsInt() operadorId?: number;
  @IsOptional() @IsString() @MaxLength(500) observaciones?: string;
  /** Los OTROS medios si el cobro es mixto (efectivo + QR…). */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PagoOtroDto) pagos?: PagoOtroDto[];
  /** Factura a un CUIT (0125), tal cual la manda la caja. */
  @IsOptional() facturaCuit?: unknown;
}

class CrearCobroDto {
  @IsInt() ventaId!: number;
  /** El token de «Este equipo»: dice qué caja (y qué QR) cobra. */
  @IsString() @MaxLength(200) terminalToken!: string;
  @IsNumber() @Min(0.01) @Max(100_000_000) montoQr!: number;
  @ValidateNested() @Type(() => ConfirmarQrDto) confirmar!: ConfirmarQrDto;
}

class CrearCajaDto {
  @IsInt() terminalId!: number;
  /** Para el alta de la sucursal en Mercado Pago (solo la primera vez). */
  @IsOptional() @IsString() @MaxLength(80) ciudad?: string;
  @IsOptional() @IsString() @MaxLength(80) provincia?: string;
  @IsOptional() @IsNumber() latitud?: number;
  @IsOptional() @IsNumber() longitud?: number;
}

const ESTADOS_VIVOS = ['esperando', 'procesando'];
/** Formosa capital: la ubicación por defecto del alta de sucursal (se puede corregir). */
const FORMOSA = { lat: -26.1849, lng: -58.1731 };

@Injectable()
export class MercadoPagoService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('MercadoPago');
  private reloj: ReturnType<typeof setInterval> | null = null;
  private userId: number | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly ventas: VentasService,
  ) {}

  /* ------------------------------ la cuenta ------------------------------ */

  private async cuentaId(): Promise<number> {
    if (this.userId) return this.userId;
    const yo = await mp.yo();
    this.userId = Number(yo.id);
    return this.userId;
  }

  async estado() {
    const base = { configurado: MP.configurado, avisosConFirma: !!MP.secreto, cuenta: null as any, error: '' };
    if (MP.configurado) {
      try {
        const yo = await mp.yo();
        this.userId = Number(yo.id);
        base.cuenta = { id: yo.id, nombre: yo.nickname ?? '', pais: yo.site_id ?? '' };
      } catch (e) {
        base.error = (e as Error).message;
      }
    }
    const [cajas, equipos] = await Promise.all([
      this.db.select({
        id: mpCajas.id, nombre: mpCajas.nombre, sucursalId: mpCajas.sucursalId, sucursal: sucursales.nombre,
        terminalId: mpCajas.terminalId, externalPosId: mpCajas.externalPosId, qrImagen: mpCajas.qrImagen, qrPdf: mpCajas.qrPdf,
        activa: mpCajas.activa, creadaEn: mpCajas.creadaEn,
      }).from(mpCajas).innerJoin(sucursales, eq(sucursales.id, mpCajas.sucursalId)).orderBy(mpCajas.sucursalId, mpCajas.id),
      this.db.select({ id: terminales.id, nombre: terminales.nombre, sucursalId: terminales.sucursalId, sucursal: sucursales.nombre, activa: terminales.activa })
        .from(terminales).innerJoin(sucursales, eq(sucursales.id, terminales.sucursalId)).orderBy(terminales.sucursalId, terminales.id),
    ]);
    return { ...base, cajas, equipos };
  }

  /* ------------------------ alta de sucursal y caja ------------------------ */

  /**
   * LA CAJA DE UN EQUIPO. Si la sucursal todavía no está en Mercado Pago, la da
   * de alta primero (con su domicilio). Idempotente: si el equipo ya tiene su
   * caja, la devuelve.
   */
  async crearCaja(dto: CrearCajaDto) {
    const [t] = await this.db.select().from(terminales).where(eq(terminales.id, dto.terminalId)).limit(1);
    if (!t) throw new NotFoundException('Ese equipo no existe (Sistema › Este equipo).');
    if (!t.activa) throw new BadRequestException('Ese equipo está dado de baja.');
    const [ya] = await this.db.select().from(mpCajas).where(and(eq(mpCajas.terminalId, t.id), eq(mpCajas.activa, true))).limit(1);
    if (ya) return ya;
    const [s] = await this.db.select().from(sucursales).where(eq(sucursales.id, t.sucursalId)).limit(1);
    const userId = await this.cuentaId();

    let [ms] = await this.db.select().from(mpSucursales).where(eq(mpSucursales.sucursalId, s.id)).limit(1);
    if (!ms) {
      const dir = String(s.direccion || '').split(',')[0].trim();
      if (!dir) throw new BadRequestException(`Cargá el domicilio de ${s.nombre} en Gerencia › Sucursales: Mercado Pago lo pide para dar de alta la sucursal.`);
      const m = /^(.*?)\s+(\d+[a-zA-Z]?)$/.exec(dir);
      const externalId = `SYA${s.id}`;
      try {
        const r: any = await mp.crearSucursal(userId, {
          name: `Sabor y Aroma ${s.nombre}`.slice(0, 60),
          external_id: externalId,
          location: {
            street_name: (m ? m[1] : dir).slice(0, 80),
            street_number: m ? m[2] : 'S/N',
            city_name: dto.ciudad || 'Formosa',
            state_name: dto.provincia || 'Formosa',
            latitude: dto.latitud ?? FORMOSA.lat,
            longitude: dto.longitud ?? FORMOSA.lng,
            reference: s.nombre,
          },
        });
        [ms] = await this.db.insert(mpSucursales).values({ sucursalId: s.id, mpStoreId: String(r.id), externalId }).returning();
      } catch (e) {
        throw new BadRequestException(`No se pudo dar de alta la sucursal en Mercado Pago: ${(e as Error).message}`);
      }
    }

    const externalPosId = `SYA${s.id}C${t.id}`;
    let r: any;
    try {
      r = await mp.crearCaja({
        // Solo lo que pide la documentación de /v2/pos (nombre ≤45, letras/números/espacios/guiones).
        name: `${s.nombre} ${t.nombre}`.replace(/[^A-Za-z0-9_ -]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 45).trim(),
        store_id: ms.mpStoreId,
        external_id: externalPosId,
        config: { qr: { operating_mode: 'pdv' } },
      }, `sya-caja-${externalPosId}`);
    } catch (e) {
      throw new BadRequestException(`No se pudo crear la caja en Mercado Pago: ${(e as Error).message}`);
    }
    const qr = r?.qr_response ?? r?.qr ?? {};
    const [caja] = await this.db.insert(mpCajas).values({
      sucursalId: s.id, terminalId: t.id, nombre: t.nombre, mpPosId: String(r?.id ?? ''), externalPosId,
      qrImagen: qr.template_image || qr.image || '', qrPdf: qr.template_document || '',
    }).returning();
    return caja;
  }

  /** La caja de Mercado Pago de ESTE equipo (por el token de «Este equipo»). */
  async miCaja(token: string) {
    const t = await terminalPorToken(this.db, token);
    if (!t || !t.activa) return { caja: null, motivo: 'Este equipo no está registrado (Sistema › Este equipo).' };
    const [caja] = await this.db.select().from(mpCajas).where(and(eq(mpCajas.terminalId, t.id), eq(mpCajas.activa, true))).limit(1);
    if (!caja) return { caja: null, motivo: `«${t.nombre}» todavía no tiene caja de Mercado Pago (Ventas › Configuración › Mercado Pago).` };
    const [vivo] = await this.db.select().from(mpCobros)
      .where(and(eq(mpCobros.cajaId, caja.id), inArray(mpCobros.estado, ESTADOS_VIVOS))).limit(1);
    return { caja: { id: caja.id, nombre: caja.nombre, sucursalId: caja.sucursalId }, cobroVivo: vivo ? this.vista(vivo) : null, configurado: MP.configurado };
  }

  /* ------------------------------- el cobro ------------------------------- */

  private vista(c: typeof mpCobros.$inferSelect) {
    return {
      id: c.id, ventaId: c.ventaId, cajaId: c.cajaId, estado: c.estado, monto: c.monto, paymentId: c.paymentId,
      detalle: c.detalle, creadoEn: c.creadoEn, actualizadoEn: c.actualizadoEn,
      tipo: (c.confirmar as any)?.tipo ?? 'ticket',
    };
  }

  async crearCobro(dto: CrearCobroDto, sesion: Sesion) {
    if (!MP.configurado) throw new BadRequestException('Mercado Pago no está configurado en el servidor.');
    const t = await terminalPorToken(this.db, dto.terminalToken);
    if (!t || !t.activa) throw new BadRequestException('Este equipo no está registrado: registralo en Sistema › Este equipo.');
    const [caja] = await this.db.select().from(mpCajas).where(and(eq(mpCajas.terminalId, t.id), eq(mpCajas.activa, true))).limit(1);
    if (!caja) throw new BadRequestException(`«${t.nombre}» no tiene caja de Mercado Pago: creala en Ventas › Configuración › Mercado Pago.`);

    const venta = await this.ventas.get(dto.ventaId);
    if (venta.estado !== 'borrador') throw new BadRequestException('Este ticket ya se cobró.');
    if (!esJefe(sesion) && venta.sucursalId !== sesion.sucursalId) throw new ForbiddenException('Ese ticket es de otra sucursal.');
    if (venta.sucursalId !== caja.sucursalId) throw new BadRequestException('El QR de este equipo es de otra sucursal que el ticket.');
    if (!venta.items?.length) throw new BadRequestException('El ticket está vacío.');
    const [previo] = await this.db.select().from(mpCobros)
      .where(and(eq(mpCobros.ventaId, venta.id), inArray(mpCobros.estado, [...ESTADOS_VIVOS, 'error']))).limit(1);
    if (previo) {
      throw new BadRequestException(previo.estado === 'error'
        ? 'Este ticket ya se cobró por QR y la venta quedó sin cerrar: resolvelo (Reintentar) antes de volver a cobrar.'
        : 'Este ticket ya tiene un cobro por QR esperando.');
    }

    const otros = (dto.confirmar.pagos ?? []).filter((p) => Number(p.importe) > 0);
    if (otros.some((p: any) => p.cuotas)) throw new BadRequestException('Con QR de Mercado Pago no se combina crédito en cuotas.');
    const montoQr = Math.round(Number(dto.montoQr) * 100) / 100;
    const suma = Math.round((otros.reduce((a, p) => a + Number(p.importe), 0) + montoQr) * 100) / 100;
    if (Math.abs(suma - Number(venta.total)) > 0.01) {
      throw new BadRequestException(`Los pagos suman $${suma.toFixed(2)} y el ticket es de $${Number(venta.total).toFixed(2)}.`);
    }

    /* El precio mayorista se paga con sus medios (1/10/2026): si el QR no está
     * entre ellos, se rechaza ACÁ — después de que el cliente pagó, la venta no
     * cerraría y la plata quedaría cobrada. */
    await this.ventas.validarMediosMayorista(venta.items as any[], 'contado', [...otros, { medio: 'qr', importe: montoQr }]);

    const confirmar = {
      tipo: dto.confirmar.tipo, condicionPago: 'contado',
      cajaSesionId: dto.confirmar.cajaSesionId, operadorId: dto.confirmar.operadorId, usuarioId: sesion.usuarioId,
      observaciones: dto.confirmar.observaciones, pagos: otros.map((p) => ({ medio: p.medio, importe: Number(p.importe) })),
      ...(dto.confirmar.facturaCuit ? { facturaCuit: dto.confirmar.facturaCuit } : {}),
    };

    let cobro: typeof mpCobros.$inferSelect;
    try {
      [cobro] = await this.db.insert(mpCobros).values({
        ventaId: venta.id, cajaId: caja.id, sucursalId: caja.sucursalId, monto: montoQr, confirmar, usuarioId: sesion.usuarioId,
      }).returning();
    } catch (e) {
      if (/uq_mp_cobros_venta_vivo/.test(String((e as any)?.message ?? (e as any)?.cause?.message ?? ''))) {
        throw new BadRequestException('Este ticket ya tiene un cobro por QR esperando.');
      }
      if (/uq_mp_cobros_caja_vivo/.test(String((e as any)?.message ?? (e as any)?.cause?.message ?? ''))) {
        throw new BadRequestException('El QR de esta caja está ocupado con otro cobro: esperá que se pague o cancelalo.');
      }
      throw e;
    }

    const referencia = `SYA-V${venta.id}-C${cobro.id}`;
    try {
      const orden: any = await mp.crearOrden({
        type: 'qr',
        external_reference: referencia,
        total_amount: importeMp(montoQr),
        description: 'Compra en Sabor y Aroma',
        expiration_time: 'PT15M',
        config: { qr: { external_pos_id: caja.externalPosId, mode: 'static' } },
        transactions: { payments: [{ amount: importeMp(montoQr) }] },
        items: [{ title: 'Compra en Sabor y Aroma', unit_price: importeMp(montoQr), quantity: 1, unit_measure: 'unit' }],
      }, `sya-cobro-${cobro.id}`);
      const [c] = await this.db.update(mpCobros).set({ orderId: String(orden.id), actualizadoEn: new Date() })
        .where(eq(mpCobros.id, cobro.id)).returning();
      return this.vista(c);
    } catch (e) {
      await this.db.update(mpCobros).set({ estado: 'cancelado', detalle: `No se pudo crear el cobro: ${(e as Error).message}`, actualizadoEn: new Date() })
        .where(eq(mpCobros.id, cobro.id));
      throw new BadRequestException(`Mercado Pago no aceptó el cobro: ${(e as Error).message}`);
    }
  }

  /** Cómo está un cobro. Si sigue esperando, se le pregunta a Mercado Pago (la red por si el aviso no llegó). */
  async verCobro(id: number, sesion: Sesion) {
    let [c] = await this.db.select().from(mpCobros).where(eq(mpCobros.id, id)).limit(1);
    if (!c) throw new NotFoundException('Cobro inexistente.');
    if (!esJefe(sesion) && c.sucursalId !== sesion.sucursalId) throw new ForbiddenException('Ese cobro es de otra sucursal.');
    if (c.estado === 'esperando' && c.orderId && Date.now() - new Date(c.actualizadoEn).getTime() > 2500) {
      await this.procesarOrden(c.orderId).catch((e) => this.log.warn(`consulta del cobro ${id}: ${(e as Error).message}`));
      [c] = await this.db.select().from(mpCobros).where(eq(mpCobros.id, id)).limit(1);
    }
    return this.vista(c);
  }

  /** El cobro vivo de un ticket (la caja lo retoma si se recargó la pantalla). */
  async cobroDeVenta(ventaId: number) {
    const [c] = await this.db.select().from(mpCobros).where(eq(mpCobros.ventaId, ventaId)).orderBy(desc(mpCobros.id)).limit(1);
    return c ? this.vista(c) : null;
  }

  /**
   * CANCELAR. Si justo se pagó (Mercado Pago ya no deja cancelar), se procesa
   * el pago y la venta se cierra igual — decisión del dueño: el pago que entra
   * se registra.
   */
  async cancelarCobro(id: number, sesion: Sesion) {
    const [c] = await this.db.select().from(mpCobros).where(eq(mpCobros.id, id)).limit(1);
    if (!c) throw new NotFoundException('Cobro inexistente.');
    if (!esJefe(sesion) && c.sucursalId !== sesion.sucursalId) throw new ForbiddenException('Ese cobro es de otra sucursal.');
    if (c.estado !== 'esperando') return this.vista(c);
    if (c.orderId) {
      try {
        await mp.cancelarOrden(c.orderId, `sya-cancelar-${c.id}`);
      } catch (e) {
        // ¿No se pudo porque ya se pagó? Se mira la orden y se procesa lo que haya.
        await this.procesarOrden(c.orderId).catch(() => undefined);
        const [d] = await this.db.select().from(mpCobros).where(eq(mpCobros.id, id)).limit(1);
        if (d.estado !== 'esperando') return this.vista(d);
        throw new BadRequestException(`Mercado Pago no dejó cancelar: ${(e as Error).message}`);
      }
    }
    const [d] = await this.db.update(mpCobros).set({ estado: 'cancelado', detalle: 'Cancelado desde la caja.', actualizadoEn: new Date() })
      .where(and(eq(mpCobros.id, id), eq(mpCobros.estado, 'esperando'))).returning();
    if (d) return this.vista(d);
    const [e2] = await this.db.select().from(mpCobros).where(eq(mpCobros.id, id)).limit(1);
    return this.vista(e2);
  }

  /** Un cobro que quedó en `error` (se pagó y la venta no cerró): se reintenta cerrar la venta. */
  async reintentar(id: number, sesion: Sesion) {
    const [c] = await this.db.select().from(mpCobros).where(eq(mpCobros.id, id)).limit(1);
    if (!c) throw new NotFoundException('Cobro inexistente.');
    if (!esJefe(sesion) && c.sucursalId !== sesion.sucursalId) throw new ForbiddenException('Ese cobro es de otra sucursal.');
    if (c.estado !== 'error') return this.vista(c);
    await this.cerrarVenta(c.id, ['error']);
    const [d] = await this.db.select().from(mpCobros).where(eq(mpCobros.id, id)).limit(1);
    return this.vista(d);
  }

  /**
   * RESUELTO A MANO (solo administrador): un cobro pagado cuya venta
   * no se pudo cerrar y no se va a cerrar (se le devolvió la plata desde
   * Mercado Pago, o se hizo la venta de otra forma). Queda el motivo y quién;
   * el ticket se destraba.
   */
  async resolverAMano(id: number, motivo: string, sesion: Sesion) {
    if (!esJefe(sesion)) throw new ForbiddenException('Solo un administrador puede marcar un cobro como resuelto a mano.');
    const texto = String(motivo ?? '').trim();
    if (texto.length < 5) throw new BadRequestException('Escribí qué se hizo con ese pago (por ejemplo: «se devolvió desde Mercado Pago»).');
    const [c] = await this.db.update(mpCobros).set({
      estado: 'cancelado', detalle: `Resuelto a mano por el usuario ${sesion.usuarioId}: ${texto.slice(0, 300)}`, actualizadoEn: new Date(),
    }).where(and(eq(mpCobros.id, id), eq(mpCobros.estado, 'error'))).returning();
    if (!c) throw new BadRequestException('Ese cobro no está pendiente de resolver.');
    return this.vista(c);
  }

  /**
   * LA VERDAD SOBRE UNA ORDEN: se la pide a Mercado Pago y se actúa según su
   * estado. Es lo que corre con cada aviso, con cada consulta de la caja y con
   * el reloj. Idempotente: correrlo diez veces cierra la venta una sola.
   */
  async procesarOrden(orderId: string) {
    const [c] = await this.db.select().from(mpCobros).where(eq(mpCobros.orderId, orderId)).limit(1);
    if (!c || !ESTADOS_VIVOS.includes(c.estado)) return;
    const ref = `SYA-V${c.ventaId}-C${c.id}`;
    const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'America/Argentina/Buenos_Aires' });
    /*
     * LO QUE CONTESTÓ MERCADO PAGO QUEDA A LA VISTA (3/10/2026). El primer cobro
     * real quedó «esperando» con la plata acreditada y el motivo solo estaba en
     * el log del servidor: ahora cada consulta escribe en el cobro qué dijo
     * Mercado Pago (o por qué no se pudo preguntar), y la caja lo muestra.
     */
    let orden: any = null;
    let falla = '';
    try {
      orden = await mp.orden(orderId);
    } catch (e) {
      falla = (e as Error).message;
      this.log.warn(`cobro ${c.id}: no se pudo consultar la orden ${orderId}: ${falla}`);
    }
    const estado = String(orden?.status ?? '').toLowerCase();
    const { pagado, paymentId } = orden ? pagoDeOrden(orden, c.monto) : { pagado: false, paymentId: '' };

    if (pagado) {
      const refOrden = String(orden?.external_reference ?? '');
      const total = Number(orden?.total_amount ?? orden?.total_paid_amount ?? 0);
      if (refOrden !== ref || Math.abs(total - c.monto) > 0.01) {
        await this.db.update(mpCobros).set({
          estado: 'error', detalle: `Mercado Pago informó un pago que no coincide (referencia ${refOrden}, $${total}). Revisalo en tu cuenta antes de entregar la mercadería.`, actualizadoEn: new Date(),
        }).where(eq(mpCobros.id, c.id));
        return;
      }
      await this.db.update(mpCobros).set({ paymentId, actualizadoEn: new Date() }).where(eq(mpCobros.id, c.id));
      await this.cerrarVenta(c.id, ['esperando']);
      return;
    }
    if (estado === 'canceled' || estado === 'cancelled') {
      await this.db.update(mpCobros).set({ estado: 'cancelado', detalle: 'Cancelado en Mercado Pago.', actualizadoEn: new Date() })
        .where(and(eq(mpCobros.id, c.id), eq(mpCobros.estado, 'esperando')));
      return;
    }

    /*
     * LA SEGUNDA VÍA: la orden no dice que se pagó (o no se pudo consultar).
     * Se busca el PAGO por la referencia de este cobro: si hay uno aprobado y
     * por el monto, se cierra con ese. Antes de vencer, también: el pago puede
     * haber entrado justo al límite.
     */
    let porPago: any = null;
    let fallaPago = '';
    if (c.estado === 'esperando') {
      try {
        const r = await mp.buscarPagos({ external_reference: ref, sort: 'date_created', criteria: 'desc', limit: '10' });
        porPago = (r?.results ?? []).find((p: any) => String(p?.external_reference ?? '') === ref && pagoSirve(p, c.monto)) ?? null;
      } catch (e) {
        fallaPago = (e as Error).message;
        this.log.warn(`cobro ${c.id}: no se pudo buscar el pago ${ref}: ${fallaPago}`);
      }
    }
    if (porPago) {
      this.log.log(`cobro ${c.id}: la orden dice «${estado || falla}» pero el pago ${porPago.id} está aprobado: se cierra con el pago.`);
      await this.db.update(mpCobros).set({ paymentId: String(porPago.id), actualizadoEn: new Date() }).where(eq(mpCobros.id, c.id));
      await this.cerrarVenta(c.id, ['esperando']);
      return;
    }
    if (estado === 'expired') {
      await this.db.update(mpCobros).set({ estado: 'vencido', detalle: 'Nadie pagó en el tiempo del cobro.', actualizadoEn: new Date() })
        .where(and(eq(mpCobros.id, c.id), eq(mpCobros.estado, 'esperando')));
      return;
    }
    const legible: Record<string, string> = {
      created: 'todavía no se pagó', at_terminal: 'el cliente lo está pagando', action_required: 'el pago necesita una acción del cliente',
      processing: 'el pago se está procesando', refunded: 'el pago fue devuelto', failed: 'el pago falló',
    };
    const dice = falla
      ? `no se pudo consultar el cobro (${falla})${fallaPago ? `; tampoco el pago (${fallaPago})` : ''}`
      : `${legible[estado] ?? `estado «${estado || 'sin estado'}»`}${orden?.status_detail && String(orden.status_detail).toLowerCase() !== estado ? ` (${orden.status_detail})` : ''}`;
    await this.db.update(mpCobros).set({ detalle: `Mercado Pago, ${hora}: ${dice}.`.slice(0, 600), actualizadoEn: new Date() })
      .where(and(eq(mpCobros.id, c.id), eq(mpCobros.estado, 'esperando')));
  }

  /* --------------------- el rescate: «el cliente ya pagó» --------------------- */

  /** El cobro, con el permiso de la sucursal. */
  private async cobroDeSucursal(id: number, sesion: Sesion) {
    const [c] = await this.db.select().from(mpCobros).where(eq(mpCobros.id, id)).limit(1);
    if (!c) throw new NotFoundException('Cobro inexistente.');
    if (!esJefe(sesion) && c.sucursalId !== sesion.sucursalId) throw new ForbiddenException('Ese cobro es de otra sucursal.');
    return c;
  }

  /** Pagos ya usados por OTRO cobro: no se vinculan dos veces. */
  private async pagosUsados(exceptoCobro: number, ids: string[]) {
    if (!ids.length) return new Set<string>();
    const filas = await this.db.select({ paymentId: mpCobros.paymentId }).from(mpCobros)
      .where(and(inArray(mpCobros.paymentId, ids), sql`${mpCobros.id} <> ${exceptoCobro}`, inArray(mpCobros.estado, ['procesando', 'pagado', 'error'])));
    return new Set(filas.map((f) => String(f.paymentId)));
  }

  /**
   * LOS PAGOS QUE PUEDEN SER DE ESTE COBRO: aprobados, por el MISMO monto,
   * recibidos desde 2 minutos antes de mandar el cobro, y que no estén usados
   * en otro. La caja elige y confirma; nada se cierra solo por esto.
   */
  async pagosCandidatos(id: number, sesion: Sesion) {
    const c = await this.cobroDeSucursal(id, sesion);
    if (c.estado !== 'esperando') throw new BadRequestException('Este cobro ya no está esperando el pago.');
    const desde = new Date(c.creadoEn).getTime() - 2 * 60_000;
    const horas = Math.min(24, Math.max(1, Math.ceil((Date.now() - desde) / 3_600_000)));
    let r: any;
    try {
      r = await mp.buscarPagos({ sort: 'date_created', criteria: 'desc', range: 'date_created', begin_date: `NOW-${horas}HOURS`, end_date: 'NOW', limit: '100' });
    } catch (e) {
      throw new BadRequestException(`No se pudieron consultar los pagos en Mercado Pago: ${(e as Error).message}`);
    }
    const ref = `SYA-V${c.ventaId}-C${c.id}`;
    const sirven = (r?.results ?? []).filter((p: any) => pagoSirve(p, c.monto) && new Date(p?.date_created ?? 0).getTime() >= desde);
    const usados = await this.pagosUsados(c.id, sirven.map((p: any) => String(p.id)));
    return {
      monto: c.monto,
      desde: new Date(desde).toISOString(),
      pagos: sirven.filter((p: any) => !usados.has(String(p.id))).map((p: any) => ({
        id: String(p.id),
        monto: Number(p.transaction_amount),
        fecha: p.date_approved ?? p.date_created,
        pagador: [p?.payer?.first_name, p?.payer?.last_name].filter(Boolean).join(' ') || p?.payer?.email || '',
        medio: String(p?.payment_method_id ?? p?.payment_type_id ?? ''),
        /** Es el de este cobro (la misma referencia): el más seguro. */
        deEsteCobro: String(p?.external_reference ?? '') === ref,
      })),
    };
  }

  /**
   * VINCULAR UN PAGO A MANO y cerrar la venta. El pago se vuelve a pedir a
   * Mercado Pago (no se le cree a la pantalla): aprobado, por el monto, de
   * después del cobro y sin usar. Un candado por pago evita que dos cajas
   * usen el mismo a la vez.
   */
  async vincularPago(id: number, paymentId: string, sesion: Sesion) {
    const c = await this.cobroDeSucursal(id, sesion);
    if (c.estado !== 'esperando') return this.vista(c);
    const pid = String(paymentId ?? '').trim();
    if (!/^\d{1,20}$/.test(pid)) throw new BadRequestException('Ese número de pago no es válido.');
    let p: any;
    try {
      p = await mp.pago(pid);
    } catch (e) {
      throw new BadRequestException(`No se pudo verificar el pago en Mercado Pago: ${(e as Error).message}`);
    }
    if (!pagoSirve(p, c.monto)) {
      throw new BadRequestException(`Ese pago no sirve para este cobro: tiene que estar aprobado y ser de $${c.monto.toFixed(2)} (es de $${Number(p?.transaction_amount ?? 0).toFixed(2)}, ${p?.status ?? 'sin estado'}).`);
    }
    if (new Date(p?.date_created ?? 0).getTime() < new Date(c.creadoEn).getTime() - 2 * 60_000) {
      throw new BadRequestException('Ese pago es de antes de mandar el cobro: no puede ser de este ticket.');
    }
    const tomado = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mp-pago-${pid}`}))`);
      const [otro] = await tx.select({ id: mpCobros.id }).from(mpCobros)
        .where(and(eq(mpCobros.paymentId, pid), sql`${mpCobros.id} <> ${c.id}`, inArray(mpCobros.estado, ['procesando', 'pagado', 'error']))).limit(1);
      if (otro) throw new BadRequestException('Ese pago ya está usado en otro cobro.');
      const [d] = await tx.update(mpCobros).set({
        paymentId: pid, detalle: `Pago ${pid} vinculado a mano por el usuario ${sesion.usuarioId}.`, actualizadoEn: new Date(),
      }).where(and(eq(mpCobros.id, c.id), eq(mpCobros.estado, 'esperando'))).returning();
      return d;
    });
    if (!tomado) {
      const [d] = await this.db.select().from(mpCobros).where(eq(mpCobros.id, c.id)).limit(1);
      return this.vista(d);
    }
    this.log.log(`cobro ${c.id}: pago ${pid} vinculado a mano por el usuario ${sesion.usuarioId}.`);
    // La orden ya no se tiene que poder pagar: se intenta anular (si ya se pagó, Mercado Pago no deja y está bien).
    if (c.orderId) await mp.cancelarOrden(c.orderId, `sya-cancelar-${c.id}`).catch(() => undefined);
    await this.cerrarVenta(c.id, ['esperando']);
    const [d] = await this.db.select().from(mpCobros).where(eq(mpCobros.id, c.id)).limit(1);
    return this.vista(d);
  }

  /**
   * CERRAR LA VENTA DE UN COBRO PAGADO. Se «toma» el cobro con un UPDATE
   * condicional (solo uno de los que llegan a la vez lo logra) y se confirma la
   * venta por el mismo camino que la caja.
   */
  private async cerrarVenta(cobroId: number, desde: string[]) {
    const [c] = await this.db.update(mpCobros).set({ estado: 'procesando', actualizadoEn: new Date() })
      .where(and(eq(mpCobros.id, cobroId), inArray(mpCobros.estado, desde))).returning();
    if (!c) return;
    const conf: any = c.confirmar ?? {};
    const ref = c.paymentId ? `MP ${c.paymentId}` : `MP orden ${c.orderId}`;
    const dto = { ...conf, pagos: [...(conf.pagos ?? []), { medio: 'qr', importe: c.monto, referencia: ref }] };
    try {
      await this.ventas.confirmar(c.ventaId, dto, { desdeMercadoPago: true });
      await this.db.update(mpCobros).set({ estado: 'pagado', detalle: '', actualizadoEn: new Date() }).where(eq(mpCobros.id, c.id));
      this.log.log(`Cobro ${c.id}: pagado (${ref}) y venta ${c.ventaId} cerrada.`);
      void this.completarInfoPago(c.id).catch((e) => this.log.warn(`detalle del pago del cobro ${c.id}: ${(e as Error).message}`));
    } catch (e) {
      const msg = String((e as any)?.response?.message ?? (e as Error).message ?? e);
      // ¿Ya estaba cerrada (otro camino llegó primero)? Entonces está bien.
      const v = await this.ventas.get(c.ventaId).catch(() => null);
      if (v && v.estado !== 'borrador') {
        await this.db.update(mpCobros).set({ estado: 'pagado', detalle: '', actualizadoEn: new Date() }).where(eq(mpCobros.id, c.id));
        return;
      }
      await this.db.update(mpCobros).set({
        estado: 'error',
        detalle: `Se cobraron $${c.monto.toFixed(2)} por Mercado Pago (${ref}), pero la venta no se pudo cerrar: ${msg}`,
        actualizadoEn: new Date(),
      }).where(eq(mpCobros.id, c.id));
      this.log.error(`Cobro ${c.id}: pagado pero la venta ${c.ventaId} no cerró: ${msg}`);
    }
  }

  /* ------------------------ con qué pagó el cliente ------------------------ */

  /**
   * CON QUÉ PAGÓ EL CLIENTE (0131, 3/10/2026, pedido del dueño): dinero en
   * cuenta, débito o crédito y en cuántas cuotas, cuánto descontó Mercado Pago
   * y cuánto quedó. Se pregunta al cerrar el cobro y queda en `pago_info`.
   * El pago "clásico" (`/v1/payments/{id}`) trae las comisiones; si no se
   * puede leer, queda lo que dice la orden (tipo y cuotas) y se reintenta
   * después, hasta 5 veces. Nunca toca la venta: es solo para mirar.
   */
  async completarInfoPago(cobroId: number) {
    const [c] = await this.db.select().from(mpCobros).where(eq(mpCobros.id, cobroId)).limit(1);
    if (!c || c.estado !== 'pagado') return;
    const previo: any = c.pagoInfo ?? null;
    if (previo?.completo || (previo?.intentos ?? 0) >= 5) return;
    let deOrden: any = null;
    if (c.orderId) {
      const orden: any = await mp.orden(c.orderId).catch(() => null);
      const pagos: any[] = orden?.transactions?.payments ?? [];
      deOrden = pagos.find((x) => /processed|approved|accredited/i.test(`${x?.status ?? ''} ${x?.status_detail ?? ''}`)) ?? pagos[0] ?? null;
    }
    const candidatos = [...new Set([c.paymentId, deOrden?.reference_id, deOrden?.id].map((x) => String(x ?? '').trim()).filter((x) => /^\d{1,20}$/.test(x)))];
    let clasico: any = null;
    for (const id of candidatos) {
      clasico = await mp.pago(id).catch(() => null);
      if (clasico) break;
    }
    const r = resumenPago(clasico, deOrden, c.monto);
    const info = { ...(r ?? { completo: false }), consultado: new Date().toISOString(), intentos: (previo?.intentos ?? 0) + 1 };
    await this.db.update(mpCobros).set({ pagoInfo: info, actualizadoEn: new Date() }).where(eq(mpCobros.id, c.id));
  }

  /** Los cobros pagados sin el detalle (los de antes de la 0131, o los que no se pudieron leer): de a 5. */
  private async rellenarInfoPagos() {
    const faltan = await this.db.select({ id: mpCobros.id }).from(mpCobros)
      .where(and(eq(mpCobros.estado, 'pagado'), sql`(${mpCobros.pagoInfo} is null or (coalesce((${mpCobros.pagoInfo}->>'completo')::boolean, false) = false and coalesce((${mpCobros.pagoInfo}->>'intentos')::int, 0) < 5 and ${mpCobros.actualizadoEn} < now() - interval '1 minute'))`))
      .orderBy(desc(mpCobros.id)).limit(5);
    for (const f of faltan) await this.completarInfoPago(f.id).catch((e) => this.log.warn(`detalle del cobro ${f.id}: ${(e as Error).message}`));
  }

  /* ------------------------------- el aviso ------------------------------- */

  async aviso(req: any) {
    const q = req.query ?? {};
    const b = req.body ?? {};
    const dataId = String(q['data.id'] ?? b?.data?.id ?? '');
    const tipo = String(q.type ?? b?.type ?? q.topic ?? '');
    if (MP.secreto && !firmaValida(req.headers['x-signature'], req.headers['x-request-id'], dataId || undefined)) {
      this.log.warn(`Aviso de Mercado Pago con firma inválida (tipo ${tipo}, id ${dataId}): ignorado.`);
      return { ok: false };
    }
    if (dataId && /order/i.test(tipo || 'order')) {
      // Se responde enseguida; el cierre (que puede esperar a ARCA) sigue aparte.
      void this.procesarOrden(dataId).catch((e) => this.log.warn(`aviso ${dataId}: ${(e as Error).message}`));
    }
    return { ok: true };
  }

  /* ------------------------------- el reloj ------------------------------- */

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.MP_RELOJ === '0') return;
    this.reloj = setInterval(() => { void this.revisarPendientes(); }, 20_000);
    this.reloj.unref();
  }

  onModuleDestroy() { if (this.reloj) clearInterval(this.reloj); }

  /** Los cobros que siguen esperando hace más de 20 s: se le pregunta a Mercado Pago. */
  async revisarPendientes() {
    if (!MP.configurado) return;
    try {
      const pendientes = await this.db.select().from(mpCobros)
        .where(and(eq(mpCobros.estado, 'esperando'), lt(mpCobros.actualizadoEn, sql`now() - interval '20 seconds'`)))
        .limit(20);
      for (const c of pendientes) {
        if (c.orderId) await this.procesarOrden(c.orderId).catch((e) => this.log.warn(`reloj cobro ${c.id}: ${(e as Error).message}`));
        else if (Date.now() - new Date(c.creadoEn).getTime() > 60_000) {
          await this.db.update(mpCobros).set({ estado: 'cancelado', detalle: 'El cobro no llegó a crearse en Mercado Pago.' })
            .where(and(eq(mpCobros.id, c.id), eq(mpCobros.estado, 'esperando')));
        }
      }
      await this.rellenarInfoPagos();
    } catch (e) {
      this.log.warn(`reloj: ${(e as Error).message}`);
    }
  }
}

@Controller('mercadopago')
export class MercadoPagoController {
  constructor(private readonly svc: MercadoPagoService) {}

  /** El aviso de Mercado Pago. Público: lo llama Mercado Pago; la firma y la consulta a la API son la seguridad. */
  @Publico()
  @Post('webhook')
  @HttpCode(200)
  webhook(@Req() req: any) { return this.svc.aviso(req); }

  @Get('estado') @Permiso('ventas.configuracion')
  estado() { return this.svc.estado(); }

  @Post('cajas') @Permiso('ventas.configuracion')
  crearCaja(@Body() dto: CrearCajaDto) { return this.svc.crearCaja(dto); }

  /** La caja de ESTE equipo (el POS la pide al abrir el cobro). */
  @Post('mi-caja') @Permiso('ventas')
  miCaja(@Body() body: { token?: string }) { return this.svc.miCaja(String(body?.token ?? '')); }

  @Post('cobros') @Permiso('ventas')
  crearCobro(@Body() dto: CrearCobroDto, @Auth() sesion: Sesion) { return this.svc.crearCobro(dto, sesion); }

  @Get('cobros/:id') @Permiso('ventas')
  verCobro(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) { return this.svc.verCobro(id, sesion); }

  @Get('cobros') @Permiso('ventas')
  cobroDeVenta(@Query('ventaId', ParseIntPipe) ventaId: number) { return this.svc.cobroDeVenta(ventaId); }

  @Post('cobros/:id/cancelar') @Permiso('ventas')
  cancelar(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) { return this.svc.cancelarCobro(id, sesion); }

  @Post('cobros/:id/resolver') @Permiso('ventas')
  resolver(@Param('id', ParseIntPipe) id: number, @Body() body: { motivo?: string }, @Auth() sesion: Sesion) {
    return this.svc.resolverAMano(id, String(body?.motivo ?? ''), sesion);
  }

  /** «El cliente ya pagó»: los pagos aprobados por el monto que pueden ser de este cobro. */
  @Get('cobros/:id/pagos') @Permiso('ventas')
  pagosCandidatos(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) { return this.svc.pagosCandidatos(id, sesion); }

  /** Vincula uno de esos pagos (se verifica de nuevo en Mercado Pago) y cierra la venta. */
  @Post('cobros/:id/vincular') @Permiso('ventas')
  vincular(@Param('id', ParseIntPipe) id: number, @Body() body: { paymentId?: string }, @Auth() sesion: Sesion) {
    return this.svc.vincularPago(id, String(body?.paymentId ?? ''), sesion);
  }

  @Post('cobros/:id/reintentar') @Permiso('ventas')
  reintentar(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) { return this.svc.reintentar(id, sesion); }
}

@Module({
  imports: [VentasModule],
  controllers: [MercadoPagoController],
  providers: [MercadoPagoService],
})
export class MercadoPagoModule {}

