/**
 * CHAT INTERNO — el mostrador le pregunta a administración sin dejar el puesto.
 * ============================================================================
 * Un canal grupal POR SUCURSAL (hoy habilitado solo en la distribuidora — el
 * gate lo decide la API por el TIPO de sucursal) más CONVERSACIONES PRIVADAS
 * 1-a-1: si tres cajeros le preguntan a la vez al administrador por el canal,
 * las respuestas se pisan; el privado ordena eso.
 *
 * Modelo: un solo cajón de mensajes con destinatario opcional —
 * `para_usuario_id` NULL es el canal del local; con valor, es privado y solo
 * lo ven las dos puntas. La lectura es POR CONVERSACIÓN y por usuario
 * (canal 0 = grupal, otro = el privado con ese usuario) y vive en la base.
 *
 * PRESENCIA sin infraestructura: el poller que ya corre cada 4 segundos ES el
 * latido. Cada consulta registra "visto ahora" en memoria del proceso, y
 * "en línea" = visto hace menos de 15 segundos. Se pierde al reiniciar la API
 * y se rearma solo en el próximo tick — para un semáforo verde alcanza.
 *
 * Sin WebSockets a propósito: la base es la verdad y 3-4 segundos de latencia
 * son indistinguibles de "instantáneo" para esta dinámica.
 */
import {
  Body, Controller, Get, Inject, Injectable, Module, Post, Query,
  BadRequestException,
} from '@nestjs/common';
import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { chatLecturas, chatMensajes, sucursales, usuarios } from '../db/schema';
import { Auth, type Sesion } from '../auth/auth.decoradores';

const LIMITE_BOOTSTRAP = 400;
const LIMITE_POLL = 100;
const EN_LINEA_MS = 15000;
/**
 * El chat es CONVERSACIÓN, no archivo: a las 24 horas el mensaje se va. Dos
 * capas, y las dos hacen falta:
 *  - las consultas FILTRAN por este corte, así el límite es exacto en todo
 *    momento (sin esto se verían mensajes de 25 h entre purga y purga);
 *  - la purga BORRA de verdad, así la tabla no crece (sin esto la base junta
 *    conversaciones para siempre).
 * Lo que hay que decidir en un documento (un dato de cuenta, un pedido) va al
 * documento, no al chat.
 */
const RETENCION_MS = 24 * 60 * 60 * 1000;
/** Cada cuánto, como mucho, se ejecuta el DELETE (el poll pega cada 4 s). */
const PURGA_CADA_MS = 10 * 60 * 1000;

class EnviarMensajeDto {
  @IsInt() sucursalId!: number;
  @IsInt() usuarioId!: number;
  /** Sin destinatario = canal grupal; con destinatario = privado 1-a-1. */
  @IsOptional() @IsInt() paraUsuarioId?: number;
  @IsString() @MaxLength(1000) texto!: string;
}

class MarcarLeidoDto {
  @IsInt() sucursalId!: number;
  @IsInt() usuarioId!: number;
  /** 0 = canal grupal; otro = la conversación privada con ese usuario. */
  @IsOptional() @IsInt() canalUsuarioId?: number;
  @IsInt() ultimoMensajeId!: number;
}

