/**
 * CHAT INTERNO — el mostrador le pregunta a administración sin dejar el puesto.
 * ============================================================================
 * Un canal grupal POR SUCURSAL, habilitado hoy SOLO en la distribuidora (¿hay
 * cuenta para transferencia? ¿qué pasó con el pedido web?). El gate lo decide
 * la API por el TIPO de sucursal — el cliente no puede habilitarse solo, y si
 * mañana Express quiere chat, es cambiar esta regla, no rediseñar.
 *
 * Sin WebSockets a propósito: el cliente pollea (como órdenes web y cambios de
 * precio), la base es la verdad y 3-4 segundos de latencia son indistinguibles
 * de "instantáneo" para esta dinámica. La lectura es POR USUARIO y vive en la
 * base: el "no leídos" sobrevive al F5 y a cambiar de máquina.
 */
import {
  Body, Controller, Get, Inject, Injectable, Module, Post, Query,
  BadRequestException,
} from '@nestjs/common';
import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { chatLecturas, chatMensajes, sucursales, usuarios } from '../db/schema';

const LIMITE_BOOTSTRAP = 200;
const LIMITE_POLL = 100;

class EnviarMensajeDto {
  @IsInt() sucursalId!: number;
  @IsInt() usuarioId!: number;
  @IsString() @MaxLength(1000) texto!: string;
}

class MarcarLeidoDto {
  @IsInt() sucursalId!: number;
  @IsInt() usuarioId!: number;
  @IsInt() ultimoMensajeId!: number;
  @IsOptional() nada?: never;
}

@Injectable()
export class ChatService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

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
      texto: chatMensajes.texto,
    }).from(chatMensajes)
      .leftJoin(usuarios, eq(usuarios.id, chatMensajes.usuarioId));
  }

  /**
   * La foto inicial: si el canal está habilitado, los últimos mensajes y hasta
   * dónde leyó ESTE usuario. `habilitado: false` es respuesta válida — el
   * cliente esconde el botón y no vuelve a preguntar.
   */
  async bootstrap(sucursalId: number, usuarioId: number) {
    if (!(await this.habilitada(sucursalId))) return { habilitado: false };
    // Los últimos N en orden de lectura: se piden DESC con límite y se dan vuelta.
    const ultimos = await this.baseMensajes()
      .where(eq(chatMensajes.sucursalId, sucursalId))
      .orderBy(desc(chatMensajes.id))
      .limit(LIMITE_BOOTSTRAP);
    const [lectura] = await this.db.select().from(chatLecturas)
      .where(and(eq(chatLecturas.sucursalId, sucursalId), eq(chatLecturas.usuarioId, usuarioId)))
      .limit(1);
    return {
      habilitado: true,
      mensajes: ultimos.reverse(),
      ultimoLeidoId: lectura?.ultimoMensajeId ?? 0,
    };
  }

  /** El tick del poller: solo lo NUEVO desde el último mensaje que el cliente tiene. */
  async nuevos(sucursalId: number, desde: number) {
    return this.baseMensajes()
      .where(and(eq(chatMensajes.sucursalId, sucursalId), gt(chatMensajes.id, desde)))
      .orderBy(asc(chatMensajes.id))
      .limit(LIMITE_POLL);
  }

  async enviar(dto: EnviarMensajeDto) {
    const texto = (dto.texto ?? '').trim();
    if (!texto) throw new BadRequestException('El mensaje está vacío.');
    if (!(await this.habilitada(dto.sucursalId))) {
      throw new BadRequestException('El chat no está habilitado en esta sucursal.');
    }
    const [u] = await this.db.select().from(usuarios).where(eq(usuarios.id, dto.usuarioId)).limit(1);
    if (!u || !u.activo) throw new BadRequestException('Usuario inválido.');

    const [m] = await this.db.insert(chatMensajes).values({
      sucursalId: dto.sucursalId, usuarioId: u.id, texto,
    }).returning();
    // Lo propio se da por leído: el badge es para lo que escriben LOS DEMÁS.
    await this.marcarLeido({ sucursalId: dto.sucursalId, usuarioId: u.id, ultimoMensajeId: m.id });
    return { ...m, usuarioNombre: u.nombre };
  }

  /**
   * Upsert de la marca de lectura, solo hacia ADELANTE: dos pestañas del mismo
   * usuario pueden marcar en desorden y la más vieja no debe pisar a la nueva.
   */
  async marcarLeido(dto: MarcarLeidoDto) {
    await this.db.insert(chatLecturas)
      .values({ sucursalId: dto.sucursalId, usuarioId: dto.usuarioId, ultimoMensajeId: dto.ultimoMensajeId })
      .onConflictDoUpdate({
        target: [chatLecturas.sucursalId, chatLecturas.usuarioId],
        set: { ultimoMensajeId: sql`GREATEST(${chatLecturas.ultimoMensajeId}, ${dto.ultimoMensajeId})` },
      });
    return { ok: true };
  }
}

@Controller('chat')
export class ChatController {
  constructor(private readonly svc: ChatService) {}

  @Get('bootstrap') bootstrap(
    @Query('sucursalId') sucursalId: string,
    @Query('usuarioId') usuarioId: string,
  ) {
    return this.svc.bootstrap(Number(sucursalId) || 0, Number(usuarioId) || 0);
  }

  @Get('mensajes') nuevos(
    @Query('sucursalId') sucursalId: string,
    @Query('desde') desde: string,
  ) {
    return this.svc.nuevos(Number(sucursalId) || 0, Number(desde) || 0);
  }

  @Post('mensajes') enviar(@Body() dto: EnviarMensajeDto) {
    return this.svc.enviar(dto);
  }

  @Post('leido') leido(@Body() dto: MarcarLeidoDto) {
    return this.svc.marcarLeido(dto);
  }
}

@Module({
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
