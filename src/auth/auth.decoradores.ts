import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * DECORADORES DE ACCESO
 * ============================================================================
 * La regla es **cerrado por defecto**: el guard global exige sesión en los 224
 * endpoints, y lo que se abre se abre a mano con `@Publico()`. Al revés —una
 * lista de lo que hay que proteger— el endpoint nuevo que alguien agregue el mes
 * que viene nace abierto, y nadie se entera hasta que es tarde.
 */

export const PUBLICO_KEY = 'crm:publico';
export const PERMISO_KEY = 'crm:permiso';

/**
 * Este endpoint NO pide sesión. Son cinco casos y ninguno más:
 * el login, las opciones para poder elegir en el login, el health del deploy y
 * los cuatro de la tienda (el sitio público no tiene con qué autenticarse).
 */
export const Publico = () => SetMetadata(PUBLICO_KEY, true);

/**
 * Este endpoint exige un permiso, con las mismas claves que ya usa el menú
 * (`modulo.seccion` para ver, o una acción). El superadmin (`*`) pasa siempre.
 *
 * Existe porque hasta acá los permisos SOLO escondían botones: el cajero no veía
 * el botón de precios, pero la llamada que ese botón hace la podía hacer igual.
 */
export const Permiso = (...claves: string[]) => SetMetadata(PERMISO_KEY, claves);

/** Lo que el guard resolvió para esta request. Nunca viene del cliente. */
export interface Sesion {
  sesionId: number;
  usuarioId: number;
  nombre: string;
  rolId: number;
  rolClave: string;
  permisos: string[];
  sucursalId: number;
  sucursalNombre: string;
}

/**
 * `@Auth() sesion: Sesion` en el controller.
 *
 * Es la única fuente válida de "quién es" y "desde qué sucursal": los 56 lugares
 * que leían `usuarioId` del body confiaban en que el cliente dijera la verdad,
 * y con eso cualquier cajero logueado podía firmar un movimiento con el nombre
 * de otro.
 */
export const Auth = createParamDecorator((_d: unknown, ctx: ExecutionContext): Sesion => {
  return ctx.switchToHttp().getRequest().auth;
});
