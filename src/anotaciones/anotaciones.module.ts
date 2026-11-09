/**
 * DASHBOARD › ANOTACIONES (0219, 5/11/2026, pedido del dueño)
 * ============================================================================
 * «Una parte de anotación que pueda ir haciendo algún admin o yo, y que se
 * asiente con fecha, hora y usuario.» Las ven y las escriben el admin y el
 * superadmin (`esJefe`, el mismo criterio de todo el sistema). Fecha, hora y
 * usuario los pone el servidor: el cliente solo manda el texto.
 *
 * El texto no se edita. La borra quien la escribió o el superadmin, y queda
 * marcada (quién y cuándo) en vez de desaparecer de la base.
 *
 * RECORDATORIO (optativo): «que avise con banner y poder elegir a qué usuario
 * avisarle». Una fecha y hora y los usuarios elegidos (cualquier usuario
 * activo, no solo admins). Desde esa hora a cada uno le sale el aviso arriba de
 * toda la app (`GET mis-avisos`) hasta que toca «Listo» (`POST :id/visto`).
 * Esas dos rutas son de cualquier usuario: solo tocan SUS avisos.
 *
 * EDITAR EL RECORDATORIO (9/11/2026, pedido del dueño): solo quien escribió la
 * anotación (ni el superadmin) cambia el día y la hora, a quién avisarle, o lo
 * saca. Si cambia el día y la hora, el aviso vuelve a salirles a todos (lo
 * visto era del aviso anterior); si solo cambia a quién, los que ya lo vieron
 * siguen como vistos.
 */
import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, Injectable, Module,
  NotFoundException, Param, ParseIntPipe, Post, Put, Query,
} from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { and, asc, desc, eq, inArray, isNull, lt, lte, notInArray, sql } from 'drizzle-orm';
import { Auth, CualquierUsuario, type Sesion } from '../auth/auth.decoradores';
import { esJefe } from '../auth/auth.guard';
import { DRIZZLE, Database } from '../db/drizzle';
import { anotacionAvisos, anotaciones, roles, usuarios } from '../db/schema';

export const MAX_TEXTO = 2000;
const POR_PAGINA = 20;
const esSuperadmin = (s: Sesion) => !!s?.permisos?.includes('*');

/** ISO. Con recordatorio van los dos: cuándo y a quién; sin ninguno, no hay recordatorio. */
class RecordatorioDto {
  @IsOptional() @IsString() recordarEn?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsInt({ each: true }) avisarA?: number[];
}

class AnotacionDto extends RecordatorioDto {
  @IsString() @MaxLength(MAX_TEXTO) texto!: string;
}

