/**
 * GERENCIA › ASESOR (0193, 21/10/2026, pedido del dueño)
 * ============================================================================
 * «Una IA que analice mis rentabilidades y métricas, que conozca mi negocio,
 * que me vaya aconsejando y vea si algo le parece raro… liviana y muy eficaz.
 * Que tenga en cuenta el fraccionado de granel.» Decisiones del dueño: el
 * análisis lo pide él (botón), puede hacerle preguntas con un tope de gasto
 * mensual, y lo ve solo el superadmin.
 *
 * Cómo está hecho (ver cada archivo):
 *   datos.ts         las cuentas que mira (solo lectura, tablas resumen).
 *   foto.ts          la foto del negocio que va en cada análisis.
 *   senales.ts       lo raro que el sistema detecta solo (sin IA, con pruebas).
 *   herramientas.ts  lo que la IA puede consultar al responder preguntas.
 *   ia.ts            la llamada a Claude (informe con formato fijo y conversación).
 *
 * Aprende de dos maneras: la FICHA que escribe el dueño y lo que él CONFIRMA
 * (aprendizajes), y las opiniones de cada alerta («Útil / No aplica / Ya lo
 * sé»), que viajan en cada análisis para no insistir con lo que no importa.
 *
 * SOLO EL SUPERADMIN: `gerencia.asesor` no está en el catálogo de permisos.
 */
import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, Inject, Injectable, Module, NotFoundException, Param, ParseIntPipe,
  Patch, Post, Put, Query,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type Anthropic from '@anthropic-ai/sdk';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { DRIZZLE, type Database } from '../db/drizzle';
import {
  asesorAprendizajes, asesorConfig, asesorConversaciones, asesorInformes, asesorMensajes, asesorOpiniones, asesorUsos,
} from '../db/schema';
import { MetricasModule, MetricasService } from '../metricas/metricas.module';
import { ResultadosModule, ResultadosService } from '../resultados/resultados.module';
import { GastosModule, GastosService } from '../gastos/gastos.module';
import { IA } from '../facturas/ia/anthropic';
import { hoyAr } from '../cafeteria/cuenta';
import type { Fuentes } from './datos';
import { armarFoto } from './foto';
import { detectar } from './senales';
import { ejecutar } from './herramientas';
import { type Contexto, ErrorAsesor, type Llamada, MODELO_ASESOR, analizar, responder, sistemaPreguntas } from './ia';

export const PERMISO_ASESOR = 'gerencia.asesor';
const ZONA = 'America/Argentina/Buenos_Aires';
const r6 = (n: number) => Math.round((Number(n) || 0) * 1_000_000) / 1_000_000;
/** Al 80 % del tope se avisa. */
const AVISO_TOPE = 0.8;
/** Preguntas por conversación: después conviene empezar otra (cada turno reenvía la historia). */
const MAX_PREGUNTAS = 30;

class ConfigDto {
  @IsOptional() @IsNumber() @Min(0) @Max(1000) topeMensualUsd?: number;
  @IsOptional() @IsString() @MaxLength(8000) ficha?: string;
}
class AnalizarDto {
  @IsOptional() @IsString() @MaxLength(400) enfoque?: string;
}
class OpinionDto {
  @IsInt() @Min(0) @Max(50) alerta!: number;
  @IsIn(['util', 'no_aplica', 'ya_lo_se']) valor!: 'util' | 'no_aplica' | 'ya_lo_se';
  @IsOptional() @IsString() @MaxLength(300) nota?: string;
}
class AprendizajeDto {
  @IsString() @MaxLength(400) texto!: string;
}
class AprendizajeEditarDto {
  @IsOptional() @IsString() @MaxLength(400) texto?: string;
  @IsOptional() @IsBoolean() activo?: boolean;
}
class PreguntaDto {
  @IsOptional() @IsInt() conversacionId?: number;
  @IsString() @MaxLength(2000) pregunta!: string;
}

