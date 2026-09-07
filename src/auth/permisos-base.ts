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

export const PERMISOS_BASE = Object.freeze([
  /* Vencimientos, la sección: control de góndola, alertas y reportes. */
  'almacen.vencimientos',
  /* Cafetería: armar y anular los envíos de mercadería a coffit. */
  'almacen.cafeteria',
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
  return [...new Set([...propios, ...PERMISOS_BASE])];
}
