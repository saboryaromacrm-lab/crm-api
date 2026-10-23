/**
 * LINKS MEDIBLES DE LA TIENDA (0195, 23/10/2026, pedido del dueño: «crear un
 * link, compartirlo y ver qué alcance tiene; que quede todo registrado»).
 * ============================================================================
 * El link que se comparte es `<tienda>/l/<codigo>`: la tienda pide acá a dónde
 * lleva y en qué modo, deja el modo elegido y redirige a la página con
 * `?l=<codigo>` (y `utm_source=<canal>`, para «De dónde llegan»). La visita la
 * registra el NAVEGADOR en la `llegada` de su sesión (`web_eventos.link_id`):
 * las vistas previas de WhatsApp o Instagram no ejecutan nada y no cuentan.
 *
 * Lo que hizo cada visitante sale de su sesión: páginas vistas, si cargó el
 * carrito y los pedidos que mandó (el evento `pedido` trae el código del
 * pedido, y de ahí su total). Todo con quién creó el link y cuándo.
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { webLinks } from '../db/schema';
import type { ModoTienda } from './metricas-tienda';
import { ZONA_AR } from '../cafeteria/cuenta';
import { CANALES, type Canal } from './origen-llegada';

export const CANALES_LINK = ['whatsapp', 'instagram', 'facebook', 'tiktok', 'email', 'otro'] as const;
const ALFABETO = 'abcdefghjkmnpqrstuvwxyz23456789';
const N = (x: unknown) => Number(x ?? 0) || 0;
const filas = (r: any): any[] => r.rows ?? r;

/** Seis letras y números sin los que se confunden (0/o, 1/l/i): se dicta y se tipea bien. */
export const codigoNuevo = () => Array.from({ length: 6 }, () => ALFABETO[randomInt(ALFABETO.length)]).join('');

/**
 * A dónde lleva: SOLO una página de la tienda. De una dirección pegada entera se
 * toma el camino y la consulta (sin `l` ni `utm_*`, que los pone el link); nada
 * que salga del sitio. null = no es una página válida.
 */
export function destinoValido(v: unknown): string | null {
  let s = String(v ?? '').trim();
  if (!s) return '/';
  if (/^https?:\/\//i.test(s)) {
    try { const u = new URL(s); s = u.pathname + u.search; } catch { return null; }
  }
  if (!s.startsWith('/') || s.startsWith('//') || s.length > 300) return null;
  const [camino, consulta = ''] = s.split('?');
  const q = new URLSearchParams(consulta);
  for (const k of [...q.keys()]) if (k === 'l' || k.startsWith('utm_')) q.delete(k);
  const resto = q.toString();
  return resto ? `${camino}?${resto}` : camino;
}

export class LinkDto {
  @IsString() @MaxLength(80) nombre!: string;
  @IsIn(['mayorista', 'minorista']) modo!: ModoTienda;
  @IsOptional() @IsString() @MaxLength(400) destino?: string;
  @IsOptional() @IsIn([...CANALES_LINK, '']) canal?: string;
}

export class EditarLinkDto {
  @IsOptional() @IsString() @MaxLength(80) nombre?: string;
  @IsOptional() @IsBoolean() activo?: boolean;
}

