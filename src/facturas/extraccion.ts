/**
 * TEXTO DE FACTURAS — lo único que el servidor sigue necesitando.
 * ============================================================================
 * La lectura de los PDF se mudó al navegador (28/9/2026, ver
 * `crm-dashboard/src/modules/productos/domain/facturas/`): leer un PDF grande
 * acá frenaba las cajas, que corren en este mismo proceso. El servidor solo
 * compara la descripción del papel con los nombres del catálogo, y para eso
 * alcanza con esto.
 */

/** Para comparar texto mugriento: sin espacios, sin acentos, mayúsculas. */
export const clave = (s: string) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .toUpperCase();
