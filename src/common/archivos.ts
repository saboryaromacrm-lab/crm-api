/**
 * ARCHIVOS QUE ENTRAN Y VUELVEN A SALIR — qué son de verdad
 * ============================================================================
 * Dos lugares del sistema reciben binarios del navegador y después los sirven
 * de vuelta: los papeles de la bandeja de facturas (Compras) y las imágenes
 * del sitio (Web). Los dos tienen el mismo problema y la misma solución, así
 * que la tabla de firmas vive acá y no duplicada en cada uno: si mañana se
 * acepta AVIF, se acepta en los dos o en ninguno, y no por olvido.
 *
 * EL MIME QUE LLEGA LO ESCRIBE EL CLIENTE. Decir `data:image/png;base64,` y
 * mandar cualquier otra cosa es gratis. Como después el archivo se sirve CON
 * ese mime, creerle es alojar contenido arbitrario en el dominio del sistema
 * — y el dominio del sistema es donde vive el token de sesión del CRM.
 *
 * El caso que lo vuelve grave y no teórico es el SVG: no es una imagen, es un
 * documento que ejecuta JavaScript. Un `<svg onload=...>` servido desde
 * `/api/...` corre en el mismo origen que el dashboard.
 */

/** Las firmas: los primeros bytes de verdad de cada formato admitido. */
export const FIRMAS: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  // WebP es un contenedor RIFF: "RIFF" .... "WEBP".
  { mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
  { mime: 'application/pdf', test: (b) => b.subarray(0, 5).toString('ascii') === '%PDF-' },
];

/** Qué es el archivo según sus bytes, o null si no es ninguno de los admitidos. */
export const mimeReal = (b: Buffer) => (b.length < 12 ? null : FIRMAS.find((f) => f.test(b))?.mime ?? null);

/**
 * Las tres imágenes de verdad. Un SVG NO está — y no puede estarlo, porque no
 * hay firma de bytes que lo vuelva inofensivo: el peligro es su contenido.
 */
export const MIMES_IMAGEN = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Para el `filename` de la respuesta: sin comillas, saltos ni rutas. */
export const nombreSeguro = (n: string, porDefecto = 'archivo') =>
  (n || porDefecto).replace(/[^\w.\- ]+/g, '_').slice(0, 100);