@Injectable()
export class AsesorService {
  /** Un análisis a la vez y una pregunta a la vez por conversación: dos clics no pagan dos veces. */
  private analizando = false;
  private respondiendo = new Set<number>();

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly metricas: MetricasService,
    private readonly resultados: ResultadosService,
    private readonly gastos: GastosService,
  ) {}

  private get fuentes(): Fuentes { return { metricas: this.metricas, resultados: this.resultados, gastos: this.gastos }; }

  /* ------------------------------ consumo y configuración ------------------------------ */

  private async config() {
    const [c] = await this.db.select().from(asesorConfig).where(eq(asesorConfig.id, 1)).limit(1);
    if (c) return c;
    const [n] = await this.db.insert(asesorConfig).values({ id: 1 }).onConflictDoNothing().returning();
    return n ?? (await this.db.select().from(asesorConfig).where(eq(asesorConfig.id, 1)).limit(1))[0];
  }

  /** Lo gastado en el mes (hora argentina), en USD. */
  private async gastadoMes() {
    const r = await this.db.execute(sql`select coalesce(sum(costo_usd), 0)::float8 as usd, count(*)::int as llamadas from asesor_usos
      where fecha >= (date_trunc('month', now() at time zone ${ZONA}) at time zone ${ZONA})`);
    const f: any = r.rows[0] ?? {};
    return { usd: Number(f.usd) || 0, llamadas: Number(f.llamadas) || 0 };
  }

  private async registrar(tarea: string, l: Llamada | null, ok: boolean, error = '', usuarioId: number | null = null) {
    await this.db.insert(asesorUsos).values({
      tarea, modelo: l?.modelo ?? MODELO_ASESOR(), ok, error: error.slice(0, 300), usuarioId,
      tokensEntrada: l?.uso.entrada ?? 0, tokensSalida: l?.uso.salida ?? 0,
      tokensCacheEscritura: l?.uso.cacheEscritura ?? 0, tokensCacheLectura: l?.uso.cacheLectura ?? 0, costoUsd: l?.costo ?? 0,
    });
  }

  private async puedeGastar() {
    const [c, g] = await Promise.all([this.config(), this.gastadoMes()]);
    return g.usd < c.topeMensualUsd;
  }

  async estado() {
    const [c, g, aprendizajes, [ultimo]] = await Promise.all([
      this.config(), this.gastadoMes(),
      this.db.select().from(asesorAprendizajes).orderBy(desc(asesorAprendizajes.activo), asc(asesorAprendizajes.id)),
      this.db.select({ id: asesorInformes.id, fecha: asesorInformes.fecha }).from(asesorInformes).orderBy(desc(asesorInformes.id)).limit(1),
    ]);
    return {
      configurado: IA.configurado, modelo: MODELO_ASESOR(), analizando: this.analizando,
      topeMensualUsd: c.topeMensualUsd, gastadoMesUsd: r6(g.usd), llamadasMes: g.llamadas,
      usoTopePct: c.topeMensualUsd > 0 ? Math.round((g.usd / c.topeMensualUsd) * 1000) / 10 : 100,
      avisoTope: c.topeMensualUsd <= 0 || g.usd >= c.topeMensualUsd * AVISO_TOPE,
      ficha: c.ficha, aprendizajes,
      ultimoInforme: ultimo ?? null,
    };
  }

  async guardarConfig(dto: ConfigDto) {
    const patch: Partial<typeof asesorConfig.$inferInsert> = { actualizadoEn: new Date() };
    if (dto.topeMensualUsd != null) patch.topeMensualUsd = Math.round(dto.topeMensualUsd * 100) / 100;
    if (dto.ficha != null) patch.ficha = dto.ficha.trim();
    await this.config();
    await this.db.update(asesorConfig).set(patch).where(eq(asesorConfig.id, 1));
    return this.estado();
  }

  /* ------------------------------ lo que sabe del negocio ------------------------------ */

  async agregarAprendizaje(dto: AprendizajeDto, usuarioId: number | null) {
    const texto = dto.texto.trim().replace(/\s+/g, ' ');
    if (texto.length < 5) throw new BadRequestException('Escribilo en una frase.');
    const [a] = await this.db.insert(asesorAprendizajes).values({ texto, usuarioId }).returning();
    return a;
  }

  async editarAprendizaje(id: number, dto: AprendizajeEditarDto) {
    const patch: any = {};
    if (dto.texto != null) {
      const t = dto.texto.trim().replace(/\s+/g, ' ');
      if (t.length < 5) throw new BadRequestException('Escribilo en una frase.');
      patch.texto = t;
    }
    if (dto.activo != null) patch.activo = dto.activo;
    const [a] = await this.db.update(asesorAprendizajes).set(patch).where(eq(asesorAprendizajes.id, id)).returning();
    if (!a) throw new NotFoundException('Eso ya no está.');
    return a;
  }

  async borrarAprendizaje(id: number) {
    await this.db.delete(asesorAprendizajes).where(eq(asesorAprendizajes.id, id));
    return { ok: true };
  }

  /** Lo que la IA recibe de lo que el dueño ya dijo: la ficha, lo confirmado y sus últimas opiniones. */
  private async contexto(): Promise<Contexto> {
    const [c, aps, ops] = await Promise.all([
      this.config(),
      this.db.select({ texto: asesorAprendizajes.texto }).from(asesorAprendizajes).where(eq(asesorAprendizajes.activo, true)).orderBy(asc(asesorAprendizajes.id)),
      this.db.select().from(asesorOpiniones).orderBy(desc(asesorOpiniones.fecha)).limit(40),
    ]);
    return {
      ficha: c.ficha,
      aprendizajes: aps.map((a) => a.texto),
      opiniones: ops.map((o) => ({ titulo: o.titulo, area: o.area, valor: o.valor, nota: o.nota, fecha: o.fecha.toISOString().slice(0, 10) })),
    };
  }

  /* ------------------------------ la foto y el análisis ------------------------------ */

  /** Lo que mira, sin IA: la foto y las señales (también para «Ver los números que mira»). */
  async foto() {
    const foto = await armarFoto(this.fuentes);
    const texto = JSON.stringify(foto);
    return { foto, senales: detectar(foto), tamano: { caracteres: texto.length, tokensAprox: Math.round(texto.length / 3.5) } };
  }

  /**
   * EL ANÁLISIS CORRE EN SEGUNDO PLANO: la IA tarda uno o dos minutos, más de lo
   * que espera una pantalla (y el dueño puede irse a otra y volver). Se arma la
   * foto en el momento, se guarda el informe «analizando» y se devuelve; cuando
   * la IA termina, el mismo informe pasa a «listo» (con su texto o su error). La
   * pantalla pregunta cada unos segundos.
   */
  async analizar(dto: AnalizarDto, usuarioId: number | null) {
    if (this.analizando) throw new ConflictException('Ya hay un análisis en curso: esperá a que termine.');
    this.analizando = true;
    let enSegundoPlano = false;
    try {
      const enfoque = String(dto.enfoque ?? '').trim();
      const { foto, senales } = await this.foto();
      let error = '';
      if (!IA.configurado) error = 'El asesor no está configurado: falta la clave de la IA (ANTHROPIC_API_KEY) en el servidor. Abajo están las señales que detectó el sistema.';
      else if (!(await this.puedeGastar())) error = 'Se llegó al tope de gasto del mes del asesor: abajo están las señales que detectó el sistema. Subí el tope en «Configuración» si querés el análisis.';
      const [fila] = await this.db.insert(asesorInformes).values({
        usuarioId, enfoque, foto: foto as any, senales: senales as any, informe: null, error, estado: error ? 'listo' : 'analizando',
      }).returning({ id: asesorInformes.id });
      if (!error) {
        enSegundoPlano = true;
        void this.completar(fila.id, { foto, senales, enfoque }, usuarioId);
      }
      return this.informe(fila.id);
    } finally {
      if (!enSegundoPlano) this.analizando = false;
    }
  }

  /** La parte lenta: la IA escribe y el informe pasa a «listo». Nunca tira: todo error queda en el informe. */
  private async completar(id: number, o: { foto: unknown; senales: unknown; enfoque: string }, usuarioId: number | null) {
    let informe: any = null; let error = ''; let llamada: Llamada | null = null;
    try {
      const r = await analizar({ ...o, contexto: await this.contexto() });
      informe = r.informe; llamada = r.llamada;
    } catch (e) {
      const ea = e instanceof ErrorAsesor ? e : new ErrorAsesor(String((e as Error)?.message ?? e));
      error = ea.message; llamada = ea.llamada;
    }
    try {
      await this.registrar('analisis', llamada, !error, error, usuarioId);
      await this.db.update(asesorInformes).set({ informe, error, estado: 'listo', modelo: llamada?.modelo ?? '', costoUsd: llamada?.costo ?? 0 })
        .where(eq(asesorInformes.id, id));
    } catch (e) {
      await this.db.update(asesorInformes).set({ estado: 'listo', error: `No se pudo guardar el análisis: ${String((e as Error)?.message ?? e).slice(0, 200)}` })
        .where(eq(asesorInformes.id, id)).catch(() => undefined);
    } finally {
      this.analizando = false;
    }
  }

  /**
   * Un análisis que quedó «analizando» más de 10 minutos se cortó (el servidor se
   * reinició a mitad de camino): queda como error, para no esperarlo para siempre.
   */
  private async cerrarColgados() {
    if (this.analizando) return;
    await this.db.update(asesorInformes).set({ estado: 'listo', error: 'El análisis se cortó (el servidor se reinició mientras la IA escribía). Probá de nuevo.' })
      .where(and(eq(asesorInformes.estado, 'analizando'), sql`${asesorInformes.fecha} < now() - interval '10 minutes'`));
  }

  async informes(limite = 30) {
    await this.cerrarColgados();
    const r = await this.db.execute(sql`select i.id, i.fecha, i.enfoque, i.error, i.estado, i.costo_usd as "costoUsd", i.modelo,
        i.informe->>'estado' as salud, i.informe->>'resumen' as resumen,
        coalesce(jsonb_array_length(i.informe->'alertas'), 0)::int as alertas, jsonb_array_length(i.senales)::int as senales
      from asesor_informes i order by i.id desc limit ${Math.min(Math.max(limite, 1), 100)}`);
    return r.rows;
  }

  async informe(id: number, conFoto = false) {
    await this.cerrarColgados();
    const [i] = await this.db.select().from(asesorInformes).where(eq(asesorInformes.id, id)).limit(1);
    if (!i) throw new NotFoundException('Ese análisis no existe.');
    const ops = await this.db.select().from(asesorOpiniones).where(eq(asesorOpiniones.informeId, id));
    const { foto, ...resto } = i;
    return {
      ...resto,
      opiniones: Object.fromEntries(ops.map((o) => [o.alerta, { valor: o.valor, nota: o.nota }])),
      ...(conFoto ? { foto } : { datosAl: (foto as any)?.contexto?.metricasAl ?? null }),
    };
  }

  async opinar(id: number, dto: OpinionDto, usuarioId: number | null) {
    const [i] = await this.db.select({ informe: asesorInformes.informe }).from(asesorInformes).where(eq(asesorInformes.id, id)).limit(1);
    const alerta = (i?.informe as any)?.alertas?.[dto.alerta];
    if (!alerta) throw new NotFoundException('Esa alerta no existe.');
    const valores = { titulo: String(alerta.titulo).slice(0, 300), area: String(alerta.area ?? ''), valor: dto.valor, nota: String(dto.nota ?? '').trim(), fecha: new Date(), usuarioId };
    await this.db.insert(asesorOpiniones).values({ informeId: id, alerta: dto.alerta, ...valores })
      .onConflictDoUpdate({ target: [asesorOpiniones.informeId, asesorOpiniones.alerta], set: valores });
    return { ok: true };
  }

  /* ------------------------------ las preguntas ------------------------------ */

  async conversaciones() {
    const r = await this.db.execute(sql`select c.id, c.titulo, c.creada_en as "creadaEn", c.actualizada_en as "actualizadaEn",
        (select count(*) from asesor_mensajes m where m.conversacion_id = c.id and m.rol = 'user' and m.texto <> '')::int as preguntas,
        (select coalesce(sum(m.costo_usd), 0) from asesor_mensajes m where m.conversacion_id = c.id)::float8 as "costoUsd"
      from asesor_conversaciones c order by c.actualizada_en desc limit 50`);
    return r.rows;
  }

  async conversacion(id: number) {
    const [c] = await this.db.select().from(asesorConversaciones).where(eq(asesorConversaciones.id, id)).limit(1);
    if (!c) throw new NotFoundException('Esa conversación no existe.');
    const ms = await this.db.select({ id: asesorMensajes.id, rol: asesorMensajes.rol, texto: asesorMensajes.texto, herramientas: asesorMensajes.herramientas, fecha: asesorMensajes.fecha, costoUsd: asesorMensajes.costoUsd })
      .from(asesorMensajes).where(eq(asesorMensajes.conversacionId, id)).orderBy(asc(asesorMensajes.id));
    /* Lo que se ve: las preguntas y las respuestas. Las vueltas de herramientas suman sus nombres a la respuesta que siguen. */
    const visibles: any[] = [];
    let usadas: string[] = []; let costo = 0;
    for (const m of ms) {
      costo += m.costoUsd;
      if (m.rol === 'assistant') usadas.push(...((m.herramientas as string[]) ?? []));
      if (!m.texto) continue;
      if (m.rol === 'user') visibles.push({ id: m.id, rol: 'user', texto: m.texto, fecha: m.fecha });
      else { visibles.push({ id: m.id, rol: 'assistant', texto: m.texto, fecha: m.fecha, herramientas: [...new Set(usadas)], costoUsd: r6(costo) }); usadas = []; costo = 0; }
    }
    return { ...c, mensajes: visibles };
  }

  async borrarConversacion(id: number) {
    await this.db.delete(asesorConversaciones).where(eq(asesorConversaciones.id, id));
    return { ok: true };
  }

  async preguntar(dto: PreguntaDto, usuarioId: number | null) {
    if (!IA.configurado) throw new BadRequestException('El asesor no está configurado: falta la clave de la IA (ANTHROPIC_API_KEY) en el servidor.');
    const pregunta = dto.pregunta.trim();
    if (pregunta.length < 3) throw new BadRequestException('Escribí la pregunta.');
    let convId = dto.conversacionId ?? null;
    if (convId) {
      const [c] = await this.db.select({ id: asesorConversaciones.id }).from(asesorConversaciones).where(eq(asesorConversaciones.id, convId)).limit(1);
      if (!c) throw new NotFoundException('Esa conversación no existe.');
      const [n] = await this.db.select({ n: sql<number>`count(*)::int` }).from(asesorMensajes)
        .where(and(eq(asesorMensajes.conversacionId, convId), eq(asesorMensajes.rol, 'user'), sql`${asesorMensajes.texto} <> ''`));
      if (Number(n?.n) >= MAX_PREGUNTAS) throw new BadRequestException(`Esta conversación ya tiene ${MAX_PREGUNTAS} preguntas: empezá una nueva (sale más barato y más preciso).`);
    }
    const clave = convId ?? -1;
    if (this.respondiendo.has(clave)) throw new ConflictException('Todavía está respondiendo la pregunta anterior.');
    this.respondiendo.add(clave);
    try {
      if (!(await this.puedeGastar())) throw new BadRequestException('Se llegó al tope de gasto del mes del asesor. Subilo en «Configuración» si querés seguir.');
      const historial: Anthropic.Beta.BetaMessageParam[] = convId
        ? (await this.db.select({ rol: asesorMensajes.rol, contenido: asesorMensajes.contenido }).from(asesorMensajes)
          .where(eq(asesorMensajes.conversacionId, convId)).orderBy(asc(asesorMensajes.id)))
          .map((m) => ({ role: m.rol as 'user' | 'assistant', content: m.contenido as any }))
        : [];
      const [ctx, [ultimo]] = await Promise.all([
        this.contexto(),
        this.db.select({ fecha: asesorInformes.fecha, informe: asesorInformes.informe }).from(asesorInformes)
          .where(sql`${asesorInformes.informe} is not null`).orderBy(desc(asesorInformes.id)).limit(1),
      ]);
      const sucs = await this.metricas.sucursales();
      const ui: any = ultimo?.informe;
      const resumenUltimo = ui ? `Del ${ultimo!.fecha.toISOString().slice(0, 10)}: ${ui.resumen}\nAlertas: ${(ui.alertas ?? []).map((a: any) => `[${a.prioridad}] ${a.titulo}`).join(' · ')}` : '';
      /* El sistema de la conversación se arma UNA vez (con la fecha del primer turno) para que el caché sirva entre preguntas. */
      let sistemaHoy = hoyAr();
      if (convId) {
        const [p] = await this.db.select({ fecha: asesorConversaciones.creadaEn }).from(asesorConversaciones).where(eq(asesorConversaciones.id, convId)).limit(1);
        if (p) sistemaHoy = p.fecha.toLocaleDateString('sv-SE', { timeZone: ZONA });
      }
      const sistema = sistemaPreguntas({ ...ctx, hoy: sistemaHoy, sucursales: sucs.map((s: any) => ({ id: Number(s.id), nombre: s.nombre })), ultimoInforme: resumenUltimo });
      /* Si la conversación viene de otro día, la fecha de hoy va en la pregunta (no en el sistema, para no romper el caché). */
      const pregHoy = sistemaHoy !== hoyAr() ? `(Hoy es ${hoyAr()}.) ${pregunta}` : pregunta;

      let error: ErrorAsesor | null = null;
      let turnos: Awaited<ReturnType<typeof responder>> = [];
      try {
        turnos = await responder({
          sistema, historial, pregunta: pregHoy,
          ejecutar: (nombre, input) => ejecutar(this.fuentes, nombre, input),
          puedeGastar: () => this.puedeGastar(),
          alLlamar: (l, ok, err) => this.registrar('pregunta', l, ok, err ?? '', usuarioId),
        });
      } catch (e) {
        error = e instanceof ErrorAsesor ? e : new ErrorAsesor(String((e as Error)?.message ?? e));
      }
      /* Una conversación a medias (error a mitad de las herramientas) no se guarda: la historia queda siempre completa. */
      const completos = !error && turnos.length && turnos[turnos.length - 1].rol === 'assistant';
      if (!completos) {
        if (error?.llamada) await this.registrar('pregunta', error.llamada, false, error.message, usuarioId);
        throw new BadRequestException(error?.message ?? 'La IA no terminó de responder: probá de nuevo.');
      }
      if (!convId) {
        const [c] = await this.db.insert(asesorConversaciones).values({ titulo: pregunta.slice(0, 120), usuarioId }).returning({ id: asesorConversaciones.id });
        convId = c.id;
      }
      await this.db.insert(asesorMensajes).values(turnos.map((t, i) => ({
        conversacionId: convId!, rol: t.rol, contenido: t.contenido as any,
        /* La primera es la pregunta tal cual la escribió el dueño (sin la nota de la fecha). */
        texto: i === 0 ? pregunta : t.texto, herramientas: t.herramientas as any, costoUsd: t.llamada?.costo ?? 0,
      })));
      await this.db.update(asesorConversaciones).set({ actualizadaEn: new Date() }).where(eq(asesorConversaciones.id, convId!));
      return this.conversacion(convId!);
    } finally {
      this.respondiendo.delete(clave);
    }
  }
}

