/**
 * PERMISOS QUE VIENEN DE FÁBRICA — los tiene todo el mundo, sin configurar nada
 * ============================================================================
 * Hay funciones que NO son un privilegio: son parte del trabajo de cualquier
 * mostrador. Que la cajera de Fontana no pueda anotar que un yogur vence el
 * viernes no protege nada — solo hace que el yogur se venza.
 *
 * Estas claves se SUMAN a las del rol al resolver la sesión, no se guardan en
 * la base. La diferencia importa:
 *
 *   · alcanzan a los roles que ya existen Y a los que se creen mañana, sin que
 *     nadie se acuerde de tildar la casilla;
 *   · son las mismas en el local y en el servidor, porque viajan con el código
 *     y no con los datos de cada base;
 *   · nadie las puede apagar sin querer desde la pantalla de roles.
 *
 * QUIÉN QUEDA AFUERA: el rol `cafeteria`. Ese usuario no es del negocio — es
 * coffit, la cafetería de al lado, que entra sólo a pedir mercadería. Darle
 * `almacen.cafeteria` (que es el lado que DESPACHA) lo dejaría sirviéndose a sí
 * mismo del depósito, sin que nadie de la distribuidora apruebe el envío.
 *
 * ESTO NO REEMPLAZA AL SISTEMA DE PERMISOS. Todo lo demás —caja, precios,
 * facturación, usuarios— sigue dependiendo del rol. Acá sólo entra lo que, por
 * decisión del dueño, tiene que estar disponible en cualquier sucursal.
 */

/** Roles que NO reciben la base (ver el encabezado). */
const AJENOS = new Set(['cafeteria']);

/**
 * LO QUE LA BASE NO LE DA A UN ROL, por rol (25/9/2026, pedido del dueño).
 *
 * Nació para sacarle `inventario` al fraccionador. Desde el 27/9 esa llave ya
 * no viene de fábrica para NADIE (ver abajo), así que hoy está vacío: queda el
 * mecanismo para el próximo caso.
 */
const QUITADOS_POR_ROL: Record<string, readonly string[]> = Object.freeze({});

export const PERMISOS_BASE = Object.freeze([
  /* Vencimientos, la sección: control de góndola, alertas y reportes. */
  'almacen.vencimientos',
  /* Cafetería: armar y anular los envíos de mercadería a coffit. */
  'almacen.cafeteria',
  /*
   * CARTELES DE GÓNDOLA (21/9/2026, pedido del dueño: "es algo que podemos
   * usar todos"). Rehacer el cartel de un estante es trabajo de mostrador, no
   * un privilegio: el que repone es el que ve el cartel viejo.
   *
   * Es una clave PROPIA y no `ventas.cambios` —que era la que pedía la
   * sección— porque esa otra abre los CAMBIOS DE PRECIO. Darle esa llave a
   * todos para que puedan imprimir un cartel habría sido abrir de más por la
   * puerta de al lado.
   *
   * Lo que se puede hacer con esto es acotado a propósito: escribir el texto
   * del cartel e imprimirlo. El PRECIO no se tipea nunca —lo pone el sistema—
   * así que un cartel no puede contradecir a la caja.
   */
  'ventas.carteles',
  /*
   * Las dos acciones que hacen falta para CERRAR el circuito de vencimientos
   * en cualquier sucursal (decisión del dueño):
   *   merma       → registrar lo que se tiró, y procesar lo vencido
   *   defectuoso  → apartar lo que salió fallado
   * Las dos son BAJAS (el stock solo baja) y quedan con su costo y su autor.
   *
   * SIN `inventario` DESDE EL 27/9/2026. Estaba acá con la excusa de procesar
   * vencimientos (que ya pide `merma`), pero la API no la ata a ninguna
   * pantalla: con ella cualquier cajera podía, por la API, SUMAR stock con un
   * ajuste o una devolución, restarlo con un ajuste a costo $0 y resolver ella
   * misma sus incidencias. El comentario decía que "no abre puertas fuera de
   * Vencimientos" y no era cierto — se probó: ajuste +100, devolución +50,
   * merma −120, todo con la sesión de una cajera. `inventario` ahora es del
   * rol que la tenga tildada (admin), como cualquier llave de verdad.
   */
  'merma',
  'defectuoso',
]);

/**
 * Los permisos del rol más los de fábrica, sin repetidos.
 *
 * El superadmin (`*`) vuelve intacto: el comodín ya lo puede todo y agregarle
 * claves sólo ensuciaría el listado.
 */
export function conPermisosBase(delRol: string[] | null | undefined, rolClave = ''): string[] {
  const propios = Array.isArray(delRol) ? delRol : [];
  if (propios.includes('*') || AJENOS.has(rolClave)) return propios;
  const quitados = QUITADOS_POR_ROL[rolClave] ?? [];
  return [...new Set([...propios, ...PERMISOS_BASE.filter((k) => !quitados.includes(k))])];
}
