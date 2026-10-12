/**
 * INGRESO A LA TIENDA MAYORISTA (0155, 10/10/2026)
 * ============================================================================
 * Pedido del dueño: el precio mayorista no se muestra a todo el público.
 *
 *   1. El visitante pide ingreso: nombre o comercio, DNI, WhatsApp, localidad y
 *      CUIT opcional. Queda `pendiente` (si ya era cliente con ese DNI, se
 *      engancha a su ficha).
 *   2. En el ERP (Tienda online › Accesos a la tienda online) alguien lo habilita —se crea su
 *      ficha si no la tenía— y le manda el WhatsApp con un toque; o lo rechaza
 *      y ese DNI queda bloqueado (no entra ni puede volver a pedir).
 *   3. Desde ahí entra SOLO CON SU DNI (decisión del dueño). Cada aparato
 *      recibe un token que se guarda en una cookie; acá solo vive su hash. Dura
 *      90 días sin uso y se renueva solo mientras se use.
 *
 * Sin sesión válida el catálogo sale sin precios y el pedido se rechaza.
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, lt, ne, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { clientes, presupuestos, tiendaAccesos, tiendaSesiones, usuarios } from '../db/schema';
import { telefonoArgentino } from '../common/telefono';
import { cuitValido } from '../arca/padron';
import { ClientesService } from '../clientes/clientes.module';

const DIA_MS = 86_400_000;
/** Sin volver a pedir nada en ese aparato, mientras se use (decisión del dueño). */
const DIAS_SESION = 90;
/** Se renueva cuando le quedan menos de esto: una escritura cada ~10 días de uso, no una por visita. */
const RENOVAR_DIAS = 80;

/** El DNI de la tienda: 7 u 8 números (puntos y espacios se toleran). '' si no lo es. */
export const dniDe = (v: unknown) => {
  const d = String(v ?? '').replace(/[\s.]/g, '');
  return /^\d{7,8}$/.test(d) ? d : '';
};
const texto = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const hashDe = (token: string) => createHash('sha256').update(token).digest('hex');

/** Lo que la tienda sabe de quien ingresó (lo usan el catálogo y el pedido). */
export type SesionTienda = {
  accesoId: number; dni: string; nombre: string; whatsapp: string; localidad: string; clienteId: number | null;
};

export type EstadoIngreso =
  | { estado: 'habilitado'; token: string; nombre: string }
  | { estado: 'pendiente' | 'bloqueado' | 'sin_registro' };

type Acceso = typeof tiendaAccesos.$inferSelect;