@Injectable()
export class AnotacionesService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Las más nuevas primero, de a 20; `antes` = el id más viejo que ya se ve («Ver más»). */
  async listar(sesion: Sesion, antesIn?: string) {
    const antes = Number(antesIn) || null;
    const filas = await this.db.select({
      id: anotaciones.id, creadoEn: anotaciones.creadoEn, usuarioId: anotaciones.usuarioId,
      usuarioNombre: anotaciones.usuarioNombre, texto: anotaciones.texto, recordarEn: anotaciones.recordarEn,
      /* A quién se le avisa y si ya lo vio: así quien la escribió sabe si llegó. */
      avisos: sql<{ usuarioId: number; nombre: string; vistoEn: string | null }[]>`coalesce((
        select json_agg(json_build_object('usuarioId', u.id, 'nombre', u.nombre, 'vistoEn', av.visto_en) order by u.nombre)
        from ${anotacionAvisos} av join ${usuarios} u on u.id = av.usuario_id
        where av.anotacion_id = "anotaciones"."id"), '[]'::json)`,
    }).from(anotaciones)
      .where(and(isNull(anotaciones.borradaEn), antes ? lt(anotaciones.id, antes) : undefined))
      .orderBy(desc(anotaciones.id))
      .limit(POR_PAGINA + 1);
    const superadmin = esSuperadmin(sesion);
    return {
      hayMas: filas.length > POR_PAGINA,
      filas: filas.slice(0, POR_PAGINA).map(({ usuarioId, ...a }) => ({
        ...a, puedeBorrar: superadmin || usuarioId === sesion.usuarioId, puedeEditar: usuarioId === sesion.usuarioId,
      })),
    };
  }

  /** A quién se le puede avisar: los usuarios activos. */
  usuarios() {
    return this.db.select({ id: usuarios.id, nombre: usuarios.nombre, rol: roles.nombre })
      .from(usuarios).innerJoin(roles, eq(roles.id, usuarios.rolId))
      .where(eq(usuarios.activo, true)).orderBy(asc(usuarios.nombre));
  }

  /** El recordatorio pedido, validado: sin fecha ni usuarios = sin recordatorio. */
  private async recordatorio(dto: RecordatorioDto) {
    const avisarA = [...new Set(dto.avisarA ?? [])];
    if (!dto.recordarEn && !avisarA.length) return { recordarEn: null, avisarA };
    const recordarEn = new Date(dto.recordarEn ?? '');
    if (!dto.recordarEn || Number.isNaN(recordarEn.getTime())) throw new BadRequestException('Poné el día y la hora del recordatorio.');
    if (!avisarA.length) throw new BadRequestException('Elegí a quién avisarle.');
    const activos = await this.db.select({ id: usuarios.id }).from(usuarios)
      .where(and(inArray(usuarios.id, avisarA), eq(usuarios.activo, true)));
    if (activos.length !== avisarA.length) throw new BadRequestException('Uno de los usuarios elegidos no existe o está desactivado.');
    return { recordarEn, avisarA };
  }

  async crear(sesion: Sesion, dto: AnotacionDto) {
    const texto = (dto.texto ?? '').trim();
    if (!texto) throw new BadRequestException('Escribí la anotación.');
    const { recordarEn, avisarA } = await this.recordatorio(dto);
    return this.db.transaction(async (tx) => {
      const [a] = await tx.insert(anotaciones)
        .values({ usuarioId: sesion.usuarioId, usuarioNombre: sesion.nombre, texto, recordarEn })
        .returning({ id: anotaciones.id });
      if (avisarA.length) await tx.insert(anotacionAvisos).values(avisarA.map((usuarioId) => ({ anotacionId: a.id, usuarioId })));
      return { ok: true, id: a.id };
    });
  }

  /** Cambiar o sacar el recordatorio: solo quien escribió la anotación. */
  async editarRecordatorio(sesion: Sesion, id: number, dto: RecordatorioDto) {
    const { recordarEn, avisarA } = await this.recordatorio(dto);
    return this.db.transaction(async (tx) => {
      const [a] = await tx.select({ usuarioId: anotaciones.usuarioId, recordarEn: anotaciones.recordarEn }).from(anotaciones)
        .where(and(eq(anotaciones.id, id), isNull(anotaciones.borradaEn))).for('update');
      if (!a) throw new NotFoundException('Esa anotación no existe o ya se borró.');
      if (a.usuarioId !== sesion.usuarioId) throw new ForbiddenException('El recordatorio lo cambia solo quien escribió la anotación.');
      await tx.update(anotaciones).set({ recordarEn }).where(eq(anotaciones.id, id));
      await tx.delete(anotacionAvisos).where(and(
        eq(anotacionAvisos.anotacionId, id),
        avisarA.length ? notInArray(anotacionAvisos.usuarioId, avisarA) : undefined,
      ));
      if (!avisarA.length) return { ok: true };
      /* Otro día y hora es otro aviso: lo visto era del anterior. */
      if (a.recordarEn?.getTime() !== recordarEn!.getTime()) {
        await tx.update(anotacionAvisos).set({ vistoEn: null }).where(eq(anotacionAvisos.anotacionId, id));
      }
      await tx.insert(anotacionAvisos).values(avisarA.map((usuarioId) => ({ anotacionId: id, usuarioId }))).onConflictDoNothing();
      return { ok: true };
    });
  }

  async borrar(sesion: Sesion, id: number) {
    const [a] = await this.db.select({ usuarioId: anotaciones.usuarioId }).from(anotaciones)
      .where(and(eq(anotaciones.id, id), isNull(anotaciones.borradaEn)));
    if (!a) throw new NotFoundException('Esa anotación no existe o ya se borró.');
    if (!esSuperadmin(sesion) && a.usuarioId !== sesion.usuarioId) {
      throw new ForbiddenException('Solo la puede borrar quien la escribió o el superadmin.');
    }
    await this.db.update(anotaciones).set({ borradaEn: new Date(), borradaPor: sesion.usuarioId })
      .where(and(eq(anotaciones.id, id), isNull(anotaciones.borradaEn)));
    return { ok: true };
  }

  /** Los recordatorios de ESTE usuario que ya llegaron a su hora y no marcó «Listo». Liviano: lo sondea el banner. */
  misAvisos(sesion: Sesion) {
    return this.db.select({
      id: anotaciones.id, texto: anotaciones.texto, usuarioNombre: anotaciones.usuarioNombre,
      creadoEn: anotaciones.creadoEn, recordarEn: anotaciones.recordarEn,
    }).from(anotacionAvisos)
      .innerJoin(anotaciones, eq(anotaciones.id, anotacionAvisos.anotacionId))
      .where(and(
        eq(anotacionAvisos.usuarioId, sesion.usuarioId), isNull(anotacionAvisos.vistoEn),
        isNull(anotaciones.borradaEn), lte(anotaciones.recordarEn, sql`now()`),
      ))
      .orderBy(asc(anotaciones.recordarEn), asc(anotaciones.id));
  }

  async visto(sesion: Sesion, id: number) {
    const r = await this.db.update(anotacionAvisos).set({ vistoEn: new Date() })
      .where(and(eq(anotacionAvisos.anotacionId, id), eq(anotacionAvisos.usuarioId, sesion.usuarioId), isNull(anotacionAvisos.vistoEn)))
      .returning({ id: anotacionAvisos.anotacionId });
    if (!r.length) throw new NotFoundException('Ese recordatorio no es tuyo o ya lo marcaste.');
    return { ok: true };
  }
}

