/**
 * AGRUPAR UNA LISTA POR CLAVE, UNA SOLA VEZ.
 * ============================================================================
 * Existe para reemplazar el patrón `for (const p of productos) { xs.filter(...) }`,
 * que es la forma más fácil de escribir una lentitud que no se nota hasta que
 * el catálogo crece.
 *
 * Con 2.700 productos y 15.000 filas de formatos, ese `filter` adentro del
 * bucle son CUARENTA MILLONES de comparaciones — y Node las hace en un solo
 * hilo, así que mientras tanto la API no atiende a nadie más: ni la venta de
 * la otra caja, ni los avisos del sidebar, ni el chequeo de salud. Esa pausa
 * es la que el cajero ve como "no responde".
 *
 * Agrupando una vez por adelantado, el mismo trabajo se hace en 15.000 pasos
 * en vez de 40 millones, y buscar el grupo de un producto pasa a ser instantáneo.
 *
 * EL ORDEN SE RESPETA. Dentro de cada grupo, los elementos quedan en el mismo
 * orden en que venían en la lista original — exactamente como los dejaba
 * `filter`. No es un detalle: de ese orden dependen cosas que tocan plata,
 * como cuál es el formato de compra que define el precio cuando ninguno está
 * marcado (`formatoActivo` toma el primero).
 */
export function agruparPor<T, K>(lista: readonly T[], clave: (x: T) => K): Map<K, T[]> {
  const mapa = new Map<K, T[]>();
  for (const x of lista) {
    const k = clave(x);
    const grupo = mapa.get(k);
    if (grupo) grupo.push(x);
    else mapa.set(k, [x]);
  }
  return mapa;
}

/** El grupo pedido, o una lista vacía. Evita el `?? []` repetido en cada uso. */
export const grupo = <T, K>(mapa: Map<K, T[]>, k: K): T[] => mapa.get(k) ?? [];
