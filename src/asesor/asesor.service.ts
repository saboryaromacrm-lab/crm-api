/**
 * LOS ASESORES · EL SERVICIO COMÚN (0193)
 * ============================================================================
 * Lo mismo para cada especialista (ver `nucleo/especialidad.ts`): el tope de
 * gasto, la ficha, lo que aprendió, el análisis en segundo plano, las
 * opiniones de las alertas y las conversaciones. Todo va filtrado por
 * especialidad: un especialista no ve ni toca lo del otro (y cada uno tiene su
 * propia llave de permiso en su controlador).
 *
 * Aprende de dos maneras: la FICHA que escribe el dueño y lo que él CONFIRMA
 * (aprendizajes), y las opiniones de cada alerta («Útil / No aplica / Ya lo
 * sé»), que viajan en cada análisis para no insistir con lo que no importa.
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type Anthropic from '@anthropic-ai/sdk';
import { DRIZZLE, type Database } from '../db/drizzle';
import {
  asesorAcciones, asesorAprendizajes, asesorConfig, asesorConversaciones, asesorInformes, asesorMensajes, asesorOpiniones, asesorUsos,
} from '../db/schema';
import { IA } from '../facturas/ia/anthropic';
import { hoyAr } from '../cafeteria/cuenta';
import { FUENTES, type Fuentes } from './datos';
import type { Especialidad, IdEspecialidad } from './nucleo/especialidad';
import { type Contexto, ErrorAsesor, type Llamada, MODELO_ASESOR, analizar, responder, sistemaPreguntas } from './nucleo/ia';

const ZONA = 'America/Argentina/Buenos_Aires';
const r6 = (n: number) => Math.round((Number(n) || 0) * 1_000_000) / 1_000_000;
/** Al 80 % del tope se avisa. */
const AVISO_TOPE = 0.8;
/** Preguntas por conversación: después conviene empezar otra (cada turno reenvía la historia). */
const MAX_PREGUNTAS = 30;

export class ConfigDto {
  @IsOptional() @IsNumber() @Min(0) @Max(1000) topeMensualUsd?: number;
  @IsOptional() @IsString() @MaxLength(8000) ficha?: string;
}
export class AnalizarDto {
  @IsOptional() @IsString() @MaxLength(400) enfoque?: string;
}
export class OpinionDto {
  @IsInt() @Min(0) @Max(50) alerta!: number;
  @IsIn(['util', 'no_aplica', 'ya_lo_se']) valor!: 'util' | 'no_aplica' | 'ya_lo_se';
  @IsOptional() @IsString() @MaxLength(300) nota?: string;
}
export class AprendizajeDto {
  @IsString() @MaxLength(400) texto!: string;
}
export class AprendizajeEditarDto {
  @IsOptional() @IsString() @MaxLength(400) texto?: string;
  @IsOptional() @IsBoolean() activo?: boolean;
}
export class PreguntaDto {
  @IsOptional() @IsInt() conversacionId?: number;
  @IsString() @MaxLength(2000) pregunta!: string;
}

