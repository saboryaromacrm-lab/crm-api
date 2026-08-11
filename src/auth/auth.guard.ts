import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISO_KEY, PUBLICO_KEY } from './auth.decoradores';
import { SesionesService } from './sesiones.service';

/**
 * EL GUARD GLOBAL — la única puerta de la API
 * ============================================================================
 * Está registrado como `APP_GUARD`, así que corre antes de TODOS los endpoints:
 * los 224 de hoy y los que se agreguen. Esa es la decisión de diseño central —
 * **cerrado por defecto**. Una lista de endpoints a proteger habría dejado
 * abierto cada endpoint nuevo hasta que alguien se acordara de anotarlo.
 *
 * Hace tres cosas, en orden:
 *   1. deja pasar lo marcado `@Publico()` (login, opciones del login, health y
 *      los cuatro de la tienda);
 *   2. resuelve el token del `Authorization: Bearer` a una sesión REAL —usuario,
 *      rol, permisos y sucursal, leídos de la base en el momento;
 *   3. si el endpoint pide `@Permiso(...)`, lo exige.
 *
 * Lo que queda en `req.auth` es la única fuente válida de "quién es" y "desde
 * qué sucursal". Nada de eso vuelve a leerse del body.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sesiones: SesionesService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    // El handler primero y la clase después: así un controller entero puede ser
    // público y un método suyo seguir cerrado, o al revés.
    const publico = this.reflector.getAllAndOverride<boolean>(PUBLICO_KEY, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (publico) return true;

    const req = ctx.switchToHttp().getRequest();
    const token = leerBearer(req.headers?.authorization);
    if (!token) {
      throw new UnauthorizedException('Necesitás iniciar sesión.');
    }

    const sesion = await this.sesiones.resolver(token);
    if (!sesion) {
      // Mismo mensaje para "no existe", "venció" y "el usuario se desactivó": al
      // que está afuera no se le cuenta en qué estado está la credencial. El
      // frontend con esto ya sabe qué hacer — limpiar y volver al login.
      throw new UnauthorizedException('Tu sesión venció. Volvé a entrar.');
    }
    req.auth = sesion;

    const claves = this.reflector.getAllAndOverride<string[]>(PERMISO_KEY, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (claves?.length && !tienePermiso(sesion.permisos, claves)) {
      // 403 y no 401: la sesión está bien, lo que falta es el permiso. Si
      // devolviera 401, el frontend lo trataría como sesión vencida y echaría a
      // la cajera al login por haber tocado algo que no le corresponde.
      throw new ForbiddenException('Tu rol no tiene permiso para esto.');
    }

    return true;
  }
}

/** `Authorization: Bearer <token>`, tolerante con mayúsculas y espacios. */
function leerBearer(cabecera: unknown): string {
  if (typeof cabecera !== 'string') return '';
  const m = cabecera.match(/^\s*Bearer\s+(.+?)\s*$/i);
  return m ? m[1] : '';
}

/** El superadmin (`*`) pasa siempre; el resto necesita ALGUNA de las claves. */
export function tienePermiso(permisos: string[], claves: string[]): boolean {
  if (permisos.includes('*')) return true;
  return claves.some((c) => permisos.includes(c));
}