@Injectable()
export class LinksTiendaService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Los links del modo con su alcance (desde que existen): visitantes, páginas
   * vistas, cuántos cargaron el carrito, cuántos pidieron, los pedidos (sin los
   * rechazados) y su plata, y la primera y última visita.
   */
  async listar(modo: ModoTienda) {
    const r = await this.db.execute(sql`
      WITH ll AS (
        SELECT DISTINCT ON (sesion) sesion, link_id, fecha FROM web_eventos
         WHERE tipo = 'llegada' AND link_id IS NOT NULL ORDER BY sesion, fecha),
      act AS (
        SELECT e.sesion, count(*) FILTER (WHERE e.tipo = 'vista_pagina') AS vistas,
               bool_or(e.tipo = 'agregar_carrito') AS carrito,
               array_agg(e.ruta) FILTER (WHERE e.tipo = 'pedido') AS pedidos
          FROM web_eventos e WHERE e.sesion IN (SELECT sesion FROM ll) GROUP BY 1),
      vis AS (
        SELECT ll.link_id, count(*) AS visitantes, coalesce(sum(act.vistas), 0) AS vistas,
               count(*) FILTER (WHERE act.carrito) AS carrito, count(*) FILTER (WHERE act.pedidos IS NOT NULL) AS pidieron,
               min(ll.fecha) AS primera, max(ll.fecha) AS ultima
          FROM ll LEFT JOIN act USING (sesion) GROUP BY 1),
      ped AS (
        SELECT ll.link_id, count(DISTINCT p.id) AS pedidos, coalesce(sum(p.total), 0) AS total
          FROM ll JOIN act USING (sesion) CROSS JOIN LATERAL unnest(act.pedidos) AS c(codigo)
          JOIN presupuestos p ON p.codigo = c.codigo AND p.origen = 'web' AND p.estado <> 'cancelado'
         GROUP BY 1)
      SELECT l.id, l.codigo, l.nombre, l.modo, l.destino, l.canal, l.activo, l.creado_en, u.nombre AS creado_por,
             coalesce(vis.visitantes, 0) AS visitantes, coalesce(vis.vistas, 0) AS vistas, coalesce(vis.carrito, 0) AS carrito,
             coalesce(vis.pidieron, 0) AS pidieron, coalesce(ped.pedidos, 0) AS pedidos, coalesce(ped.total, 0) AS total,
             vis.primera, vis.ultima
        FROM web_links l
        LEFT JOIN usuarios u ON u.id = l.usuario_id
        LEFT JOIN vis ON vis.link_id = l.id
        LEFT JOIN ped ON ped.link_id = l.id
       WHERE l.modo = ${modo}
       ORDER BY l.activo DESC, l.creado_en DESC`);
    return filas(r).map((x) => ({
      id: N(x.id), codigo: String(x.codigo), nombre: String(x.nombre), modo: x.modo, destino: String(x.destino),
      canal: String(x.canal), activo: !!x.activo, creadoEn: x.creado_en, creadoPor: x.creado_por ?? '',
      visitantes: N(x.visitantes), vistas: N(x.vistas), carrito: N(x.carrito), pidieron: N(x.pidieron),
      pedidos: N(x.pedidos), total: Math.round(N(x.total) * 100) / 100,
      conversion: N(x.visitantes) ? Math.round((N(x.pidieron) / N(x.visitantes)) * 10000) / 100 : null,
      primera: x.primera ?? null, ultima: x.ultima ?? null,
    }));
  }

  /** El día a día de un link (desde que existe) y por dónde llegaron sus visitantes. */
  async detalle(id: number) {
    const [link] = await this.db.select({ id: webLinks.id }).from(webLinks).where(eq(webLinks.id, id)).limit(1);
    if (!link) throw new NotFoundException('Ese link no existe.');
    const [porDia, porOrigen] = await Promise.all([
      this.db.execute(sql`
        SELECT (fecha AT TIME ZONE ${ZONA_AR})::date::text AS dia, count(DISTINCT sesion) AS visitantes
          FROM web_eventos WHERE tipo = 'llegada' AND link_id = ${id} GROUP BY 1 ORDER BY 1`),
      this.db.execute(sql`
        SELECT coalesce(origen, 'directo') AS origen, count(DISTINCT sesion) AS visitantes
          FROM web_eventos WHERE tipo = 'llegada' AND link_id = ${id} GROUP BY 1 ORDER BY 2 DESC`),
    ]);
    return {
      porDia: filas(porDia).map((x) => ({ dia: String(x.dia), visitantes: N(x.visitantes) })),
      porOrigen: filas(porOrigen).map((x) => ({ origen: String(x.origen), nombre: CANALES[x.origen as Canal] ?? String(x.origen), visitantes: N(x.visitantes) })),
    };
  }

  async crear(dto: LinkDto, usuarioId: number | null) {
    const nombre = dto.nombre.trim();
    if (nombre.length < 2) throw new BadRequestException('Ponele un nombre al link (para reconocerlo después).');
    const destino = destinoValido(dto.destino);
    if (destino == null) throw new BadRequestException('A dónde lleva tiene que ser una página de la tienda (por ejemplo /tienda?oferta=1).');
    /* El código es único: ante el (rarísimo) choque se prueba otro. */
    for (let intento = 0; intento < 5; intento += 1) {
      const [l] = await this.db.insert(webLinks)
        .values({ codigo: codigoNuevo(), nombre, modo: dto.modo, destino, canal: dto.canal ?? '', usuarioId })
        .onConflictDoNothing({ target: webLinks.codigo }).returning();
      if (l) return l;
    }
    throw new BadRequestException('No se pudo generar el código del link: probá de nuevo.');
  }

  async editar(id: number, dto: EditarLinkDto) {
    const cambios: Partial<typeof webLinks.$inferInsert> = {};
    if (dto.nombre !== undefined) {
      if (dto.nombre.trim().length < 2) throw new BadRequestException('El nombre no puede quedar vacío.');
      cambios.nombre = dto.nombre.trim();
    }
    if (dto.activo !== undefined) cambios.activo = dto.activo;
    if (!Object.keys(cambios).length) throw new BadRequestException('No hay nada para cambiar.');
    const [l] = await this.db.update(webLinks).set(cambios).where(eq(webLinks.id, id)).returning();
    if (!l) throw new NotFoundException('Ese link no existe.');
    return l;
  }

  /** Para la tienda (público): a dónde lleva un código activo, o null. */
  async resolver(codigo: string) {
    const [l] = await this.db.select({ id: webLinks.id, modo: webLinks.modo, destino: webLinks.destino, canal: webLinks.canal })
      .from(webLinks).where(sql`${webLinks.codigo} = ${String(codigo).toLowerCase()} AND ${webLinks.activo}`).limit(1);
    return l ?? null;
  }
}
