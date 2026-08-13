import { Inject, Injectable } from '@nestjs/common';
import { and, eq, lt } from 'drizzle-orm';
import { createHash, randomBytes } from 'crypto';
import { DRIZZLE, Database } from '../db/drizzle';
import { roles, sesiones, sucursales, usuarios } from '../db/schema';
import type { Sesion } from './auth.decoradores';

/**
 * EL ALMACÉN DE SESIONES
 * ============================================================================
 * El token que viaja al cliente son 32 bytes de aleatorio. En la base queda
 * solo su **sha256**: un token en claro guardado es una credencial usable, y
 * este sistema hace un `pg_dump` todas las noches — el backup no puede ser la
 * llave del sistema.
 *
 * No hace falta scrypt (que sí se usa para las contraseñas): el token no se
 * puede adivinar por fuerza bruta, ya es aleatorio. scrypt acá solo agregaría
 * ~100 ms a CADA request.
 */

/** Inactividad que tolera una sesión antes de caducar. */
const HORAS_VIDA = 12;

/**
 * Solo se estira el vencimiento cuando queda menos de la mitad de la ventana.
 * Escribir en cada request sería un UPDATE por cada llamada del sistema — el POS
 * hace varias por venta.
 */
const REFRESCAR_DEBAJO_DE_HORAS = HORAS_VIDA / 2;

const hashDe = (token: string) => createHash('sha256').update(token).digest('hex');
const enHoras = (h: number) => new Date(Date.now() + h * 3600_000);

@Injectable()
export class SesionesService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Crea la sesión y devuelve el token EN CLARO — la única vez que existe. */
  async crear(usuarioId: number, sucursalId: number, userAgent = ''): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.db.insert(sesiones).values({
      tokenHash: hashDe(token),
      usuarioId,
      sucursalId,
      expiraEn: enHoras(HORAS_VIDA),
      userAgent: userAgent.slice(0, 300),
    });
    return token;
  }

  /**
   * Resuelve el token a la sesión completa, o `null`.
   *
   * Trae el usuario, su ROL y la sucursal en una sola consulta, y los trae
   * FRESCOS: por eso cambiar un permiso o desactivar a alguien tiene efecto en
   * la request siguiente y no cuando venza la sesión.
   */
  async resolver(token: string): Promise<Sesion | null> {
    if (!token) return null;
    const [f] = await this.db
      .select({
        sesionId: sesiones.id,
        expiraEn: sesiones.expiraEn,
        usuarioId: usuarios.id,
        nombre: usuarios.nombre,
        activo: usuarios.activo,
        rolId: roles.id,
        rolClave: roles.clave,
        // El NOMBRE del rol además de la clave: es lo que el encabezado le
        // muestra a la persona ("Administrador"), y sin él `/auth/yo` devolvía
        // menos campos que el login — el frontend reemplaza el usuario con esta
        // respuesta, así que el nombre del rol se perdía en el primer F5.
        rolNombre: roles.nombre,
        permisos: roles.permisos,
        sucursalId: sucursales.id,
        sucursalNombre: sucursales.nombre,
      })
      .from(sesiones)
      .innerJoin(usuarios, eq(usuarios.id, sesiones.usuarioId))
      .innerJoin(roles, eq(roles.id, usuarios.rolId))
      .innerJoin(sucursales, eq(sucursales.id, sesiones.sucursalId))
      .where(eq(sesiones.tokenHash, hashDe(token)))
      .limit(1);

    if (!f) return null;

    // Vencida: se borra en el momento. Dejarla acumularía basura que además
    // sigue apareciendo en la lista de sesiones del usuario.
    if (f.expiraEn.getTime() <= Date.now()) {
      await this.db.delete(sesiones).where(eq(sesiones.id, f.sesionId));
      return null;
    }
    // Usuario desactivado: la sesión que tenía abierta deja de servir YA. Es el
    // caso "se fue el empleado y quedó una pestaña abierta en la sucursal".
    if (!f.activo) {
      await this.db.delete(sesiones).where(eq(sesiones.usuarioId, f.usuarioId));
      return null;
    }

    const faltaHoras = (f.expiraEn.getTime() - Date.now()) / 3600_000;
    if (faltaHoras < REFRESCAR_DEBAJO_DE_HORAS) {
      await this.db.update(sesiones)
        .set({ expiraEn: enHoras(HORAS_VIDA), ultimoUso: new Date() })
        .where(eq(sesiones.id, f.sesionId));
    }

    return {
      sesionId: f.sesionId,
      usuarioId: f.usuarioId,
      nombre: f.nombre,
      rolId: f.rolId,
      rolClave: f.rolClave ?? '',
      rolNombre: f.rolNombre ?? '',
      permisos: (f.permisos as string[]) ?? [],
      sucursalId: f.sucursalId,
      sucursalNombre: f.sucursalNombre,
    };
  }

  /**
   * Mueve la sucursal DE ESTA SESIÓN.
   *
   * `sucursalId` se fijaba en el login y no se actualizaba nunca, así que
   * cuando el jefe cambiaba de sucursal desde el encabezado el cambio duraba
   * hasta el F5 siguiente: `/auth/yo` devolvía la sucursal vieja (la de la
   * sesión) y pisaba la elegida, mientras el contexto de los módulos —que NO
   * se pisa— seguía en la nueva. El sistema quedaba partido: el encabezado y
   * el chat en una sucursal y Compras/Almacén/Ventas en otra.
   */
  async moverSucursal(sesionId: number, sucursalId: number) {
    await this.db.update(sesiones)
      .set({ sucursalId, ultimoUso: new Date() })
      .where(eq(sesiones.id, sesionId));
  }

  /** Salir: mata ESTA sesión y no las otras (la tablet del local sigue abierta). */
  async cerrar(sesionId: number) {
    await this.db.delete(sesiones).where(eq(sesiones.id, sesionId));
    return { ok: true };
  }

  /**
   * Todas las sesiones de un usuario. Se usa al cambiarle la contraseña: si no,
   * cambiarla no echa a quien ya estaba adentro, que es justo para lo que se la
   * cambia.
   */
  async cerrarTodasDe(usuarioId: number) {
    await this.db.delete(sesiones).where(eq(sesiones.usuarioId, usuarioId));
    return { ok: true };
  }

  /* "Ver y cortar las sesiones abiertas" es una función que TODAVÍA NO EXISTE.
   * Acá vivía un `listarDe` que ningún endpoint llamaba —o sea que nunca se
   * ejecutó— y que además tenía los argumentos del `lt` al revés. Se borró: el
   * día que se construya la pantalla, se escribe con una prueba que la
   * ejercite. Está anotado en /info › Pendientes. */

  /** Barrido de vencidas. Lo llama el login: no hace falta un cron para esto. */
  async limpiarVencidas() {
    await this.db.delete(sesiones).where(lt(sesiones.expiraEn, new Date()));
  }
}
