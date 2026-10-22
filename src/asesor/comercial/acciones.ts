/**
 * ASESOR COMERCIAL · LO QUE SE HACE CON UNA PROPUESTA (0193)
 * ============================================================================
 * «Crear»: la propuesta se vuelve una oferta DESACTIVADA en Ventas › Ofertas,
 * con todo cargado; el dueño (o quien tenga permiso de ofertas) la revisa y la
 * activa. Nunca se activa sola. Se crea UNA vez: la acción se reserva antes de
 * crear (índice único), así dos clics no hacen dos ofertas.
 *
 * Y las fechas propias del dueño (las que el calendario no conoce).
 */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/drizzle';
import { asesorAcciones, asesorFechas, asesorInformes, presentaciones, productos } from '../../db/schema';
import type { OfertasService } from '../../ofertas/ofertas.module';
import { tienePermiso } from '../../auth/auth.guard';
import type { Sesion } from '../../auth/auth.decoradores';
import { promoDe } from '../herramientas';
import { diaValido } from '../datos';

const esUnico = (e: any) => e?.code === '23505' || e?.cause?.code === '23505';
/** Quién puede crear ofertas: las mismas llaves que Ventas › Ofertas. */
const PERMISOS_OFERTAS = ['ventas.ofertas', 'ofertas'];

export async function crearOfertaDePropuesta(db: Database, ofertas: OfertasService, informeId: number, indice: number, sesion: Sesion) {
  if (!tienePermiso(sesion?.permisos ?? [], PERMISOS_OFERTAS)) throw new ForbiddenException('Crear la oferta necesita el permiso de Ofertas.');
  const [i] = await db.select({ informe: asesorInformes.informe }).from(asesorInformes)
    .where(and(eq(asesorInformes.id, informeId), eq(asesorInformes.especialidad, 'comercial'))).limit(1);
  const p = (i?.informe as any)?.propuestas?.[indice];
  if (!p) throw new NotFoundException('Esa propuesta no existe.');
  const promo = promoDe(p);
  if (promo.tipo !== 'ticket' && !promo.productos.length) throw new BadRequestException('La propuesta no tiene productos con su id: cargala a mano en Ventas › Ofertas.');

  /* Los artículos tienen que existir (y el paquete ser de ese producto): nada se crea por adivinar. */
  const ids = [...new Set(promo.productos.map((x) => x.productoId))];
  const presIds = promo.productos.map((x) => x.presentacionId).filter((x) => x > 0);
  const ps = ids.length ? await db.select({ id: productos.id, estado: productos.estado }).from(productos).where(inArray(productos.id, ids)) : [];
  const prs = presIds.length ? await db.select({ id: presentaciones.id, productoId: presentaciones.productoId }).from(presentaciones).where(inArray(presentaciones.id, presIds)) : [];
  for (const x of promo.productos) {
    const prod = ps.find((y) => y.id === x.productoId);
    if (!prod || prod.estado === 'archivado') throw new BadRequestException(`El producto #${x.productoId} no existe o está archivado.`);
    if (x.presentacionId > 0 && prs.find((y) => y.id === x.presentacionId)?.productoId !== x.productoId) {
      throw new BadRequestException(`El paquete #${x.presentacionId} no es del producto #${x.productoId}.`);
    }
  }

  /* La reserva: si ya está (otro clic, otra pestaña), no se crea de nuevo. */
  try {
    await db.insert(asesorAcciones).values({ informeId, propuesta: indice, usuarioId: sesion?.usuarioId ?? null });
  } catch (e) {
    if (esUnico(e)) throw new ConflictException('Esa propuesta ya se creó como oferta.');
    throw e;
  }
  try {
    const sucursales = (Array.isArray(p.sucursales) ? p.sucursales : []).map((x: any) => Math.trunc(Number(x))).filter((x: number) => x > 0);
    const dto: any = {
      nombre: String(p.titulo ?? '').trim().slice(0, 80) || 'Promoción del asesor',
      tipo: promo.tipo, porcentaje: promo.porcentaje, precio: promo.precioFinal, lleva: promo.lleva, paga: promo.paga, montoMinimo: promo.montoMinimo,
      ...(diaValido(p.desde) ? { desde: `${p.desde}T00:00:00-03:00` } : {}),
      ...(diaValido(p.hasta) && (!diaValido(p.desde) || p.hasta >= p.desde) ? { hasta: `${p.hasta}T23:59:59-03:00` } : {}),
      dias: /^[01]{7}$/.test(p.dias ?? '') && p.dias !== '0000000' ? p.dias : '',
      sucursales: sucursales.join(','), listas: '', mediosPago: '',
      incluyeFraccionados: false, porVencer: p.objetivo === 'vencimiento',
      /* NUNCA activa: la revisa y la activa una persona. */
      activa: false,
      ...(promo.tipo === 'combo'
        ? { componentes: promo.productos.map((x) => ({ productoId: x.productoId, cantidad: x.cantidad })) }
        : promo.tipo === 'ticket' ? {}
          : { alcances: promo.productos.map((x) => (x.presentacionId > 0 ? { tipo: 'presentacion', refId: x.presentacionId } : { tipo: 'producto', refId: x.productoId })) }),
    };
    const o: any = await ofertas.crear(dto, sesion?.usuarioId ?? null);
    const ofertaId = Number(o?.id ?? o);
    await db.update(asesorAcciones).set({ ofertaId: Number.isFinite(ofertaId) ? ofertaId : null })
      .where(and(eq(asesorAcciones.informeId, informeId), eq(asesorAcciones.propuesta, indice)));
    return { ok: true, ofertaId };
  } catch (e) {
    /* Si la oferta no se pudo crear, la reserva se libera: se puede corregir y reintentar. */
    await db.delete(asesorAcciones).where(and(eq(asesorAcciones.informeId, informeId), eq(asesorAcciones.propuesta, indice)));
    throw e;
  }
}

/* ============================== FECHAS PROPIAS ============================== */

export class FechaDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'La fecha va como AAAA-MM-DD.' }) fecha!: string;
  @IsString() @MaxLength(80) nombre!: string;
  @IsOptional() @IsString() @MaxLength(300) nota?: string;
  @IsOptional() @IsBoolean() anual?: boolean;
}

export const listarFechas = (db: Database) => db.select().from(asesorFechas).orderBy(asc(asesorFechas.fecha));

export async function agregarFecha(db: Database, dto: FechaDto, usuarioId: number | null) {
  if (!diaValido(dto.fecha)) throw new BadRequestException('Esa fecha no existe.');
  const nombre = dto.nombre.trim();
  if (nombre.length < 3) throw new BadRequestException('Poné el nombre de la fecha.');
  const [f] = await db.insert(asesorFechas).values({ fecha: dto.fecha, nombre, nota: String(dto.nota ?? '').trim(), anual: dto.anual ?? true, usuarioId }).returning();
  return f;
}

export async function borrarFecha(db: Database, id: number) {
  await db.delete(asesorFechas).where(eq(asesorFechas.id, id));
  return { ok: true };
}