@Injectable()
export class ChatService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Latido de presencia: usuarioId → { visto, sucursalId }. En memoria, a propósito. */
  private vistos = new Map<number, { visto: number; sucursalId: number }>();
  /** Cuándo corrió el último DELETE. En memoria: si la API reinicia, se purga de nuevo. */
  private ultimaPurga = 0;

  private latido(sucursalId: number, usuarioId: number) {
    if (usuarioId > 0) this.vistos.set(usuarioId, { visto: Date.now(), sucursalId });
  }

  /** El corte de retención: nada anterior a esto existe para el chat. */
  private corte() {
    return new Date(Date.now() - RETENCION_MS);
  }

  /**
   * Borra lo que pasó las 24 horas. Se dispara desde las consultas (no hay
   * scheduler en la API y no hace falta uno: si nadie usa el chat, tampoco
   * crece). Va sin `await` — es mantenimiento interno y no tiene por qué
   * sumarle latencia al poll del cajero.
   */
  private purgarSiToca() {
    const ahora = Date.now();
    // El throttle se reclama ANTES del DELETE: si no, dos polls simultáneos
    // (tres cajeros pollean cada 4 s) lanzarían el mismo borrado en paralelo.
    if (ahora - this.ultimaPurga < PURGA_CADA_MS) return;
    this.ultimaPurga = ahora;
    this.db.delete(chatMensajes)
      .where(lt(chatMensajes.fecha, this.corte()))
      .catch(() => { this.ultimaPurga = 0; }); // falló: que reintente el próximo
  }

  /** Quiénes están en línea en esta sucursal (pollearon hace < 15 s), con nombre. */
  private async enLinea(sucursalId: number) {
    const corte = Date.now() - EN_LINEA_MS;
    const ids = [...this.vistos.entries()]
      .filter(([, v]) => v.visto >= corte && v.sucursalId === sucursalId)
      .map(([id]) => id);
    if (!ids.length) return [];
    const rows = await this.db.select({ id: usuarios.id, nombre: usuarios.nombre })
      .from(usuarios).where(inArray(usuarios.id, ids));
    return rows.sort((a, b) => a.nombre.localeCompare(b.nombre));
  }

  /** El canal existe solo donde la regla lo habilita: hoy, la distribuidora. */
  private async habilitada(sucursalId: number) {
    const [s] = await this.db.select().from(sucursales).where(eq(sucursales.id, sucursalId)).limit(1);
    return !!s && s.tipo === 'distribuidora';
  }

  private baseMensajes() {
    return this.db.select({
      id: chatMensajes.id,
      fecha: chatMensajes.fecha,
      usuarioId: chatMensajes.usuarioId,
      usuarioNombre: usuarios.nombre,
      paraUsuarioId: chatMensajes.paraUsuarioId,
      texto: chatMensajes.texto,
    }).from(chatMensajes)
      .leftJoin(usuarios, eq(usuarios.id, chatMensajes.usuarioId));
  }

  /**
   * Lo VISIBLE para este usuario: el canal del local + los privados donde es
   * una punta, y siempre DENTRO de la retención — el corte se aplica en la
   * consulta, no depende de que la purga haya corrido.
   */
  private visiblesPara(sucursalId: number, usuarioId: number) {
    return and(
      eq(chatMensajes.sucursalId, sucursalId),
      gte(chatMensajes.fecha, this.corte()),
      or(
        isNull(chatMensajes.paraUsuarioId),
        eq(chatMensajes.paraUsuarioId, usuarioId),
        eq(chatMensajes.usuarioId, usuarioId),
      ),
    );
  }

  /**
   * La foto inicial: mensajes visibles, lecturas POR CONVERSACIÓN y quiénes
   * están en línea. `habilitado: false` es respuesta válida — el cliente
   * esconde el botón y no vuelve a preguntar.
   */
  async bootstrap(sucursalId: number, usuarioId: number) {
    if (!(await this.habilitada(sucursalId))) return { habilitado: false };
    this.latido(sucursalId, usuarioId);
    this.purgarSiToca();
    const ultimos = await this.baseMensajes()
      .where(this.visiblesPara(sucursalId, usuarioId))
      .orderBy(desc(chatMensajes.id))
      .limit(LIMITE_BOOTSTRAP);
    const lecturas = await this.db.select({
      canalUsuarioId: chatLecturas.canalUsuarioId,
      ultimoMensajeId: chatLecturas.ultimoMensajeId,
    }).from(chatLecturas)
      .where(and(eq(chatLecturas.sucursalId, sucursalId), eq(chatLecturas.usuarioId, usuarioId)));
    return {
      habilitado: true,
      mensajes: ultimos.reverse(),
      lecturas,
      enLinea: await this.enLinea(sucursalId),
      // El cliente descarta con el MISMO criterio: una sola fuente de verdad
      // para la retención, y el panel no muestra lo que la API ya no tiene.
      retencionHoras: RETENCION_MS / 3600000,
    };
  }

  /** El tick del poller: lo nuevo visible para MÍ + la foto de presencia. */
  async nuevos(sucursalId: number, usuarioId: number, desde: number) {
    this.latido(sucursalId, usuarioId);
    this.purgarSiToca();
    const mensajes = await this.baseMensajes()
      .where(and(this.visiblesPara(sucursalId, usuarioId), gt(chatMensajes.id, desde)))
      .orderBy(asc(chatMensajes.id))
      .limit(LIMITE_POLL);
    return { mensajes, enLinea: await this.enLinea(sucursalId) };
  }

  async enviar(dto: EnviarMensajeDto) {
    const texto = (dto.texto ?? '').trim();
    if (!texto) throw new BadRequestException('El mensaje está vacío.');
    if (!(await this.habilitada(dto.sucursalId))) {
      throw new BadRequestException('El chat no está habilitado en esta sucursal.');
    }
    const [u] = await this.db.select().from(usuarios).where(eq(usuarios.id, dto.usuarioId)).limit(1);
    if (!u || !u.activo) throw new BadRequestException('Usuario inválido.');
    let para: number | null = null;
    if (dto.paraUsuarioId) {
      if (dto.paraUsuarioId === u.id) throw new BadRequestException('No podés escribirte a vos mismo.');
      const [dest] = await this.db.select().from(usuarios).where(eq(usuarios.id, dto.paraUsuarioId)).limit(1);
      if (!dest || !dest.activo) throw new BadRequestException('Destinatario inválido.');
      para = dest.id;
    }

    this.latido(dto.sucursalId, u.id);
    const [m] = await this.db.insert(chatMensajes).values({
      sucursalId: dto.sucursalId, usuarioId: u.id, paraUsuarioId: para, texto,
    }).returning();
    // Lo propio se da por leído EN SU CONVERSACIÓN: el badge es de los demás.
    await this.marcarLeido({
      sucursalId: dto.sucursalId, usuarioId: u.id,
      canalUsuarioId: para ?? 0, ultimoMensajeId: m.id,
    });
    return { ...m, usuarioNombre: u.nombre };
  }

  /**
   * Upsert de la marca de lectura de UNA conversación, solo hacia ADELANTE:
   * dos pestañas del mismo usuario pueden marcar en desorden y la más vieja
   * no debe pisar a la nueva.
   *
   * La marca sobrevive a la purga a propósito: es una MARCA DE AGUA (un id),
   * no una referencia — el mensaje puede ya no existir y el número sigue
   * sirviendo, porque los ids solo crecen.
   */
  async marcarLeido(dto: MarcarLeidoDto) {
    await this.db.insert(chatLecturas)
      .values({
        sucursalId: dto.sucursalId, usuarioId: dto.usuarioId,
        canalUsuarioId: dto.canalUsuarioId ?? 0, ultimoMensajeId: dto.ultimoMensajeId,
      })
      .onConflictDoUpdate({
        target: [chatLecturas.sucursalId, chatLecturas.usuarioId, chatLecturas.canalUsuarioId],
        set: { ultimoMensajeId: sql`GREATEST(${chatLecturas.ultimoMensajeId}, ${dto.ultimoMensajeId})` },
      });
    return { ok: true };
  }
}