@Injectable()
export class AccesosTiendaService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly clientesSvc: ClientesService,
  ) {}

  /* ============================== la tienda ============================== */

  /** Pedir ingreso. Si el DNI ya lo pidió, contesta su estado (y si está habilitado, entra). */
  async registrar(dto: any): Promise<EstadoIngreso> {
    const dni = dniDe(dto?.dni);
    if (!dni) throw new BadRequestException('El DNI va con 7 u 8 números, sin puntos.');
    const nombre = texto(dto?.nombre, 120);
    if (nombre.length < 3) throw new BadRequestException('Escribí tu nombre y apellido, o el nombre de tu comercio.');
    const whatsapp = telefonoArgentino(dto?.whatsapp);
    if (!whatsapp) {
      throw new BadRequestException('El WhatsApp está incompleto: escribilo con el código de área, sin 0 ni 15 — 10 números en total (ej: 370 4123456).');
    }
    const localidad = texto(dto?.localidad, 80);
    if (!localidad) throw new BadRequestException('Escribí tu localidad.');
    const cuit = String(dto?.cuit ?? '').replace(/\D/g, '');
    if (cuit && !cuitValido(cuit)) throw new BadRequestException('El CUIT no es válido: son 11 números y el último es el verificador. Si no tenés, dejalo vacío.');

    const [cliente] = await this.db.select({ id: clientes.id }).from(clientes)
      .where(and(eq(clientes.tipoDoc, 'dni'), eq(clientes.numeroDoc, dni), eq(clientes.esConsumidorFinal, false)))
      .limit(1);
    /* `onConflictDoNothing`: dos pedidos juntos con el mismo DNI dejan UNA fila; el segundo lee la del primero. */
    await this.db.insert(tiendaAccesos)
      .values({ dni, nombre, whatsapp, localidad, cuit, clienteId: cliente?.id ?? null })
      .onConflictDoNothing({ target: tiendaAccesos.dni });
    const [a] = await this.db.select().from(tiendaAccesos).where(eq(tiendaAccesos.dni, dni)).limit(1);
    return this.respuesta(a);
  }

  /** Entrar con el DNI (decisión del dueño: solo el DNI). */
  async ingresar(dto: any): Promise<EstadoIngreso> {
    const dni = dniDe(dto?.dni);
    if (!dni) throw new BadRequestException('El DNI va con 7 u 8 números, sin puntos.');
    const [a] = await this.db.select().from(tiendaAccesos).where(eq(tiendaAccesos.dni, dni)).limit(1);
    return a ? this.respuesta(a) : { estado: 'sin_registro' };
  }

  /** Habilitado → token nuevo para este aparato. Los demás estados, sin datos de nadie. */
  private async respuesta(a: Acceso): Promise<EstadoIngreso> {
    if (a.estado !== 'habilitado') return { estado: a.estado };
    const token = randomBytes(32).toString('base64url');
    const ahora = new Date();
    await this.db.transaction(async (tx) => {
      // De paso se barren los aparatos vencidos de todos: la tabla no crece sin techo.
      await tx.delete(tiendaSesiones).where(lt(tiendaSesiones.expiraEn, ahora));
      await tx.insert(tiendaSesiones).values({
        tokenHash: hashDe(token), accesoId: a.id, expiraEn: new Date(ahora.getTime() + DIAS_SESION * DIA_MS),
      });
      await tx.update(tiendaAccesos).set({ ultimoIngreso: ahora }).where(eq(tiendaAccesos.id, a.id));
    });
    return { estado: 'habilitado', token, nombre: a.nombre };
  }

  /** La sesión de un token, o null (vencida, inexistente o el acceso ya no está habilitado). */
  async sesion(token: unknown): Promise<SesionTienda | null> {
    const t = String(token ?? '');
    if (t.length < 20 || t.length > 100) return null;
    const h = hashDe(t);
    const [r] = await this.db.select({
      expiraEn: tiendaSesiones.expiraEn, accesoId: tiendaAccesos.id, dni: tiendaAccesos.dni, nombre: tiendaAccesos.nombre,
      whatsapp: tiendaAccesos.whatsapp, localidad: tiendaAccesos.localidad, clienteId: tiendaAccesos.clienteId,
    }).from(tiendaSesiones)
      .innerJoin(tiendaAccesos, eq(tiendaAccesos.id, tiendaSesiones.accesoId))
      .where(and(eq(tiendaSesiones.tokenHash, h), eq(tiendaAccesos.estado, 'habilitado')))
      .limit(1);
    const ahora = Date.now();
    if (!r || r.expiraEn.getTime() <= ahora) return null;
    if (r.expiraEn.getTime() - ahora < RENOVAR_DIAS * DIA_MS) {
      await this.db.update(tiendaSesiones).set({ expiraEn: new Date(ahora + DIAS_SESION * DIA_MS) })
        .where(eq(tiendaSesiones.tokenHash, h));
    }
    const { expiraEn: _, ...s } = r;
    return s;
  }

  async salir(token: unknown) {
    const t = String(token ?? '');
    if (t) await this.db.delete(tiendaSesiones).where(eq(tiendaSesiones.tokenHash, hashDe(t)));
    return { ok: true };
  }

  /**
   * Lo que el checkout muestra ya completo: nombre, WhatsApp y dirección. La
   * dirección, de su ficha; si está vacía, la de su último pedido con envío.
   */
  async datosCheckout(s: SesionTienda) {
    const [cli] = s.clienteId
      ? await this.db.select({ direccion: clientes.direccion, localidad: clientes.localidad }).from(clientes)
        .where(eq(clientes.id, s.clienteId)).limit(1)
      : [];
    const [ultimo] = cli?.direccion ? [] : await this.db.select({ wc: presupuestos.webCliente }).from(presupuestos)
      .where(sql`${presupuestos.webCliente}->>'dni' = ${s.dni} and coalesce(${presupuestos.webCliente}->>'direccion', '') <> ''`)
      .orderBy(desc(presupuestos.id)).limit(1);
    const wc: any = ultimo?.wc ?? {};
    return {
      nombre: s.nombre, dni: s.dni, whatsapp: s.whatsapp,
      direccion: String(cli?.direccion || wc.direccion || '').slice(0, 120),
      localidad: String(cli?.localidad || wc.localidad || s.localidad).slice(0, 80),
    };
  }

  /* ============================== el ERP ============================== */

  async listar(estado?: string) {
    const filtro = ['pendiente', 'habilitado', 'bloqueado'].includes(String(estado)) ? estado as Acceso['estado'] : 'pendiente';
    return this.db.select({
      id: tiendaAccesos.id, dni: tiendaAccesos.dni, nombre: tiendaAccesos.nombre, whatsapp: tiendaAccesos.whatsapp,
      localidad: tiendaAccesos.localidad, cuit: tiendaAccesos.cuit, estado: tiendaAccesos.estado,
      creadoEn: tiendaAccesos.creadoEn, resueltoEn: tiendaAccesos.resueltoEn, ultimoIngreso: tiendaAccesos.ultimoIngreso,
      avisadoRecibidaEn: tiendaAccesos.avisadoRecibidaEn, avisadoHabilitadoEn: tiendaAccesos.avisadoHabilitadoEn,
      clienteId: tiendaAccesos.clienteId, clienteNombre: clientes.nombre, resueltoPor: usuarios.nombre,
    }).from(tiendaAccesos)
      .leftJoin(clientes, eq(clientes.id, tiendaAccesos.clienteId))
      .leftJoin(usuarios, eq(usuarios.id, tiendaAccesos.resueltoPor))
      .where(eq(tiendaAccesos.estado, filtro))
      // Pendientes: el más viejo primero (es el que más espera). Resueltos: lo último resuelto arriba.
      .orderBy(filtro === 'pendiente' ? tiendaAccesos.creadoEn : desc(sql`coalesce(${tiendaAccesos.resueltoEn}, ${tiendaAccesos.creadoEn})`))
      .limit(500);
  }

  async pendientes() {
    const [r] = await this.db.select({ n: sql<number>`count(*)::int` }).from(tiendaAccesos)
      .where(eq(tiendaAccesos.estado, 'pendiente'));
    return { pendientes: r?.n ?? 0 };
  }

  private async fila(id: number) {
    const [a] = await this.db.select().from(tiendaAccesos).where(eq(tiendaAccesos.id, id)).limit(1);
    if (!a) throw new NotFoundException('Esa solicitud ya no existe.');
    return a;
  }

  /**
   * HABILITAR: la ficha del cliente (la que ya tenía ese DNI o una nueva con lo
   * que escribió) y el estado, en una sola actualización condicional — dos
   * clics juntos no crean dos fichas ni dos «habilitado». La ficha existente
   * no se toca. Queda anotado que se le mandó el WhatsApp (la pantalla lo abre
   * en el mismo clic).
   */
  async habilitar(id: number, usuarioId: number) {
    const a = await this.fila(id);
    if (a.estado === 'habilitado') return a;
    const clienteId = a.clienteId ?? await this.clienteDe(a);
    const ahora = new Date();
    const [r] = await this.db.update(tiendaAccesos).set({
      estado: 'habilitado', clienteId, resueltoEn: ahora, resueltoPor: usuarioId, avisadoHabilitadoEn: ahora,
    }).where(and(eq(tiendaAccesos.id, id), ne(tiendaAccesos.estado, 'habilitado'))).returning();
    return r ?? this.fila(id);
  }

  /** La ficha con ese DNI, o una nueva (consumidor final, sin crédito) con lo que escribió en el pedido de ingreso. */
  private async clienteDe(a: Acceso) {
    const buscar = async () => (await this.db.select({ id: clientes.id }).from(clientes)
      .where(and(eq(clientes.tipoDoc, 'dni'), eq(clientes.numeroDoc, a.dni), eq(clientes.esConsumidorFinal, false))).limit(1))[0]?.id ?? null;
    const ya = await buscar();
    if (ya) return ya;
    try {
      const c = await this.clientesSvc.create({
        nombre: a.nombre, tipoDoc: 'dni', numeroDoc: a.dni, telefono: a.whatsapp, localidad: a.localidad,
        condicionIva: 'consumidor_final',
        observaciones: `Alta desde la tienda online (pedido de ingreso).${a.cuit ? ` CUIT para factura: ${a.cuit}.` : ''}`,
      } as any, false);
      return c.id as number;
    } catch (e) {
      const otro = await buscar(); // otro alta con ese DNI ganó la carrera
      if (otro) return otro;
      throw e;
    }
  }

  /** Rechazar o deshabilitar: el DNI queda bloqueado y se cierran sus sesiones abiertas. */
  async bloquear(id: number, usuarioId: number) {
    await this.fila(id);
    return this.db.transaction(async (tx) => {
      const [r] = await tx.update(tiendaAccesos)
        .set({ estado: 'bloqueado', resueltoEn: new Date(), resueltoPor: usuarioId })
        .where(eq(tiendaAccesos.id, id)).returning();
      await tx.delete(tiendaSesiones).where(eq(tiendaSesiones.accesoId, id));
      return r;
    });
  }

  /** Se le mandó el WhatsApp de «recibimos tu solicitud» (la pantalla lo abre en el mismo clic). */
  async avisadoRecibida(id: number) {
    await this.fila(id);
    const [r] = await this.db.update(tiendaAccesos).set({ avisadoRecibidaEn: new Date() })
      .where(eq(tiendaAccesos.id, id)).returning();
    return r;
  }
}
