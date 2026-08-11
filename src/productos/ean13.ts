/**
 * EAN-13 — el dígito verificador y la serie interna
 * ============================================================================
 * El verificador ES la razón de ser del formato: un dígito mal tipeado o mal
 * leído no produce otro código válido, así que el lector puede DARSE CUENTA en
 * vez de cargar otro producto. Por eso los códigos nuevos lo tienen que
 * cumplir, y por eso los 13 que hay en la base con 13 dígitos y el verificador
 * mal no los va a leer ningún lector.
 *
 * La misma fórmula vive en el front (`core/services/barcode.js`, que además
 * dibuja las barras). No es duplicación evitable: son dos procesos distintos y
 * cumplen papeles distintos — el front avisa mientras se escribe, la API decide
 * si se guarda. Si cambia una, tiene que cambiar la otra.
 */

/** Posiciones impares ×1, pares ×3, de izquierda a derecha. */
export function digitoVerificador(doce: string): number {
  let suma = 0;
  for (let i = 0; i < 12; i += 1) suma += Number(doce[i]) * (i % 2 ? 3 : 1);
  return (10 - (suma % 10)) % 10;
}

/** 13 dígitos y el último cerrando la cuenta. Nada más es un EAN-13. */
export function esEan13(codigo: string): boolean {
  const c = String(codigo || '').trim();
  if (!/^\d{13}$/.test(c)) return false;
  return digitoVerificador(c.slice(0, 12)) === Number(c[12]);
}

/**
 * PREFIJOS para la serie propia, de mayor a menor preferencia.
 *
 * El rango 20-29 es "circulación restringida" en GS1: son los códigos que un
 * negocio se arma para uso interno y que ningún fabricante del mundo va a
 * emitir, así que no pueden chocar con la mercadería que se compra. Se empieza
 * por el 29 y NO se usa el de la balanza: el POS lee las etiquetas de peso
 * variable por ese prefijo (hoy 20) y toma los dígitos 3 a 7 como artículo — un
 * código nuestro que arrancara igual se leería como "500 g de otra cosa".
 */
export const PREFIJOS_INTERNOS = ['29', '28', '27', '26', '25', '24', '23', '22', '21', '20'];

/** Prefijo (2) + secuencia (10) + verificador. */
export function armarEan13(prefijo: string, secuencia: number): string {
  const doce = prefijo + String(secuencia).padStart(10, '0');
  return doce + String(digitoVerificador(doce));
}

/** La secuencia de un código de NUESTRA serie, o null si no es de esa serie. */
export function secuenciaDe(codigo: string, prefijo: string): number | null {
  const c = String(codigo || '').trim();
  if (!/^\d{13}$/.test(c) || !c.startsWith(prefijo)) return null;
  const sec = Number(c.slice(2, 12));
  return Number.isFinite(sec) ? sec : null;
}
