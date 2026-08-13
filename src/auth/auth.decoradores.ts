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
export const CLAVE_SERVICIO_KEY = 'crm:clave-servicio';

/**
 * ESTE ENDPOINT TAMBIÉN ACEPTA UNA CLAVE DE SERVICIO, para una aplicación que
 * no es una persona y por lo tanto no tiene sesión.
 *
 * Recibe el nombre de la variable de entorno donde vive el secreto. Si esa
 * variable no está cargada, la puerta simplemente no existe y el endpoint sigue
 * pidiendo sesión como cualquier otro — así se puede preparar el cambio sin
 * romper a nadie y activarlo el día que se coordina con el otro sistema.
 *
 * NO es `@Publico()`: la clave se compara en el guard, que es la única puerta
 * del sistema. Hacerlo con `@Publico()` + un chequeo en el controller dejaba el
 * endpoint sin `req.auth` incluso para una sesión legítima, o sea que había que
 * reimplementar la autenticación adentro del handler — dos puertas otra vez.
 */
export const ClaveServicio = (variableEntorno: string) =>
  SetMetadata(CLAVE_SERVICIO_KEY, variableEntorno);

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
  /** El nombre visible del rol ("Administrador"), para el encabezado. */
  rolNombre: string;
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

/*
 * El `usuarioId` del body lo pone el SERVIDOR en todos los endpoints — no hay
 * que hacer nada en el controller. Lo hace `AutorInterceptor`, que está
 * registrado global junto al guard; ahí está explicado por qué en un solo lugar
 * y no repetido en 11 archivos.
 *
 * La sucursal NO se pisa igual: en casi todos los endpoints es un DATO (el
 * admin mirando el stock de Express 2), no "dónde estoy". Donde sí significa
 * "mi sucursal" —el chat— se toma de la sesión a mano y con su comentario.
 */