/**
 * QUIÉN SOY Y DÓNDE ESTOY SALEN DE LA SESIÓN, NO DE LA URL.
 *
 * Acá era más grave que en el resto del sistema. El poller pedía
 * `/chat/mensajes?sucursalId=1&usuarioId=9`, y `visiblesPara()` usa ese
 * `usuarioId` para decidir qué mensajes PRIVADOS mostrar: cambiar el número en
 * la barra de direcciones leía las conversaciones 1-a-1 de otro. Y con
 * `sucursalId` pasaba lo mismo para el canal de otra sucursal.
 *
 * Los DTO de las dos escrituras siguen validando su forma, pero el usuario y la
 * sucursal se sobreescriben con los de la sesión: lo que el cliente mande en
 * esos dos campos ya no se mira.
 */
@Controller('chat')
export class ChatController {
  constructor(private readonly svc: ChatService) {}

  @Get('bootstrap') bootstrap(@Auth() s: Sesion) {
    return this.svc.bootstrap(s.sucursalId, s.usuarioId);
  }

  @Get('mensajes') nuevos(@Auth() s: Sesion, @Query('desde') desde: string) {
    return this.svc.nuevos(s.sucursalId, s.usuarioId, Number(desde) || 0);
  }

  @Post('mensajes') enviar(@Body() dto: EnviarMensajeDto, @Auth() s: Sesion) {
    return this.svc.enviar({ ...dto, usuarioId: s.usuarioId, sucursalId: s.sucursalId });
  }

  @Post('leido') leido(@Body() dto: MarcarLeidoDto, @Auth() s: Sesion) {
    return this.svc.marcarLeido({ ...dto, usuarioId: s.usuarioId, sucursalId: s.sucursalId });
  }
}

@Module({
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
