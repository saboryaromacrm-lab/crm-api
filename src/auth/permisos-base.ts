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
 * LO QUE LA BASE NO LE DA A UN ROL (25/9/2026, pedido del dueño).
 *
 * `inventario` abre la devolución (+stock), el ajuste (±) y la "venta" sin
 * ticket ni caja. Al fraccionador no le toca ninguna: su trabajo es convertir
 * granel en paquetes, y con esa llave podía inflar el stock con una
 * "devolución" y sacarlo como venta sin que pasara por ninguna caja. Lo único
 * que esa llave le daba de verdad —procesar un vencimiento, que es dar de baja
 * lo vencido— ahora pide también `merma`, que sí conserva.
 */
const QUITADOS_POR_ROL: Record<string, readonly string[]> = Object.freeze({
  fraccionador: ['inventario'],
});

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
   * Las tres acciones que hacen falta para CERRAR el circuito de vencimientos.
   * Sin ellas la pantalla se ve pero no se puede procesar lo que ya venció, que
   * es exactamente para lo que existe:
   *   inventario  → dar de baja el stock vencido (lo exige POST /vencimientos/:id/procesar)
   *   merma       → registrar lo que se tiró
   *   defectuoso  → apartar lo que salió fallado
   *
   * Son ACCIONES, no secciones: solo se pueden ejercer dentro de una pantalla
   * que el rol ya tenga. A un cajero sin `almacen.operaciones` no le abren
   * ninguna puerta nueva fuera de Vencimientos.
   */
  'inventario',
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