@Controller('asesor')
@Permiso(PERMISO_ASESOR)
export class AsesorController {
  constructor(private readonly svc: AsesorService) {}

  @Get('estado') estado() { return this.svc.estado(); }
  @Patch('config') config(@Body() dto: ConfigDto) { return this.svc.guardarConfig(dto); }

  @Get('foto') foto() { return this.svc.foto(); }
  @Post('analizar') analizar(@Body() dto: AnalizarDto, @Auth() s: Sesion) { return this.svc.analizar(dto ?? {}, s?.usuarioId ?? null); }
  @Get('informes') informes(@Query('limite') limite?: string) { return this.svc.informes(Number(limite) || 30); }
  @Get('informes/:id') informe(@Param('id', ParseIntPipe) id: number, @Query('foto') foto?: string) { return this.svc.informe(id, foto === '1'); }
  @Put('informes/:id/opinion') opinar(@Param('id', ParseIntPipe) id: number, @Body() dto: OpinionDto, @Auth() s: Sesion) {
    return this.svc.opinar(id, dto, s?.usuarioId ?? null);
  }

  @Post('aprendizajes') agregar(@Body() dto: AprendizajeDto, @Auth() s: Sesion) { return this.svc.agregarAprendizaje(dto, s?.usuarioId ?? null); }
  @Patch('aprendizajes/:id') editar(@Param('id', ParseIntPipe) id: number, @Body() dto: AprendizajeEditarDto) { return this.svc.editarAprendizaje(id, dto); }
  @Delete('aprendizajes/:id') borrar(@Param('id', ParseIntPipe) id: number) { return this.svc.borrarAprendizaje(id); }

  @Get('conversaciones') conversaciones() { return this.svc.conversaciones(); }
  @Get('conversaciones/:id') conversacion(@Param('id', ParseIntPipe) id: number) { return this.svc.conversacion(id); }
  @Delete('conversaciones/:id') borrarConversacion(@Param('id', ParseIntPipe) id: number) { return this.svc.borrarConversacion(id); }
  @Post('preguntar') preguntar(@Body() dto: PreguntaDto, @Auth() s: Sesion) { return this.svc.preguntar(dto, s?.usuarioId ?? null); }
}

@Module({
  imports: [MetricasModule, ResultadosModule, GastosModule],
  controllers: [AsesorController],
  providers: [AsesorService],
})
export class AsesorModule {}
