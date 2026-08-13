import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'crypto';
import { CLAVE_SERVICIO_KEY, PERMISO_KEY, PUBLICO_KEY } from './auth.decoradores';
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

    /*
     * ¿Trae la CLAVE DE SERVICIO de este endpoint? Es la puerta de las
     * aplicaciones externas (hoy solo coffit), y pasa antes que la sesión
     * porque un sistema no tiene usuario. Si la variable de entorno no está
     * cargada, esta rama no existe: el endpoint sigue pidiendo sesión.
     */
    const variable = this.reflector.getAllAndOverride<string>(CLAVE_SERVICIO_KEY, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (variable && claveDeServicioValida(req, variable)) return true;

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

/**
 * LA CLAVE DE SERVICIO de un endpoint, en la cabecera `X-Clave-Servicio`.
 *
 * Se compara con `timingSafeEqual` y no con `===`: comparar strings corta en el
 * primer byte distinto, y con eso el tiempo de respuesta filtra el secreto letra
 * por letra. Es barato hacerlo bien.
 *
 * Sin la variable de entorno cargada devuelve `false` SIEMPRE, así que el
 * endpoint sigue pidiendo sesión: la puerta se abre recién cuando el dueño
 * carga el secreto.
 */
export function claveDeServicioValida(req: any, variableEntorno: string): boolean {
  const esperado = process.env[variableEntorno];
  if (!esperado) return false;
  const cabecera = req?.headers?.['x-clave-servicio'];
  if (typeof cabecera !== 'string' || !cabecera) return false;
  const a = Buffer.from(cabecera);
  const b = Buffer.from(esperado);
  // `timingSafeEqual` explota si difieren los largos, y el largo no es secreto.
  return a.length === b.length && timingSafeEqual(a, b);
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

/**
 * QUIÉN PUEDE OPERAR EN OTRA SUCURSAL.
 *
 * El cajero está clavado a la suya: la sucursal sale de su sesión y no del body,
 * así no puede colgarle una venta al turno de Fontana ni descontarle el stock.
 * El jefe sí necesita cruzar —abre la caja de la sucursal nueva, corrige una
 * cobranza cargada en el lugar equivocado—, así que para él la sucursal del body
 * sigue valiendo.
 *
 * Va por ROL y no por una clave de permiso nueva a propósito: "atravesar
 * sucursales" no es una pantalla ni una acción del negocio, es la diferencia
 * entre estar en un mostrador y ver todos. Es el mismo criterio que el frontend
 * ya usa en cinco lugares (`esJefe`), ahora escrito una sola vez y del lado que
 * manda.
 */
export function esJefe(sesion: { rolClave?: string; permisos?: string[] }): boolean {
  if (sesion?.permisos?.includes('*')) return true;
  return sesion?.rolClave === 'admin' || sesion?.rolClave === 'superadmin';
}

/**
 * La sucursal con la que se graba una operación de mostrador (venta, cobranza,
 * apertura de caja). Un solo lugar para que las tres no puedan discrepar.
 */
export function sucursalDeOperacion(
  sesion: { rolClave?: string; permisos?: string[]; sucursalId?: number },
  pedida?: number | null,
): number | undefined {
  if (esJefe(sesion) && pedida) return pedida;
  return sesion?.sucursalId ?? undefined;
}

/**
 * La sucursal a la que está limitado lo que esta sesión puede TOCAR de lo que ya
 * existe: cerrar un turno, anular una venta, descartar un borrador.
 * **`null` = sin límite**, que es el caso del jefe.
 *
 * Es distinto de `sucursalDeOperacion` —"dónde se graba lo nuevo"— y por eso son
 * dos funciones. Cuando eran una sola, el jefe quedaba encerrado en su propia
 * sucursal para corregir lo que había cargado otro mostrador.
 */
export function soloSuSucursal(
  sesion: { rolClave?: string; permisos?: string[]; sucursalId?: number },
): number | null {
  return esJefe(sesion) ? null : (sesion?.sucursalId ?? null);
}
