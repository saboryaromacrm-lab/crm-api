/**
 * EL BOT DE VENTAS POR WHATSAPP (0237, 19/11/2026, pedido del dueño)
 * ============================================================================
 * Contesta el WhatsApp de ventas con la IA (`cerebro.ts`), con el precio, la
 * oferta y el stock de la tienda en el momento. Corre DENTRO de la API pero no
 * la frena: el aviso de Meta se contesta al instante y la respuesta se arma
 * después; mientras espera a la IA, Node atiende todo lo demás.
 *
 *   · Los mensajes seguidos («hola» «tienen almendras?» «y nueces?») se JUNTAN:
 *     se espera unos segundos de silencio y se contesta todo en un mensaje
 *     (Meta cobra por mensaje, y la gente escribe en ráfagas).
 *   · Una charla a la vez por número: lo que llega mientras contesta, va después.
 *   · NÚMEROS SIN IA (el personal, proveedores): ni se guardan ni se contestan.
 *   · Cuando alguien del local contesta desde la app del celular (coexistencia),
 *     o la IA deriva, la IA se calla en esa charla unas horas.
 *   · Tope de gasto de IA por mes y de respuestas por hora en una charla:
 *     pasado, deriva a una persona.
 *   · El CHAT DE PRUEBA del ERP usa el mismo camino, sin Meta.
 */
import {
  Body, Controller, ForbiddenException, Get, HttpCode, Inject, Injectable, Logger, Module, NotFoundException,
  OnModuleDestroy, Param, ParseIntPipe, Post, Put, Query, Req,
} from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import { and, asc, desc, eq, gt, gte, sql } from 'drizzle-orm';
import { Auth, Permiso, Publico, type Sesion } from '../auth/auth.decoradores';
import { DRIZZLE, type Database } from '../db/drizzle';
import { configuracion, stock, sucursales, tiendaAccesos, waChats, waMensajes, waTurnos } from '../db/schema';
import { ConfiguracionModule, ConfiguracionService } from '../configuracion/configuracion.module';
import { TiendaModule, TiendaService } from '../tienda/tienda.module';
import { dniDe } from '../tienda/accesos';
import { DIAS_SEMANA } from '../common/horario';
import { IA } from '../facturas/ia/anthropic';
import { armarSistema, responder } from './cerebro';
import { META, enviarTexto, leidoYEscribiendo } from './meta';
import {
  aWhatsapp, buscarEn, firmaMetaValida, leerAviso, numeroDe, partir, sanitizarConfig, sesionVencida, slug, HORAS_SESION,
  type ConfigBot, type Eco, type Entrante,
} from './reglas';

/** Donde vive la configuración del bot (en la tabla `configuracion`, con su propia puerta: tiene teléfonos). */
const CLAVE_CONFIG = 'whatsapp_bot';
/** Silencio que se espera antes de contestar, para juntar la ráfaga. */
const ESPERA_MS = 4_000;
const MAX_RESPUESTAS_HORA = 30;
/** DNI mal puestos por charla antes de dejar de verificar (no se adivinan DNI de mayoristas). */
const MAX_DNI_FALLIDOS = 3;
const PERMISO = 'web.whatsapp';
const AVISO_DERIVADO = 'Ya le aviso a una persona del local para que te responda por acá. ¡Gracias por la paciencia!';

const pesos = (n: number) => `$${new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(Number(n) || 0)}`;
const NOMBRE_DIA: Record<string, string> = { lun: 'lunes', mar: 'martes', mie: 'miércoles', jue: 'jueves', vie: 'viernes', sab: 'sábado', dom: 'domingo' };

type Chat = typeof waChats.$inferSelect;
type Contexto = { chat: Chat; modo: 'minorista' | 'mayorista'; cfg: ConfigBot; derivar: string | null };

