/**
 * QUIÉN ESTUVO EN LA CAJA DE CADA TURNO (0229, 16/11/2026, pedido del dueño)
 * ============================================================================
 * «En el cierre queda registrado el que abrió nomás»: el sábado en Fontana
 * abrió Cristian y cerró Daniela, y todo quedó a nombre de Cristian. Desde acá:
 *
 *  · el que abre es el primer cajero (`caja_sesiones.usuario_id`);
 *  · CAMBIO DE CAJERO: el que entra en la PC de la caja (una terminal
 *    registrada) con OTRO usuario mientras el turno está abierto toma la caja
 *    —«cierran su usuario y vuelve a abrir el que releva»—; también el relevo
 *    con PIN sin cambiar de sesión (0088). Solo la PC de la caja: el dueño que
 *    entra a mirar desde su casa no está en la caja;
 *  · el que cierra se elige al cerrar y firma con la contraseña con la que
 *    entra al sistema (`cerrado_por`).
 */
import { BadRequestException } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/drizzle';
import { cajaCajeros, cajaSesiones, roles, usuarios } from '../db/schema';
import { conPermisosBase } from '../auth/permisos-base';
import { rolCruzaSucursales } from '../auth/modo-sucursal';

type Rol = { clave?: string | null; permisos?: unknown; modoSucursal?: string | null } | null | undefined;

/** Atiende la caja quien tiene la llave de la caja (o el comodín). */
export function atiendeCaja(rol: Rol): boolean {
  const p = conPermisosBase(Array.isArray(rol?.permisos) ? (rol!.permisos as string[]) : [], rol?.clave ?? '');
  return p.includes('*') || p.includes('ventas.caja');
}

/** Quién está en la caja ahora: el último que la tomó o, si nadie, el que abrió. */
async function cajeroActual(db: Database, turno: { id: number; usuarioId: number | null }) {
  const [u] = await db.select({ usuarioId: cajaCajeros.usuarioId }).from(cajaCajeros)
    .where(eq(cajaCajeros.cajaSesionId, turno.id)).orderBy(desc(cajaCajeros.id)).limit(1);
  return u ? u.usuarioId : turno.usuarioId;
}

/**
 * `usuarioId` toma la caja del turno abierto. No deja rastro si ya era él (un
 * re-ingreso del mismo cajero no es un cambio). El turno tiene que estar
 * abierto y, si viene `sucursalId`, ser de esa sucursal.
 */
export async function registrarCajero(db: Database, o: {
  cajaSesionId: number; usuarioId: number; origen: 'ingreso' | 'relevo'; sucursalId?: number | null; terminalId?: number | null;
}) {
  const [turno] = await db.select({ id: cajaSesiones.id, usuarioId: cajaSesiones.usuarioId, estado: cajaSesiones.estado, sucursalId: cajaSesiones.sucursalId })
    .from(cajaSesiones).where(eq(cajaSesiones.id, o.cajaSesionId)).limit(1);
  if (!turno || turno.estado !== 'abierta') return;
  if (o.sucursalId != null && turno.sucursalId !== o.sucursalId) return;
  if (await cajeroActual(db, turno) === o.usuarioId) return;
  await db.insert(cajaCajeros).values({
    cajaSesionId: turno.id, usuarioId: o.usuarioId, origen: o.origen, terminalId: o.terminalId ?? null,
  });
}

/** El ingreso en la PC de la caja con otro usuario: cambio de cajero si hay un turno abierto en esa sucursal. */
export async function cambioDeCajeroAlEntrar(db: Database, o: {
  usuarioId: number; rol: Rol; sucursalId: number; terminalId: number;
}) {
  if (!atiendeCaja(o.rol)) return;
  const [turno] = await db.select({ id: cajaSesiones.id }).from(cajaSesiones)
    .where(and(eq(cajaSesiones.sucursalId, o.sucursalId), eq(cajaSesiones.estado, 'abierta'))).limit(1);
  if (turno) await registrarCajero(db, { cajaSesionId: turno.id, usuarioId: o.usuarioId, origen: 'ingreso', terminalId: o.terminalId });
}

/** Los cajeros del turno en orden: el que abrió y los que la tomaron después. */
export async function cajerosDelTurno(db: Database, turno: { id: number; usuarioId: number | null; apertura: Date | string }) {
  const filas = await db.select({
    usuarioId: cajaCajeros.usuarioId, desde: cajaCajeros.desde, origen: cajaCajeros.origen, nombre: usuarios.nombre,
  }).from(cajaCajeros).leftJoin(usuarios, eq(usuarios.id, cajaCajeros.usuarioId))
    .where(eq(cajaCajeros.cajaSesionId, turno.id)).orderBy(asc(cajaCajeros.id));
  const [abrio] = turno.usuarioId
    ? await db.select({ nombre: usuarios.nombre }).from(usuarios).where(eq(usuarios.id, turno.usuarioId)).limit(1)
    : [];
  return [
    { usuarioId: turno.usuarioId, nombre: abrio?.nombre ?? '', desde: new Date(turno.apertura), origen: 'apertura' as const },
    ...filas.map((f) => ({ ...f, nombre: f.nombre ?? '' })),
  ];
}

/** QUIÉNES PUEDEN CERRAR la caja de una sucursal: activos, que atienden la caja y trabajan en ese local. */
export async function quienesCierran(db: any, sucursalId: number) {
  const us = await db.select({
    id: usuarios.id, nombre: usuarios.nombre, sucursales: usuarios.sucursales,
    rolClave: roles.clave, permisos: roles.permisos, modoSucursal: roles.modoSucursal,
  }).from(usuarios).innerJoin(roles, eq(roles.id, usuarios.rolId))
    .where(eq(usuarios.activo, true)).orderBy(asc(usuarios.nombre));
  return us
    .filter((u) => {
      const rol = { clave: u.rolClave, permisos: u.permisos, modoSucursal: u.modoSucursal };
      const locales = Array.isArray(u.sucursales) ? u.sucursales : [];
      return atiendeCaja(rol) && (!locales.length || rolCruzaSucursales(rol) || locales.includes(sucursalId));
    })
    .map((u) => ({ id: u.id, nombre: u.nombre }));
}

/** El que cierra tiene que poder cerrar esa caja: si no, se rechaza antes de mirar la contraseña. */
export async function exigirQuienCierra(db: any, sucursalId: number, usuarioId: unknown) {
  const id = Number(usuarioId) || 0;
  if (!id) throw new BadRequestException('Elegí quién cierra la caja. Si no aparece la opción, recargá la página.');
  const habilitados = await quienesCierran(db, sucursalId);
  if (!habilitados.some((u) => u.id === id)) {
    throw new BadRequestException('Esa persona no atiende la caja de este local: elegí quién la está cerrando.');
  }
  const [u] = await db.select().from(usuarios).where(eq(usuarios.id, id)).limit(1);
  return u;
}
