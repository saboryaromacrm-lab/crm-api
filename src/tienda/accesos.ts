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
 *
 * LA MINORISTA TAMBIÉN (0178, 17/10/2026, decisión del dueño): el comprador
 * minorista ingresa con su WHATSAPP. Se registra con nombre, apellido y
 * dirección y entra en el momento (sin aprobación); el que ya había comprado
 * entra directo. Sus sesiones son las mismas de arriba, pero de un comprador:
 * una sesión minorista no abre la mayorista ni al revés. Como el número solo
 * abre la puerta, lo guardado de la dirección viaja A MEDIAS (`direccionOculta`).
 */
import { BadRequestException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { clientes, presupuestos, tiendaAccesos, tiendaCompradores, tiendaDirecciones, tiendaSesiones, usuarios } from '../db/schema';
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
/** El hash de un token con forma de token, o null (no se consulta la base por cualquier cosa). */
const hashValido = (token: unknown) => {
  const t = String(token ?? '');
  return t.length < 20 || t.length > 100 ? null : hashDe(t);
};
const MSG_WHATSAPP = 'El WhatsApp está incompleto: escribilo con el código de área, sin 0 ni 15 — 10 números en total (ej: 370 4123456).';

/**
 * La dirección A MEDIAS (0178, decisión del dueño): cualquiera que escriba un
 * WhatsApp ajeno entra como esa persona, así que lo guardado no se muestra
 * entero. Los primeros 10 caracteres y «…» (la mitad, si es más corta).
 */
export function direccionOculta(d: string): string {
  const t = String(d ?? '').trim();
  if (!t) return '';
  const ver = t.length > 10 ? 10 : Math.ceil(t.length / 2);
  return `${t.slice(0, ver).trimEnd()}…`;
}

/** Lo que la tienda sabe de quien ingresó (lo usan el catálogo y el pedido). */
export type SesionTienda = {
  accesoId: number; dni: string; nombre: string; whatsapp: string; localidad: string; clienteId: number | null;
};

export type EstadoIngreso =
  | { estado: 'habilitado'; token: string; nombre: string }
  | { estado: 'pendiente' | 'bloqueado' | 'sin_registro' };

type Acceso = typeof tiendaAccesos.$inferSelect;
/** El comprador minorista que ingresó (0178): lo usan el catálogo y el pedido. */
export type Comprador = typeof tiendaCompradores.$inferSelect;
/** Una de sus direcciones guardadas (0200). */
export type DireccionGuardada = typeof tiendaDirecciones.$inferSelect;
/** `completar`: ya compró pero le faltan datos (nombre, apellido o dirección): se los pide una vez. */
export type EstadoMinorista =
  | { estado: 'habilitado'; token: string; nombre: string }
  | { estado: 'sin_registro' | 'completar' | 'bloqueado' };

/** Cuántas direcciones guarda un comprador (0200): «Casa» y «Trabajo», por ejemplo. */
export const MAX_DIRECCIONES = 2;
/** El nombre de una dirección guardada: «casa» → «Casa», sin espacios de más, hasta 30 letras. */
export const nombreDireccion = (v: unknown) => { const t = texto(v, 30); return t && t.charAt(0).toLocaleUpperCase('es') + t.slice(1); };
const mismoNombre = (a: string, b: string) => a.toLocaleLowerCase('es') === b.toLocaleLowerCase('es');

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
    const token = await this.abrirSesion({ accesoId: a.id }, (tx, ahora) =>
      tx.update(tiendaAccesos).set({ ultimoIngreso: ahora }).where(eq(tiendaAccesos.id, a.id)));
    return { estado: 'habilitado', token, nombre: a.nombre };
  }

  /**
   * Un token nuevo para este aparato, de un acceso o de un comprador, y lo que
   * haya que anotar en la misma transacción (el último ingreso).
   */
  private async abrirSesion(quien: { accesoId: number } | { compradorId: number }, anotar: (tx: any, ahora: Date) => Promise<unknown>) {
    const token = randomBytes(32).toString('base64url');
    const ahora = new Date();
    await this.db.transaction(async (tx) => {
      // De paso se barren los aparatos vencidos de todos: la tabla no crece sin techo.
      await tx.delete(tiendaSesiones).where(lt(tiendaSesiones.expiraEn, ahora));
      await tx.insert(tiendaSesiones).values({ tokenHash: hashDe(token), ...quien, expiraEn: new Date(ahora.getTime() + DIAS_SESION * DIA_MS) });
      await anotar(tx, ahora);
    });
    return token;
  }

  /** ¿Sigue vigente? Y si le queda poco, se renueva (una escritura cada ~10 días de uso). */
  private async vigente(h: string, expiraEn: Date) {
    const ahora = Date.now();
    if (expiraEn.getTime() <= ahora) return false;
    if (expiraEn.getTime() - ahora < RENOVAR_DIAS * DIA_MS) {
      await this.db.update(tiendaSesiones).set({ expiraEn: new Date(ahora + DIAS_SESION * DIA_MS) })
        .where(eq(tiendaSesiones.tokenHash, h));
    }
    return true;
  }

  /** La sesión de un token, o null (vencida, inexistente o el acceso ya no está habilitado). */
  async sesion(token: unknown): Promise<SesionTienda | null> {
    const h = hashValido(token);
    if (!h) return null;
    const [r] = await this.db.select({
      expiraEn: tiendaSesiones.expiraEn, accesoId: tiendaAccesos.id, dni: tiendaAccesos.dni, nombre: tiendaAccesos.nombre,
      whatsapp: tiendaAccesos.whatsapp, localidad: tiendaAccesos.localidad, clienteId: tiendaAccesos.clienteId,
    }).from(tiendaSesiones)
      .innerJoin(tiendaAccesos, eq(tiendaAccesos.id, tiendaSesiones.accesoId))
      .where(and(eq(tiendaSesiones.tokenHash, h), eq(tiendaAccesos.estado, 'habilitado')))
      .limit(1);
    if (!r || !(await this.vigente(h, r.expiraEn))) return null;
    const { expiraEn: _, ...s } = r;
    return s;
  }

  /* ========================= la tienda minorista (0178) ========================= */

  /** Entrar con el WhatsApp. */
  async ingresarMinorista(dto: any): Promise<EstadoMinorista> {
    const telefono = telefonoArgentino(dto?.telefono);
    if (!telefono) throw new BadRequestException(MSG_WHATSAPP);
    const [c] = await this.db.select().from(tiendaCompradores).where(eq(tiendaCompradores.telefono, telefono)).limit(1);
    return c ? this.respuestaMinorista(c) : { estado: 'sin_registro' };
  }

  /**
   * Registrarse (o completar lo que le falta al que ya compró) y entrar. Lo ya
   * guardado NO se pisa: con un WhatsApp ajeno no se le cambia el nombre ni la
   * dirección a nadie; solo se completa lo vacío.
   */
  async registrarMinorista(dto: any): Promise<EstadoMinorista> {
    const telefono = telefonoArgentino(dto?.telefono);
    if (!telefono) throw new BadRequestException(MSG_WHATSAPP);
    const nombre = texto(dto?.nombre, 60);
    const apellido = texto(dto?.apellido, 60);
    if (nombre.length < 2 || apellido.length < 2) throw new BadRequestException('Escribí tu nombre y tu apellido.');
    const direccion = texto(dto?.direccion, 120);
    if (direccion.length < 5) throw new BadRequestException('Escribí tu dirección: calle, número y barrio.');
    /* `onConflictDoNothing`: dos registros juntos con el mismo número dejan UNA fila. */
    await this.db.insert(tiendaCompradores).values({ telefono, nombre, apellido })
      .onConflictDoNothing({ target: tiendaCompradores.telefono });
    let [c] = await this.db.select().from(tiendaCompradores).where(eq(tiendaCompradores.telefono, telefono)).limit(1);
    /* La del registro es su primera dirección guardada, «Casa» (0200); si ya tiene, no se toca. */
    if (!(await this.direcciones(c.id)).length) {
      await this.db.insert(tiendaDirecciones).values({ compradorId: c.id, nombre: 'Casa', direccion }).onConflictDoNothing();
    }
    const faltan = { ...(c.nombre ? {} : { nombre }), ...(c.apellido ? {} : { apellido }) };
    if (Object.keys(faltan).length) {
      [c] = await this.db.update(tiendaCompradores).set({ ...faltan, actualizadoEn: new Date() })
        .where(eq(tiendaCompradores.id, c.id)).returning();
    }
    return this.respuestaMinorista(c);
  }

  private async respuestaMinorista(c: Comprador): Promise<EstadoMinorista> {
    if (c.bloqueado) return { estado: 'bloqueado' };
    if (!c.nombre || !c.apellido || !(await this.direcciones(c.id)).length) return { estado: 'completar' };
    const token = await this.abrirSesion({ compradorId: c.id }, (tx, ahora) =>
      tx.update(tiendaCompradores).set({ ultimoIngreso: ahora }).where(eq(tiendaCompradores.id, c.id)));
    return { estado: 'habilitado', token, nombre: c.nombre };
  }

  /** El comprador de un token minorista, o null (vencido, inexistente, bloqueado, o el token es de un mayorista). */
  async sesionMinorista(token: unknown): Promise<Comprador | null> {
    const h = hashValido(token);
    if (!h) return null;
    const [r] = await this.db.select({ expiraEn: tiendaSesiones.expiraEn, c: tiendaCompradores }).from(tiendaSesiones)
      .innerJoin(tiendaCompradores, eq(tiendaCompradores.id, tiendaSesiones.compradorId))
      .where(and(eq(tiendaSesiones.tokenHash, h), eq(tiendaCompradores.bloqueado, false)))
      .limit(1);
    return r && (await this.vigente(h, r.expiraEn)) ? r.c : null;
  }

  /** Lo que ve la tienda de quien ingresó: el nombre, la inicial del apellido, su WhatsApp y sus direcciones a medias. */
  async datosMinorista(c: Comprador) {
    return {
      nombre: c.nombre, inicial: c.apellido.charAt(0).toUpperCase(), telefono: c.telefono,
      direcciones: await this.direccionesVisibles(c.id), maxDirecciones: MAX_DIRECCIONES,
    };
  }

  /* ========================= sus direcciones guardadas (0200) ========================= */

  /** Sus direcciones, en el orden en que las guardó. */
  direcciones(compradorId: number, db: Database = this.db) {
    return db.select().from(tiendaDirecciones).where(eq(tiendaDirecciones.compradorId, compradorId)).orderBy(asc(tiendaDirecciones.id));
  }

  /** Lo que el navegador ve de ellas: el nombre y la dirección a medias. */
  private async direccionesVisibles(compradorId: number) {
    return (await this.direcciones(compradorId)).map((d) => ({ id: d.id, nombre: d.nombre, direccion: direccionOculta(d.direccion) }));
  }

  /**
   * La guardada que eligió en el checkout (`{ guardada: id }`), o null si
   * escribió otra. `true` es la primera: lo que mandaba el checkout de antes.
   */
  async direccionElegida(compradorId: number, cruda: any): Promise<DireccionGuardada | null> {
    const id = cruda?.guardada;
    if (id == null || id === false) return null;
    const ds = await this.direcciones(compradorId);
    const d = id === true ? ds[0] : ds.find((x) => x.id === Number(id));
    if (!d) throw new BadRequestException('Esa dirección ya no está guardada: elegí otra o escribila.');
    return d;
  }

  /**
   * Guarda en su perfil la dirección de un envío, con el nombre que eligió.
   * Si ya tiene una con ese nombre, la reemplaza; si no, entra mientras no
   * pase el tope (con el tope lleno hay que reemplazar una).
   */
  async guardarDireccion(
    tx: Database, compradorId: number, nombre: string,
    datos: Pick<DireccionGuardada, 'direccion' | 'localidad' | 'referencia' | 'lat' | 'lng'>,
  ) {
    const ds = await this.direcciones(compradorId, tx);
    const misma = ds.find((d) => mismoNombre(d.nombre, nombre));
    if (misma) {
      await tx.update(tiendaDirecciones).set({ ...datos, nombre, actualizadoEn: new Date() }).where(eq(tiendaDirecciones.id, misma.id));
      return;
    }
    if (ds.length >= MAX_DIRECCIONES) {
      throw new BadRequestException(`Ya tenés ${MAX_DIRECCIONES} direcciones guardadas (${ds.map((d) => d.nombre).join(' y ')}): para guardar esta, reemplazá una.`);
    }
    await tx.insert(tiendaDirecciones).values({ compradorId, nombre, ...datos });
  }

  /** Una guardada de antes del mapa se queda con el punto que marcó ahora. */
  async marcarPunto(tx: Database, id: number, punto: { lat: number | null; lng: number | null }) {
    await tx.update(tiendaDirecciones).set({ ...punto, actualizadoEn: new Date() }).where(eq(tiendaDirecciones.id, id));
  }

  /** Borrar una de sus direcciones guardadas: devuelve las que le quedan. */
  async borrarDireccion(token: unknown, id: number) {
    const c = await this.sesionMinorista(token);
    if (!c) throw new UnauthorizedException('Para comprar, ingresá con tu WhatsApp.');
    await this.db.delete(tiendaDirecciones).where(and(eq(tiendaDirecciones.id, id), eq(tiendaDirecciones.compradorId, c.id)));
    return { direcciones: await this.direccionesVisibles(c.id) };
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

  /** Los compradores minoristas (0178), los últimos en entrar primero; `q` busca por nombre, apellido o WhatsApp. */
  async minoristas(q?: string) {
    const t = texto(q, 60);
    const digitos = t.replace(/\D/g, '');
    const filtro = t ? sql`(${tiendaCompradores.nombre} || ' ' || ${tiendaCompradores.apellido}) ilike ${`%${t}%`}${
      digitos ? sql` or ${tiendaCompradores.telefono} like ${`%${digitos}%`}` : sql``}` : undefined;
    const filas = await this.db.select({
      id: tiendaCompradores.id, telefono: tiendaCompradores.telefono, nombre: tiendaCompradores.nombre,
      apellido: tiendaCompradores.apellido, pedidos: tiendaCompradores.pedidos, bloqueado: tiendaCompradores.bloqueado,
      ultimoIngreso: tiendaCompradores.ultimoIngreso, creadoEn: tiendaCompradores.creadoEn,
    }).from(tiendaCompradores).where(filtro)
      .orderBy(desc(sql`coalesce(${tiendaCompradores.ultimoIngreso}, ${tiendaCompradores.creadoEn})`))
      .limit(500);
    /* Sus direcciones guardadas (0200), enteras: el ERP es del dueño. */
    const ds = filas.length
      ? await this.db.select({ compradorId: tiendaDirecciones.compradorId, nombre: tiendaDirecciones.nombre, direccion: tiendaDirecciones.direccion, localidad: tiendaDirecciones.localidad })
        .from(tiendaDirecciones).where(inArray(tiendaDirecciones.compradorId, filas.map((f) => f.id))).orderBy(asc(tiendaDirecciones.id))
      : [];
    return filas.map((f) => ({ ...f, direcciones: ds.filter((d) => d.compradorId === f.id).map(({ compradorId, ...d }) => d) }));
  }

  /** Bloquear (se le cierran las sesiones abiertas) o desbloquear a un comprador minorista. */
  async bloquearMinorista(id: number, bloqueado: boolean) {
    return this.db.transaction(async (tx) => {
      const [r] = await tx.update(tiendaCompradores).set({ bloqueado, actualizadoEn: new Date() })
        .where(eq(tiendaCompradores.id, id)).returning();
      if (!r) throw new NotFoundException('Ese comprador ya no existe.');
      if (bloqueado) await tx.delete(tiendaSesiones).where(eq(tiendaSesiones.compradorId, id));
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