/** Admin y superadmin; el resto, 403 (no es un permiso del catálogo: va con el rol). */
const soloJefe = (s: Sesion) => {
  if (!esJefe(s)) throw new ForbiddenException('Las anotaciones son del admin y el superadmin.');
  return s;
};

@Controller('anotaciones')
@CualquierUsuario()
export class AnotacionesController {
  constructor(private readonly svc: AnotacionesService) {}

  @Get() listar(@Auth() s: Sesion, @Query('antes') antes?: string) { return this.svc.listar(soloJefe(s), antes); }
  @Get('usuarios') usuarios(@Auth() s: Sesion) { soloJefe(s); return this.svc.usuarios(); }
  @Post() crear(@Auth() s: Sesion, @Body() dto: AnotacionDto) { return this.svc.crear(soloJefe(s), dto); }
  @Put(':id/recordatorio') editarRecordatorio(@Auth() s: Sesion, @Param('id', ParseIntPipe) id: number, @Body() dto: RecordatorioDto) {
    return this.svc.editarRecordatorio(soloJefe(s), id, dto);
  }
  @Delete(':id') borrar(@Auth() s: Sesion, @Param('id', ParseIntPipe) id: number) { return this.svc.borrar(soloJefe(s), id); }

  /* Cualquier usuario: solo los suyos. */
  @Get('mis-avisos') misAvisos(@Auth() s: Sesion) { return this.svc.misAvisos(s); }
  @Post(':id/visto') visto(@Auth() s: Sesion, @Param('id', ParseIntPipe) id: number) { return this.svc.visto(s, id); }
}

@Module({ controllers: [AnotacionesController], providers: [AnotacionesService] })
export class AnotacionesModule {}
