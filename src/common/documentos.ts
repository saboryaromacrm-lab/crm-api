/**
 * HELPERS COMPARTIDOS ENTRE MÓDULOS
 * ============================================================================
 * Acá vive lo que necesitan DOS O MÁS módulos y no tiene un dueño natural.
 *
 * Por qué un archivo aparte y no exportarlo del módulo que lo escribió primero:
 * `comprobantes` importa de `pagos` (usa `PagosProveedorService`), así que si la
 * etiqueta se exportaba desde `comprobantes` para que `pagos` la importe, los dos
 * módulos quedaban importándose entre sí. Un archivo sin dependencias no puede
 * generar ese ciclo.
 *
 * Ojo con qué entra acá: si algo lo usa UN solo módulo, va en ese módulo. Este
 * archivo no es un cajón de sastre.
 */

/** Abreviaturas de los tipos de comprobante, como se muestran en pantalla. */
export const ABREV_TIPO: Record<string, string> = {
  orden_compra: 'OC',
  remito: 'Remito',
  factura: 'Factura',
  nota_credito: 'NC',
  nota_debito: 'ND',
};

/**
 * CÓMO SE NOMBRA UN DOCUMENTO DE COMPRA, en un solo lugar.
 *
 * Antes había tres formas de armar esto y se veían las tres: Compras mostraba
 * `Factura A 0001-00000123`, la bandeja de pagos `Factura A 0001-123` (sin
 * rellenar), y el detalle del pago **`nota_debito 0001-123`** — el valor crudo
 * del enum, a la vista del usuario. El mismo documento con tres nombres hace
 * dudar de si son el mismo.
 *
 * El relleno a 8 dígitos es el del papel: así lo imprime ARCA y así se busca.
 */
export const etiquetaDoc = (c: {
  tipo: string;
  letra?: string | null;
  puntoVenta?: string | null;
  numero?: number | null;
  id?: number;
}) =>
  `${ABREV_TIPO[c.tipo] ?? c.tipo} ${c.letra ?? ''} ${c.puntoVenta ?? ''}-${String(c.numero ?? c.id ?? '').padStart(8, '0')}`
    .replace(/\s+/g, ' ')
    .trim();

/**
 * 'AAAA-MM-DD' → Date en hora local.
 *
 * Sin la hora, `new Date('2026-08-07')` se interpreta como UTC y en UTC−3 la
 * fecha se corre un día para atrás. Lo que no tenga forma de fecha pelada se
 * pasa tal cual al constructor, que acepta ISO con hora.
 *
 * NO es la misma que `fechaDeTexto` de `facturas`, que devuelve `null` cuando el
 * formato no es exacto en vez de una fecha inválida. Se dejaron separadas a
 * propósito: unificarlas cambiaría el comportamiento de uno de los dos lados.
 */
export function fechaLocal(v?: string | null) {
  if (!v) return null;
  const s = String(v).trim();
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s);
}