@Injectable()
export class AsesorService {
  /** Un análisis a la vez por especialista y una pregunta a la vez por conversación: dos clics no pagan dos veces. */
  private analizando = new Set<IdEspecialidad>();
  private respondiendo = new Set<string>();

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(FUENTES) private readonly fuentes: Fuentes,
  ) {}

  /* ------------------------------ consumo y configuración ------------------------------ */

  private async config(esp: IdEspecialidad) {
    const [c] = await this.db.select().from(asesorConfig).where(eq(asesorConfig.especialidad, esp)).limit(1);
    if (c) return c;
    await this.db.insert(asesorConfig).values({ especialidad: esp }).onConflictDoNothing();
    return (await this.db.select().from(asesorConfig).where(eq(asesorConfig.especialidad, esp)).limit(1))[0];
  }

  /** Lo gastado en el mes (hora argentina) por este especialista, en USD. */
  private async gastadoMes(esp: IdEspecialidad) {
    const r = await this.db.execute(sql`select coalesce(sum(costo_usd), 0)::float8 as usd, count(*)::int as llamadas from asesor_usos
      where especialidad = ${esp} and fecha >= (date_trunc('month', now() at time zone ${ZONA}) at time zone ${ZONA})`);
    const f: any = r.rows[0] ?? {};
    return { usd: Number(f.usd) || 0, llamadas: Number(f.llamadas) || 0 };
  }

  private async registrar(esp: IdEspecialidad, tarea: string, l: Llamada | null, ok: boolean, error = '', usuarioId: number | null = null) {
    await this.db.insert(asesorUsos).values({
      especialidad: esp, tarea, modelo: l?.modelo ?? MODELO_ASESOR(), ok, error: error.slice(0, 300), usuarioId,
      tokensEntrada: l?.uso.entrada ?? 0, tokensSalida: l?.uso.salida ?? 0,
      tokensCacheEscritura: l?.uso.cacheEscritura ?? 0, tokensCacheLectura: l?.uso.cacheLectura ?? 0, costoUsd: l?.costo ?? 0,
    });
  }

  private async puedeGastar(esp: IdEspecialidad) {
    const [c, g] = await Promise.all([this.config(esp), this.gastadoMes(esp)]);
    return g.usd < c.topeMensualUsd;
  }

  async estado(esp: Especialidad) {
    const [c, g, aprendizajes, [ultimo]] = await Promise.all([
      this.config(esp.id), this.gastadoMes(esp.id),
      this.db.select().from(asesorAprendizajes).where(eq(asesorAprendizajes.especialidad, esp.id))
        .orderBy(desc(asesorAprendizajes.activo), asc(asesorAprendizajes.id)),
      this.db.select({ id: asesorInformes.id, fecha: asesorInformes.fecha }).from(asesorInformes)
        .where(eq(asesorInformes.especialidad, esp.id)).orderBy(desc(asesorInformes.id)).limit(1),
    ]);
    return {
      especialidad: esp.id, nombre: esp.nombre,
      configurado: IA.configurado, modelo: MODELO_ASESOR(), analizando: this.analizando.has(esp.id),
      topeMensualUsd: c.topeMensualUsd, gastadoMesUsd: r6(g.usd), llamadasMes: g.llamadas,
      usoTopePct: c.topeMensualUsd > 0 ? Math.round((g.usd / c.topeMensualUsd) * 1000) / 10 : 100,
      avisoTope: c.topeMensualUsd <= 0 || g.usd >= c.topeMensualUsd * AVISO_TOPE,
      ficha: c.ficha, aprendizajes,
      ultimoInforme: ultimo ?? null,
    };
  }

  async guardarConfig(esp: Especialidad, dto: ConfigDto) {
    const patch: Partial<typeof asesorConfig.$inferInsert> = { actualizadoEn: new Date() };
    if (dto.topeMensualUsd != null) patch.topeMensualUsd = Math.round(dto.topeMensualUsd * 100) / 100;
    if (dto.ficha != null) patch.ficha = dto.ficha.trim();
    await this.config(esp.id);
    await this.db.update(asesorConfig).set(patch).where(eq(asesorConfig.especialidad, esp.id));
    return this.estado(esp);
  }

  /* ------------------------------ lo que sabe del negocio ------------------------------ */

  private limpio(texto: string) {
    const t = texto.trim().replace(/\s+/g, ' ');
    if (t.length < 5) throw new BadRequestException('Escribilo en una frase.');
    return t;
  }

  async agregarAprendizaje(esp: Especialidad, dto: AprendizajeDto, usuarioId: number | null) {
    const [a] = await this.db.insert(asesorAprendizajes).values({ especialidad: esp.id, texto: this.limpio(dto.texto), usuarioId }).returning();
    return a;
  }

  async editarAprendizaje(esp: Especialidad, id: number, dto: AprendizajeEditarDto) {
    const patch: Partial<typeof asesorAprendizajes.$inferInsert> = {};
    if (dto.texto != null) patch.texto = this.limpio(dto.texto);
    if (dto.activo != null) patch.activo = dto.activo;
    const [a] = await this.db.update(asesorAprendizajes).set(patch)
      .where(and(eq(asesorAprendizajes.id, id), eq(asesorAprendizajes.especialidad, esp.id))).returning();
    if (!a) throw new NotFoundException('Eso ya no está.');
    return a;
  }

  async borrarAprendizaje(esp: Especialidad, id: number) {
    await this.db.delete(asesorAprendizajes).where(and(eq(asesorAprendizajes.id, id), eq(asesorAprendizajes.especialidad, esp.id)));
    return { ok: true };
  }

  /** Lo que la IA recibe de lo que el dueño ya dijo: su ficha (y la general), lo confirmado y sus últimas opiniones. */
  private async contexto(esp: IdEspecialidad): Promise<Contexto> {
    const [c, general, aps, ops] = await Promise.all([
      this.config(esp),
      esp === 'negocio' ? Promise.resolve(null) : this.config('negocio'),
      this.db.select({ texto: asesorAprendizajes.texto }).from(asesorAprendizajes)
        .where(and(eq(asesorAprendizajes.especialidad, esp), eq(asesorAprendizajes.activo, true))).orderBy(asc(asesorAprendizajes.id)),
      this.db.select({ titulo: asesorOpiniones.titulo, area: asesorOpiniones.area, valor: asesorOpiniones.valor, nota: asesorOpiniones.nota, fecha: asesorOpiniones.fecha })
        .from(asesorOpiniones).innerJoin(asesorInformes, eq(asesorInformes.id, asesorOpiniones.informeId))
        .where(eq(asesorInformes.especialidad, esp)).orderBy(desc(asesorOpiniones.fecha)).limit(40),
    ]);
    return {
      ficha: c.ficha, ...(general ? { fichaNegocio: general.ficha } : {}),
      aprendizajes: aps.map((a) => a.texto),
      opiniones: ops.map((o) => ({ titulo: o.titulo, area: o.area, valor: o.valor, nota: o.nota, fecha: o.fecha.toISOString().slice(0, 10) })),
    };
  }

  /* ------------------------------ la foto y el análisis ------------------------------ */

  /** Lo que mira, sin IA: la foto y las señales (también para «Ver los números que mira»). */
  async foto(esp: Especialidad) {
    const foto = await esp.armarFoto(this.fuentes);
    const texto = JSON.stringify(foto);
    return { foto, senales: esp.detectar(foto), tamano: { caracteres: texto.length, tokensAprox: Math.round(texto.length / 3.5) } };
  }

  /**
   * EL ANÁLISIS CORRE EN SEGUNDO PLANO: la IA tarda uno o dos minutos, más de lo
   * que espera una pantalla (y el dueño puede irse a otra y volver). Se arma la
   * foto en el momento, se guarda el informe «analizando» y se devuelve; cuando
   * la IA termina, el mismo informe pasa a «listo» (con su texto o su error). La
   * pantalla pregunta cada unos segundos.
   */
  async analizar(esp: Especialidad, dto: AnalizarDto, usuarioId: number | null) {
    if (this.analizando.has(esp.id)) throw new ConflictException('Ya hay un análisis en curso: esperá a que termine.');
    this.analizando.add(esp.id);
    let enSegundoPlano = false;
    try {
      const enfoque = String(dto.enfoque ?? '').trim();
      const { foto, senales } = await this.foto(esp);
      let error = '';
      if (!IA.configurado) error = 'El asesor no está configurado: falta la clave de la IA (ANTHROPIC_API_KEY) en el servidor. Abajo están las señales que detectó el sistema.';
      else if (!(await this.puedeGastar(esp.id))) error = 'Se llegó al tope de gasto del mes de este asesor: abajo están las señales que detectó el sistema. Subí el tope en «Configuración» si querés el análisis.';
      const [fila] = await this.db.insert(asesorInformes).values({
        especialidad: esp.id, usuarioId, enfoque, foto: foto as any, senales: senales as any, informe: null, error, estado: error ? 'listo' : 'analizando',
      }).returning({ id: asesorInformes.id });
      if (!error) {
        enSegundoPlano = true;
        void this.completar(esp, fila.id, { foto, senales, enfoque }, usuarioId);
      }
      return this.informe(esp, fila.id);
    } finally {
      if (!enSegundoPlano) this.analizando.delete(esp.id);
    }
  }

  /** La parte lenta: la IA escribe y el informe pasa a «listo». Nunca tira: todo error queda en el informe. */
  private async completar(esp: Especialidad, id: number, o: { foto: unknown; senales: unknown; enfoque: string }, usuarioId: number | null) {
    let informe: any = null; let error = ''; let llamada: Llamada | null = null;
    try {
      const r = await analizar(esp, { ...o, contexto: await this.contexto(esp.id) });
      llamada = r.llamada;
      informe = esp.enriquecer ? await esp.enriquecer(r.informe, this.fuentes) : r.informe;
    } catch (e) {
      const ea = e instanceof ErrorAsesor ? e : new ErrorAsesor(String((e as Error)?.message ?? e));
      error = ea.message; llamada = ea.llamada;
    }
    try {
      await this.registrar(esp.id, 'analisis', llamada, !error, error, usuarioId);
      await this.db.update(asesorInformes).set({ informe, error, estado: 'listo', modelo: llamada?.modelo ?? '', costoUsd: llamada?.costo ?? 0 })
        .where(eq(asesorInformes.id, id));
    } catch (e) {
      await this.db.update(asesorInformes).set({ estado: 'listo', error: `No se pudo guardar el análisis: ${String((e as Error)?.message ?? e).slice(0, 200)}` })
        .where(eq(asesorInformes.id, id)).catch(() => undefined);
    } finally {
      this.analizando.delete(esp.id);
    }
  }

  /**
   * Un análisis que quedó «analizando» más de 10 minutos se cortó (el servidor se
   * reinició a mitad de camino): queda como error, para no esperarlo para siempre.
   */
  private async cerrarColgados(esp: IdEspecialidad) {
    if (this.analizando.has(esp)) return;
    await this.db.update(asesorInformes).set({ estado: 'listo', error: 'El análisis se cortó (el servidor se reinició mientras la IA escribía). Probá de nuevo.' })
      .where(and(eq(asesorInformes.especialidad, esp), eq(asesorInformes.estado, 'analizando'), sql`${asesorInformes.fecha} < now() - interval '10 minutes'`));
  }

  async informes(esp: Especialidad, limite = 30) {
    await this.cerrarColgados(esp.id);
    const r = await this.db.execute(sql`select i.id, i.fecha, i.enfoque, i.error, i.estado, i.costo_usd as "costoUsd", i.modelo,
        i.informe->>'estado' as salud, i.informe->>'resumen' as resumen,
        coalesce(jsonb_array_length(i.informe->'alertas'), 0)::int as alertas, jsonb_array_length(i.senales)::int as senales
      from asesor_informes i where i.especialidad = ${esp.id} order by i.id desc limit ${Math.min(Math.max(limite, 1), 100)}`);
    return r.rows;
  }

  /** Un informe de ESTE especialista (otro id → no existe). */
  async informe(esp: Especialidad, id: number, conFoto = false) {
    await this.cerrarColgados(esp.id);
    const [i] = await this.db.select().from(asesorInformes)
      .where(and(eq(asesorInformes.id, id), eq(asesorInformes.especialidad, esp.id))).limit(1);
    if (!i) throw new NotFoundException('Ese análisis no existe.');
    const [ops, acs] = await Promise.all([
      this.db.select().from(asesorOpiniones).where(eq(asesorOpiniones.informeId, id)),
      this.db.select().from(asesorAcciones).where(eq(asesorAcciones.informeId, id)),
    ]);
    const { foto, ...resto } = i;
    return {
      ...resto,
      opiniones: Object.fromEntries(ops.map((o) => [o.alerta, { valor: o.valor, nota: o.nota }])),
      acciones: Object.fromEntries(acs.map((a) => [a.propuesta, { ofertaId: a.ofertaId, fecha: a.fecha }])),
      ...(conFoto ? { foto } : { datosAl: (foto as any)?.contexto?.metricasAl ?? null }),
    };
  }

  async opinar(esp: Especialidad, id: number, dto: OpinionDto, usuarioId: number | null) {
    const [i] = await this.db.select({ informe: asesorInformes.informe }).from(asesorInformes)
      .where(and(eq(asesorInformes.id, id), eq(asesorInformes.especialidad, esp.id))).limit(1);
    const alerta = (i?.informe as any)?.alertas?.[dto.alerta];
    if (!alerta) throw new NotFoundException('Esa alerta no existe.');
    const valores = { titulo: String(alerta.titulo).slice(0, 300), area: String(alerta.area ?? ''), valor: dto.valor, nota: String(dto.nota ?? '').trim(), fecha: new Date(), usuarioId };
    await this.db.insert(asesorOpiniones).values({ informeId: id, alerta: dto.alerta, ...valores })
      .onConflictDoUpdate({ target: [asesorOpiniones.informeId, asesorOpiniones.alerta], set: valores });
    return { ok: true };
  }

  /* ------------------------------ las preguntas ------------------------------ */

  async conversaciones(esp: Especialidad) {
    const r = await this.db.execute(sql`select c.id, c.titulo, c.creada_en as "creadaEn", c.actualizada_en as "actualizadaEn",
        (select count(*) from asesor_mensajes m where m.conversacion_id = c.id and m.rol = 'user' and m.texto <> '')::int as preguntas,
        (select coalesce(sum(m.costo_usd), 0) from asesor_mensajes m where m.conversacion_id = c.id)::float8 as "costoUsd"
      from asesor_conversaciones c where c.especialidad = ${esp.id} order by c.actualizada_en desc limit 50`);
    return r.rows;
  }

  private async conversacionDe(esp: IdEspecialidad, id: number) {
    const [c] = await this.db.select().from(asesorConversaciones)
      .where(and(eq(asesorConversaciones.id, id), eq(asesorConversaciones.especialidad, esp))).limit(1);
    if (!c) throw new NotFoundException('Esa conversación no existe.');
    return c;
  }

  async conversacion(esp: Especialidad, id: number) {
    const c = await this.conversacionDe(esp.id, id);
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

  async borrarConversacion(esp: Especialidad, id: number) {
    await this.db.delete(asesorConversaciones).where(and(eq(asesorConversaciones.id, id), eq(asesorConversaciones.especialidad, esp.id)));
    return { ok: true };
  }

  async preguntar(esp: Especialidad, dto: PreguntaDto, usuarioId: number | null) {
    if (!IA.configurado) throw new BadRequestException('El asesor no está configurado: falta la clave de la IA (ANTHROPIC_API_KEY) en el servidor.');
    const pregunta = dto.pregunta.trim();
    if (pregunta.length < 3) throw new BadRequestException('Escribí la pregunta.');
    let convId = dto.conversacionId ?? null;
    let creada: Date | null = null;
    if (convId) {
      creada = (await this.conversacionDe(esp.id, convId)).creadaEn;
      const [n] = await this.db.select({ n: sql<number>`count(*)::int` }).from(asesorMensajes)
        .where(and(eq(asesorMensajes.conversacionId, convId), eq(asesorMensajes.rol, 'user'), sql`${asesorMensajes.texto} <> ''`));
      if (Number(n?.n) >= MAX_PREGUNTAS) throw new BadRequestException(`Esta conversación ya tiene ${MAX_PREGUNTAS} preguntas: empezá una nueva (sale más barato y más preciso).`);
    }
    const clave = `${esp.id}:${convId ?? 'nueva'}`;
    if (this.respondiendo.has(clave)) throw new ConflictException('Todavía está respondiendo la pregunta anterior.');
    this.respondiendo.add(clave);
    try {
      if (!(await this.puedeGastar(esp.id))) throw new BadRequestException('Se llegó al tope de gasto del mes de este asesor. Subilo en «Configuración» si querés seguir.');
      const historial: Anthropic.Beta.BetaMessageParam[] = convId
        ? (await this.db.select({ rol: asesorMensajes.rol, contenido: asesorMensajes.contenido }).from(asesorMensajes)
          .where(eq(asesorMensajes.conversacionId, convId)).orderBy(asc(asesorMensajes.id)))
          .map((m) => ({ role: m.rol as 'user' | 'assistant', content: m.contenido as any }))
        : [];
      const [ctx, [ultimo], sucs] = await Promise.all([
        this.contexto(esp.id),
        this.db.select({ fecha: asesorInformes.fecha, informe: asesorInformes.informe }).from(asesorInformes)
          .where(and(eq(asesorInformes.especialidad, esp.id), sql`${asesorInformes.informe} is not null`)).orderBy(desc(asesorInformes.id)).limit(1),
        this.fuentes.metricas.sucursales(),
      ]);
      const resumenUltimo = ultimo ? `Del ${ultimo.fecha.toISOString().slice(0, 10)}: ${esp.resumirInforme(ultimo.informe)}` : '';
      /* El sistema se arma con la fecha del primer turno, para que el caché sirva entre preguntas;
       * si la conversación viene de otro día, la fecha de hoy va en la pregunta. */
      const hoy = hoyAr();
      const sistemaHoy = creada ? creada.toLocaleDateString('sv-SE', { timeZone: ZONA }) : hoy;
      const sistema = sistemaPreguntas(esp, { ...ctx, hoy: sistemaHoy, sucursales: sucs.map((s: any) => ({ id: Number(s.id), nombre: s.nombre })), ultimoInforme: resumenUltimo });
      const pregHoy = sistemaHoy !== hoy ? `(Hoy es ${hoy}.) ${pregunta}` : pregunta;

      let error: ErrorAsesor | null = null;
      let turnos: Awaited<ReturnType<typeof responder>> = [];
      try {
        turnos = await responder({
          sistema, herramientas: esp.herramientas, historial, pregunta: pregHoy,
          ejecutar: (nombre, input) => esp.ejecutar(this.fuentes, nombre, input),
          puedeGastar: () => this.puedeGastar(esp.id),
          alLlamar: (l, ok, err) => this.registrar(esp.id, 'pregunta', l, ok, err ?? '', usuarioId),
        });
      } catch (e) {
        error = e instanceof ErrorAsesor ? e : new ErrorAsesor(String((e as Error)?.message ?? e));
      }
      /* Una conversación a medias (error a mitad de las herramientas) no se guarda: la historia queda siempre completa. */
      if (error || !turnos.length || turnos[turnos.length - 1].rol !== 'assistant') {
        if (error?.llamada) await this.registrar(esp.id, 'pregunta', error.llamada, false, error.message, usuarioId);
        throw new BadRequestException(error?.message ?? 'La IA no terminó de responder: probá de nuevo.');
      }
      if (!convId) {
        const [c] = await this.db.insert(asesorConversaciones).values({ especialidad: esp.id, titulo: pregunta.slice(0, 120), usuarioId })
          .returning({ id: asesorConversaciones.id });
        convId = c.id;
      }
      await this.db.insert(asesorMensajes).values(turnos.map((t, i) => ({
        conversacionId: convId!, rol: t.rol, contenido: t.contenido as any,
        /* La primera es la pregunta tal cual la escribió el dueño (sin la nota de la fecha). */
        texto: i === 0 ? pregunta : t.texto, herramientas: t.herramientas as any, costoUsd: t.llamada?.costo ?? 0,
      })));
      await this.db.update(asesorConversaciones).set({ actualizadaEn: new Date() }).where(eq(asesorConversaciones.id, convId!));
      return this.conversacion(esp, convId!);
    } finally {
      this.respondiendo.delete(clave);
    }
  }
}