@Injectable()
export class WhatsappService implements OnModuleDestroy {
  private readonly log = new Logger('WhatsApp');
  private readonly esperas = new Map<number, NodeJS.Timeout>();
  private readonly cola = new Map<number, Promise<unknown>>();
  private readonly dniFallidos = new Map<number, number>();

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly tienda: TiendaService,
    private readonly cfgSistema: ConfiguracionService,
  ) {}

  onModuleDestroy() { for (const t of this.esperas.values()) clearTimeout(t); }

  /* ============================== la configuración ============================== */

  async config(): Promise<ConfigBot> {
    const [f] = await this.db.select({ valor: configuracion.valor }).from(configuracion).where(eq(configuracion.clave, CLAVE_CONFIG)).limit(1);
    return sanitizarConfig(f?.valor);
  }

  async guardarConfig(patch: any) {
    const valor = sanitizarConfig({ ...(await this.config()), ...(patch && typeof patch === 'object' ? patch : {}) });
    await this.db.insert(configuracion).values({ clave: CLAVE_CONFIG, valor })
      .onConflictDoUpdate({ target: configuracion.clave, set: { valor, updatedAt: new Date() } });
    return valor;
  }

  /** Lo que gastó la IA del bot este mes (dólares), pruebas incluidas. */
  private async gastoMes(): Promise<number> {
    const [r] = await this.db.select({ t: sql<number>`coalesce(sum(${waTurnos.costo}), 0)::float8` }).from(waTurnos)
      .where(gte(waTurnos.creadoEn, sql`date_trunc('month', now() at time zone 'America/Argentina/Buenos_Aires') at time zone 'America/Argentina/Buenos_Aires'`));
    return Math.round((Number(r?.t) || 0) * 100) / 100;
  }

  async estado() {
    const [cfg, gasto] = await Promise.all([this.config(), this.gastoMes()]);
    return { meta: META.configurado, ia: IA.configurado, activo: cfg.activo, gastoMes: gasto, tope: cfg.topeGastoMesUsd };
  }

  /* ============================== el aviso de Meta ============================== */

  /** La suscripción del webhook: Meta pide el desafío con el token de verificación. */
  verificar(q: any): string {
    if (META.verificacion && q?.['hub.mode'] === 'subscribe' && q?.['hub.verify_token'] === META.verificacion) return String(q['hub.challenge'] ?? '');
    throw new ForbiddenException('Token de verificación incorrecto.');
  }

  /** Se contesta enseguida; lo demás sigue aparte. Sin firma válida, el aviso no existe. */
  aviso(req: any) {
    if (!META.configurado || !firmaMetaValida(req.rawBody, req.headers['x-hub-signature-256'], META.secreto)) {
      this.log.warn('Aviso de WhatsApp sin firma válida (o sin configurar): ignorado.');
      return { ok: false };
    }
    const { entrantes, ecos } = leerAviso(req.body);
    void (async () => {
      const cfg = await this.config();
      for (const e of entrantes) await this.registrarEntrante(e, cfg);
      for (const e of ecos) await this.registrarEco(e, cfg);
    })().catch((e) => this.log.error(`aviso: ${(e as Error).message}`));
    return { ok: true };
  }

  private sinIa(cfg: ConfigBot, telefono: string) {
    return !!telefono && cfg.numerosSinIa.some((n) => n.numero === telefono);
  }

  private async chatDe(waId: string, nombre: string, prueba: boolean): Promise<Chat> {
    const [c] = await this.db.insert(waChats)
      .values({ waId, telefono: prueba ? '' : numeroDe(waId), nombre, prueba })
      .onConflictDoUpdate({ target: [waChats.waId, waChats.prueba], set: { ...(nombre ? { nombre } : {}), ultimoMensajeEn: new Date() } })
      .returning();
    return c;
  }

  private async registrarEntrante(e: Entrante, cfg: ConfigBot) {
    if (this.sinIa(cfg, numeroDe(e.waId))) return;
    const chat = await this.chatDe(e.waId, e.nombre, false);
    const [m] = await this.db.insert(waMensajes).values({ chatId: chat.id, rol: 'cliente', texto: e.texto, metaId: e.metaId })
      .onConflictDoNothing().returning({ id: waMensajes.id });
    if (m) this.programar(chat.id);
  }

  /** Alguien del local contestó desde el celular: queda en la charla y la IA se calla. */
  private async registrarEco(e: Eco, cfg: ConfigBot) {
    if (this.sinIa(cfg, numeroDe(e.waId))) return;
    const chat = await this.chatDe(e.waId, '', false);
    const [m] = await this.db.insert(waMensajes).values({ chatId: chat.id, rol: 'humano', texto: e.texto, metaId: e.metaId })
      .onConflictDoNothing().returning({ id: waMensajes.id });
    if (m) await this.pausar(chat.id, cfg.horasPausaHumano);
  }

  private programar(chatId: number) {
    clearTimeout(this.esperas.get(chatId));
    this.esperas.set(chatId, setTimeout(() => {
      this.esperas.delete(chatId);
      void this.enCola(chatId, () => this.atender(chatId)).catch((e) => this.log.error(`charla ${chatId}: ${(e as Error).message}`));
    }, ESPERA_MS));
  }

  /** Una cosa a la vez por charla. */
  private enCola<T>(chatId: number, f: () => Promise<T>): Promise<T> {
    const antes = this.cola.get(chatId) ?? Promise.resolve();
    const ahora = antes.catch(() => undefined).then(f);
    this.cola.set(chatId, ahora);
    void ahora.finally(() => { if (this.cola.get(chatId) === ahora) this.cola.delete(chatId); }).catch(() => undefined);
    return ahora;
  }

  private async pausar(chatId: number, horas: number, motivo?: string) {
    await this.db.update(waChats).set({
      iaPausadaHasta: new Date(Date.now() + horas * 3_600_000),
      ...(motivo ? { derivadoEn: new Date(), derivadoMotivo: motivo.slice(0, 300) } : {}),
    }).where(eq(waChats.id, chatId));
  }

  /* ============================== la respuesta ============================== */

  /**
   * Contesta lo pendiente de una charla (todo lo que el cliente mandó desde la
   * última respuesta, y lo que haya escrito alguien del local en el medio).
   */
  private async atender(chatId: number): Promise<void> {
    const cfg = await this.config();
    const [chat] = await this.db.select().from(waChats).where(eq(waChats.id, chatId)).limit(1);
    if (!chat) return;
    /* Lo de hace más de una sesión (el bot apagado, una pausa larga) ya no se contesta: queda leído. */
    const desde = new Date(Date.now() - HORAS_SESION * 3_600_000);
    const todos = await this.db.select().from(waMensajes)
      .where(and(eq(waMensajes.chatId, chatId), gt(waMensajes.id, chat.ultimoIncluido))).orderBy(asc(waMensajes.id));
    const pendientes = todos.filter((m) => m.creadoEn >= desde);
    const delCliente = pendientes.filter((m) => m.rol === 'cliente');
    if (!delCliente.length) {
      if (todos.length) await this.cerrarPendientes(chat, todos);
      return;
    }
    if (!chat.prueba) {
      if (!cfg.activo || !META.configurado) return this.cerrarPendientes(chat, todos);
      if (chat.iaPausadaHasta && chat.iaPausadaHasta > new Date()) return;
    }
    const enviar = (texto: string) => this.enviar(chat, texto);

    if (await this.gastoMes() >= cfg.topeGastoMesUsd) {
      await this.cerrarPendientes(chat, pendientes);
      await this.pausar(chatId, cfg.horasPausaHumano, 'Se llegó al tope de gasto de IA del mes');
      await enviar(AVISO_DERIVADO);
      return;
    }
    const [{ n }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(waMensajes)
      .where(and(eq(waMensajes.chatId, chatId), eq(waMensajes.rol, 'bot'), gte(waMensajes.creadoEn, sql`now() - interval '1 hour'`)));
    if (!chat.prueba && n >= MAX_RESPUESTAS_HORA) {
      await this.cerrarPendientes(chat, pendientes);
      await this.pausar(chatId, cfg.horasPausaHumano, 'Demasiados mensajes en una hora');
      return;
    }

    if (!chat.prueba) void leidoYEscribiendo(delCliente[delCliente.length - 1].metaId ?? '');
    const historial = await this.historial(chat);
    const ctx: Contexto = { chat, modo: chat.accesoId ? 'mayorista' : 'minorista', cfg, derivar: null };
    let texto = '';
    try {
      const r = await responder({
        modelo: cfg.modelo,
        sistema: armarSistema({ empresa: await this.empresa(), instrucciones: cfg.instrucciones, negocio: await this.negocio(cfg) }),
        historial,
        mensaje: this.mensajeNuevo(chat, ctx.modo, pendientes),
        ejecutar: (nombre, input) => this.herramienta(nombre, input, ctx),
      });
      await this.db.transaction(async (tx) => {
        await tx.insert(waTurnos).values(r.turnos.map((t) => ({ chatId, rol: t.rol, contenido: t.contenido as any, modelo: t.modelo, costo: t.costo })));
        await tx.update(waChats).set({ ultimoIncluido: pendientes[pendientes.length - 1].id }).where(eq(waChats.id, chatId));
      });
      texto = aWhatsapp(r.texto);
    } catch (e) {
      this.log.error(`la IA no respondió (charla ${chatId}): ${(e as Error).message}`);
      await this.cerrarPendientes(chat, pendientes);
      ctx.derivar = 'La IA no pudo responder (error técnico)';
    }
    if (!texto && !ctx.derivar) ctx.derivar = 'La IA no supo qué responder';
    await enviar(texto || AVISO_DERIVADO);
    if (ctx.derivar) await this.pausar(chatId, cfg.horasPausaHumano, ctx.derivar);
  }

  /** Lo pendiente queda como leído sin pasar por la IA (cuando no se le pregunta). */
  private async cerrarPendientes(chat: Chat, pendientes: { id: number }[]) {
    await this.db.update(waChats).set({ ultimoIncluido: pendientes[pendientes.length - 1].id }).where(eq(waChats.id, chat.id));
  }

  private async enviar(chat: Chat, texto: string) {
    for (const parte of partir(texto)) {
      if (chat.prueba) {
        await this.db.insert(waMensajes).values({ chatId: chat.id, rol: 'bot', texto: parte });
        continue;
      }
      try {
        const metaId = await enviarTexto(chat.waId, parte);
        await this.db.insert(waMensajes).values({ chatId: chat.id, rol: 'bot', texto: parte, metaId: metaId || null });
      } catch (e) {
        this.log.error(`no se pudo mandar (charla ${chat.id}): ${(e as Error).message}`);
        await this.db.insert(waMensajes).values({ chatId: chat.id, rol: 'bot', texto: parte, error: (e as Error).message.slice(0, 300) });
      }
    }
  }

  /**
   * Los turnos de ESTA conversación, tal cual. Arranca de nuevo si pasaron
   * horas sin hablar, o si la última quedó a medias (un corte en el medio).
   */
  private async historial(chat: Chat): Promise<Anthropic.Beta.BetaMessageParam[]> {
    const turnos = await this.db.select().from(waTurnos)
      .where(and(eq(waTurnos.chatId, chat.id), gte(waTurnos.creadoEn, chat.sesionDesde))).orderBy(asc(waTurnos.id));
    const ultimo = turnos[turnos.length - 1];
    if (!turnos.length || sesionVencida(ultimo.creadoEn, new Date()) || ultimo.rol !== 'assistant') {
      if (turnos.length) await this.db.update(waChats).set({ sesionDesde: new Date() }).where(eq(waChats.id, chat.id));
      return [];
    }
    return turnos.map((t) => ({ role: t.rol, content: t.contenido as any }));
  }

  /** El mensaje para la IA: cuándo, quién es el cliente y lo que se dijo desde la última respuesta. */
  private mensajeNuevo(chat: Chat, modo: string, pendientes: (typeof waMensajes.$inferSelect)[]) {
    const ahora = new Intl.DateTimeFormat('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires', weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(new Date());
    const quien = modo === 'mayorista' ? 'cliente mayorista verificado' : 'cliente minorista (no verificado como mayorista)';
    const lineas = pendientes.map((m) => (m.rol === 'humano'
      ? `(Una persona del local le respondió: «${m.texto}»)`
      : m.rol === 'bot' ? `(Se le mandó: «${m.texto}»)` : m.texto));
    return `[${ahora} · ${quien}${chat.nombre ? ` · nombre en WhatsApp: ${chat.nombre}` : ''}]\n${lineas.join('\n')}`;
  }

  private async empresa(): Promise<string> {
    return String((await this.cfgSistema.get('empresa')).nombre || 'Sabor y Aroma');
  }

  /** Lo que el bot sabe del negocio, del mismo lugar que el sitio: si cambia en el ERP, lo sabe al instante. */
  private async negocio(cfg: ConfigBot): Promise<string> {
    const [min, may] = await Promise.all([this.tienda.catalogoDelModo('minorista'), this.tienda.catalogoDelModo('mayorista')]);
    const s = min.sitio;
    const locales = (s.locales ?? []).map((l: any) => {
      const horario = DIAS_SEMANA.map((d) => `${NOMBRE_DIA[d]} ${l[d] || 'cerrado'}`).join(', ');
      return `- ${l.nombre}${l.direccion ? `: ${l.direccion}` : ''}${l.localidad ? `, ${l.localidad}` : ''}${l.telefono ? ` (tel. ${l.telefono})` : ''}. Horario: ${horario}.`;
    });
    const c = s.contacto ?? {};
    const faq = (s.nosotros?.faq ?? []).map((f: any) => `- ${f.pregunta} ${f.respuesta}`);
    return [
      `Tienda online (minorista y mayorista; arriba se elige cómo comprar): ${cfg.linkTienda}`,
      locales.length ? `Locales:\n${locales.join('\n')}` : '',
      [c.telefono && `Teléfono: ${c.telefono}`, c.email && `Email: ${c.email}`, c.instagram && `Instagram: ${c.instagram}`, c.facebook && `Facebook: ${c.facebook}`]
        .filter(Boolean).join(' · '),
      s.nosotros?.texto ? `Quiénes somos:\n${s.nosotros.texto}` : '',
      faq.length ? `Preguntas frecuentes:\n${faq.join('\n')}` : '',
      `Compra minorista: sin mínimo; retiro en el local o envío a domicilio${min.envioGratisDesde > 0 ? ` (gratis desde ${pesos(min.envioGratisDesde)})` : ''}.`
        + `${(s.minorista?.avisos ?? []).length ? ` Hoy: ${s.minorista.avisos.join(' · ')}.` : ''}`,
      `Compra mayorista: ${may.montoMinimo > 0 ? `compra mínima ${pesos(may.montoMinimo)} por pedido` : 'sin compra mínima por monto'}`
        + `${(may.reglasMarca ?? []).length ? `${may.montoMinimo > 0 ? ', o' : ';'} que cada marca que lleva cumpla su mínimo de unidades (el producto trae el de su marca en «minimoDeLaMarca»)` : ''}`
        + `${may.envioCamionetaActivo && may.montoMinimoCamioneta > 0 ? `; envío sin cargo desde ${pesos(may.montoMinimoCamioneta)}` : ''}`
        + '. Para ver precios mayoristas hay que estar registrado y habilitado en la tienda mayorista.',
    ].filter(Boolean).join('\n\n');
  }

  /* ============================== las herramientas ============================== */

  private async herramienta(nombre: string, input: any, ctx: Contexto): Promise<unknown> {
    switch (nombre) {
      case 'buscar_productos': {
        const cat = await this.tienda.catalogoDelModo(ctx.modo);
        const hallados = buscarEn<any>(cat.items, String(input?.texto ?? ''), 8);
        return hallados.length ? hallados.map((it) => this.resumen(it, cat, ctx)) : { resultado: 'No hay productos con esas palabras en la tienda. Probá con otra palabra o un sinónimo.' };
      }
      case 'ver_ofertas': {
        const cat = await this.tienda.catalogoDelModo(ctx.modo);
        const conOferta = cat.items.filter((it: any) => it.enStock && (it.oferta || it.variantes?.some((v: any) => v.oferta)));
        const texto = String(input?.texto ?? '').trim();
        const lista = texto ? buscarEn<any>(conOferta, texto, 15) : conOferta.slice(0, 15);
        return lista.length ? lista.map((it: any) => this.resumen(it, cat, ctx)) : { resultado: 'Hoy no hay ofertas vigentes de eso.' };
      }
      case 'disponibilidad_en_locales': return this.enLocales(Math.trunc(Number(input?.producto_id)) || 0);
      case 'verificar_mayorista': return this.verificarMayorista(String(input?.dni ?? ''), ctx);
      case 'derivar_a_persona':
        ctx.derivar = String(input?.motivo ?? '').trim() || 'El bot lo derivó';
        return { ok: true, aviso: 'Listo: una persona del local sigue la charla. Avisale al cliente que le responden por acá.' };
      default: throw new Error(`No existe la herramienta «${nombre}».`);
    }
  }

  /** Un producto del catálogo, en lo justo para vender: precio, opciones, oferta, si hay y el link. */
  private resumen(it: any, cat: any, ctx: Contexto) {
    const oferta = (o: any) => (o ? {
      cartel: o.badge, ...(o.precioOferta != null ? { precioOferta: o.precioOferta } : {}),
      ...(o.porVencer ? { porVencimiento: true, venceEl: o.venceEl } : {}),
    } : undefined);
    const minimo = (n: number) => (ctx.modo === 'mayorista' && n > 0 ? { compraMinima: n } : {});
    const granel = it.tipo === 'granel';
    const deLaMarca = ctx.modo === 'mayorista' ? (cat.reglasMarca ?? []).find((r: any) => r.marcaId === it.marcaId)?.unidadesMinimas : undefined;
    return {
      id: it.id, nombre: it.nombre, marca: it.marca || undefined, categoria: it.categoria || undefined,
      link: `${ctx.cfg.linkTienda}/producto/${slug(it.nombre) || 'producto'}-${it.id}`,
      hay: !!it.enStock,
      ...(deLaMarca ? { minimoDeLaMarca: deLaMarca } : {}),
      ...(it.variantes?.length
        ? {
          opciones: it.variantes.slice(0, 8).map((v: any) => ({
            opcion: v.etiqueta, precio: v.precio,
            ...(granel ? { precioPorKg: v.precioKg } : (v.paquetesPorUnidad ?? 1) > 1 ? { precioPorUnidad: v.precioPaquete } : {}),
            oferta: oferta(v.oferta), hay: !!v.enStock, ...minimo(v.unidadesMinimas),
          })),
        }
        : { precio: it.precio, oferta: oferta(it.oferta), ...minimo(it.unidadesMinimas) }),
    };
  }

  /** Sí/no por local (no las cantidades): el producto suelto o en cualquiera de sus paquetes. */
  private async enLocales(productoId: number) {
    if (!productoId) throw new Error('Falta el id del producto (el de buscar_productos).');
    const [sucs, hay] = await Promise.all([
      this.db.select({ id: sucursales.id, nombre: sucursales.nombre }).from(sucursales).where(eq(sucursales.activa, true)).orderBy(asc(sucursales.id)),
      this.db.selectDistinct({ sucursalId: stock.sucursalId }).from(stock)
        .where(and(eq(stock.productoId, productoId), eq(stock.estado, 'disponible'), gt(stock.cantidad, 0))),
    ]);
    const con = new Set(hay.map((h) => h.sucursalId));
    return sucs.map((s) => ({ local: s.nombre, hay: con.has(s.id) }));
  }

  private async verificarMayorista(crudo: string, ctx: Contexto) {
    if (ctx.chat.accesoId) return { verificado: true, aviso: 'Ya estaba verificado como mayorista.' };
    const fallidos = this.dniFallidos.get(ctx.chat.id) ?? 0;
    if (fallidos >= MAX_DNI_FALLIDOS) return { verificado: false, motivo: 'Demasiados intentos. Que lo resuelva una persona del local (derivá la charla).' };
    const dni = dniDe(crudo);
    if (!dni) return { verificado: false, motivo: 'El DNI va con 7 u 8 números.' };
    const [a] = await this.db.select().from(tiendaAccesos).where(eq(tiendaAccesos.dni, dni)).limit(1);
    if (a?.estado === 'habilitado') {
      await this.db.update(waChats).set({ accesoId: a.id }).where(eq(waChats.id, ctx.chat.id));
      this.dniFallidos.delete(ctx.chat.id);
      return { verificado: true, nombre: a.nombre, aviso: 'Desde su próximo mensaje ve precios mayoristas: decile que ya está verificado y preguntale qué necesita.' };
    }
    this.dniFallidos.set(ctx.chat.id, fallidos + 1);
    if (a?.estado === 'pendiente') return { verificado: false, motivo: 'Su pedido de ingreso a la tienda mayorista todavía está pendiente: el local lo revisa y le avisa.' };
    if (a) return { verificado: false, motivo: 'No está habilitado para comprar por mayor. Si cree que es un error, que lo hable con una persona del local.' };
    return { verificado: false, motivo: `No hay nadie registrado con ese DNI. Puede pedir el ingreso en la tienda (${ctx.cfg.linkTienda}), eligiendo «Mayorista».` };
  }

  /* ============================== el chat de prueba ============================== */

  private waIdPrueba = (usuarioId: number) => `prueba-${usuarioId}`;

  /** Manda un mensaje como cliente y espera la respuesta (igual que un WhatsApp real, sin Meta ni espera). */
  async probar(usuarioId: number, texto: string) {
    const t = String(texto ?? '').trim().slice(0, 2000);
    if (!t) return this.charlaPrueba(usuarioId);
    const chat = await this.chatDe(this.waIdPrueba(usuarioId), '', true);
    await this.db.insert(waMensajes).values({ chatId: chat.id, rol: 'cliente', texto: t });
    await this.enCola(chat.id, () => this.atender(chat.id));
    return this.charlaPrueba(usuarioId);
  }

  /** Empieza de cero; `mayorista`: como un mayorista ya verificado (el primer habilitado), para ver sus precios. */
  async reiniciarPrueba(usuarioId: number, mayorista: boolean) {
    await this.db.delete(waChats).where(and(eq(waChats.waId, this.waIdPrueba(usuarioId)), eq(waChats.prueba, true)));
    const chat = await this.chatDe(this.waIdPrueba(usuarioId), '', true);
    this.dniFallidos.delete(chat.id);
    if (mayorista) {
      const [a] = await this.db.select({ id: tiendaAccesos.id }).from(tiendaAccesos).where(eq(tiendaAccesos.estado, 'habilitado')).orderBy(asc(tiendaAccesos.id)).limit(1);
      if (!a) throw new NotFoundException('No hay ningún mayorista habilitado en la tienda para probar como mayorista.');
      await this.db.update(waChats).set({ accesoId: a.id }).where(eq(waChats.id, chat.id));
    }
    return this.charlaPrueba(usuarioId);
  }

  async charlaPrueba(usuarioId: number) {
    const [chat] = await this.db.select().from(waChats).where(and(eq(waChats.waId, this.waIdPrueba(usuarioId)), eq(waChats.prueba, true))).limit(1);
    return chat ? this.detalle(chat.id) : { chat: null, mensajes: [], costo: 0 };
  }

  /* ============================== las charlas ============================== */

  async chats() {
    const filas = await this.db.select({
      id: waChats.id, telefono: waChats.telefono, waId: waChats.waId, nombre: waChats.nombre, mayorista: sql<boolean>`${waChats.accesoId} is not null`,
      pausadaHasta: waChats.iaPausadaHasta, derivadoEn: waChats.derivadoEn, derivadoMotivo: waChats.derivadoMotivo, ultimoMensajeEn: waChats.ultimoMensajeEn,
      /* `wa_chats.id` escrito entero: `${waChats.id}` sale como «id» a secas y adentro se lee el del mensaje. */
      ultimo: sql<string>`(select m.texto from wa_mensajes m where m.chat_id = wa_chats.id order by m.id desc limit 1)`,
    }).from(waChats).where(eq(waChats.prueba, false)).orderBy(desc(waChats.ultimoMensajeEn)).limit(100);
    const ahora = new Date();
    return filas.map((f) => ({ ...f, pausada: !!f.pausadaHasta && f.pausadaHasta > ahora }));
  }

  async detalle(id: number) {
    const [chat] = await this.db.select().from(waChats).where(eq(waChats.id, id)).limit(1);
    if (!chat) throw new NotFoundException('No existe esa charla.');
    const [mensajes, [c]] = await Promise.all([
      this.db.select({ id: waMensajes.id, rol: waMensajes.rol, texto: waMensajes.texto, error: waMensajes.error, creadoEn: waMensajes.creadoEn })
        .from(waMensajes).where(eq(waMensajes.chatId, id)).orderBy(asc(waMensajes.id)).limit(500),
      this.db.select({ t: sql<number>`coalesce(sum(${waTurnos.costo}), 0)::float8` }).from(waTurnos).where(eq(waTurnos.chatId, id)),
    ]);
    return {
      chat: { ...chat, mayorista: !!chat.accesoId, pausada: !!chat.iaPausadaHasta && chat.iaPausadaHasta > new Date() },
      mensajes, costo: Math.round((Number(c?.t) || 0) * 10000) / 10000,
    };
  }

  /** Retomar (la IA vuelve a contestar) o pausar a mano. */
  async pausa(id: number, horas: number) {
    if (horas > 0) await this.pausar(id, Math.min(horas, 72), 'Pausada desde el ERP');
    else await this.db.update(waChats).set({ iaPausadaHasta: null, derivadoEn: null, derivadoMotivo: '' }).where(eq(waChats.id, id));
    return this.detalle(id);
  }

  /** «No usar IA con este número»: va a la lista y se borra su charla (es del personal o un proveedor). */
  async sinIaDesdeChat(id: number) {
    const [chat] = await this.db.select().from(waChats).where(and(eq(waChats.id, id), eq(waChats.prueba, false))).limit(1);
    if (!chat) throw new NotFoundException('No existe esa charla.');
    const cfg = await this.config();
    await this.guardarConfig({ numerosSinIa: [...cfg.numerosSinIa, { numero: chat.telefono || chat.waId, nombre: chat.nombre }] });
    await this.db.delete(waChats).where(eq(waChats.id, id));
    return { ok: true };
  }
}

@Controller('whatsapp')
export class WhatsappController {
  constructor(private readonly svc: WhatsappService) {}

  /* Meta (sin sesión: la puerta es el token de verificación y la firma). */
  @Publico() @Get('webhook')
  verificar(@Query() q: any) { return this.svc.verificar(q); }

  @Publico() @Post('webhook') @HttpCode(200)
  aviso(@Req() req: any) { return this.svc.aviso(req); }

  /* El ERP. */
  @Permiso(PERMISO) @Get('estado') estado() { return this.svc.estado(); }
  @Permiso(PERMISO) @Get('config') config() { return this.svc.config(); }
  @Permiso(PERMISO) @Put('config') guardar(@Body() body: any) { return this.svc.guardarConfig(body); }

  @Permiso(PERMISO) @Get('prueba') prueba(@Auth() s: Sesion) { return this.svc.charlaPrueba(s.usuarioId); }
  @Permiso(PERMISO) @Post('prueba') probar(@Auth() s: Sesion, @Body() b: any) { return this.svc.probar(s.usuarioId, b?.texto); }
  @Permiso(PERMISO) @Post('prueba/reiniciar') reiniciar(@Auth() s: Sesion, @Body() b: any) { return this.svc.reiniciarPrueba(s.usuarioId, b?.mayorista === true); }

  @Permiso(PERMISO) @Get('chats') chats() { return this.svc.chats(); }
  @Permiso(PERMISO) @Get('chats/:id') detalle(@Param('id', ParseIntPipe) id: number) { return this.svc.detalle(id); }
  @Permiso(PERMISO) @Post('chats/:id/pausa') pausa(@Param('id', ParseIntPipe) id: number, @Body() b: any) { return this.svc.pausa(id, Math.trunc(Number(b?.horas)) || 0); }
  @Permiso(PERMISO) @Post('chats/:id/sin-ia') sinIa(@Param('id', ParseIntPipe) id: number) { return this.svc.sinIaDesdeChat(id); }
}

@Module({
  imports: [ConfiguracionModule, TiendaModule],
  controllers: [WhatsappController],
  providers: [WhatsappService],
})
export class WhatsappModule {}
