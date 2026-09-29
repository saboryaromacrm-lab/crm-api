/**
 * EL CIFRADO DE LAS COPIAS (Respaldo a Drive, 29/9/2026)
 * ============================================================================
 * AES-256-GCM en flujo, con la clave sacada de una contraseña (`BACKUP_CLAVE`,
 * que vive en las variables del servidor y en el lugar seguro del dueño) por
 * scrypt con una sal propia de cada archivo.
 *
 * FORMATO DEL ARCHIVO (`.enc`):
 *   8 bytes  · marca  "SYAENC01"
 *  16 bytes  · sal (scrypt)
 *  12 bytes  · vector de inicio (IV)
 *   N bytes  · el contenido cifrado
 *  16 bytes  · etiqueta de autenticación (GCM), al final
 *
 * El programa que lo abre (`scripts/descifrar-respaldo.mjs`) usa SOLO módulos
 * de Node: se puede correr en cualquier computadora, sin instalar nada ni
 * tener el sistema. Si se cambia el formato, cambian los dos juntos.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';

export const MARCA = Buffer.from('SYAENC01');
export const LARGO_SAL = 16;
export const LARGO_IV = 12;
export const LARGO_TAG = 16;

/** La clave de 32 bytes que sale de la contraseña. scrypt es lento a propósito. */
export const claveDe = (contrasena: string, sal: Buffer) => scryptSync(contrasena, sal, 32);

/** Cifra `origen` hacia `destino` en flujo (no carga el archivo en memoria). */
export async function cifrarArchivo(origen: string, destino: string, contrasena: string): Promise<void> {
  const sal = randomBytes(LARGO_SAL);
  const iv = randomBytes(LARGO_IV);
  const cifrador = createCipheriv('aes-256-gcm', claveDe(contrasena, sal), iv);
  const salida = createWriteStream(destino);
  try {
    salida.write(Buffer.concat([MARCA, sal, iv]));
    const entrada = createReadStream(origen);
    for await (const trozo of entrada) {
      const cifrado = cifrador.update(trozo as Buffer);
      if (cifrado.length && !salida.write(cifrado)) await once(salida, 'drain');
    }
    salida.write(cifrador.final());
    salida.write(cifrador.getAuthTag());
    salida.end();
    await once(salida, 'finish');
  } catch (e) {
    salida.destroy();
    throw e;
  }
}

/* ---- Estado de la conexión: el token de Drive, cifrado en la base ---- */
const SAL_TOKEN = 'respaldo-drive-token-v1';
/** Un texto corto (el token) cifrado con una clave del servidor: `iv.tag.contenido` en base64. */
export function cifrarTexto(texto: string, secreto: string): string {
  const iv = randomBytes(LARGO_IV);
  const c = createCipheriv('aes-256-gcm', scryptSync(secreto, SAL_TOKEN, 32), iv);
  const cuerpo = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), cuerpo].map((b) => b.toString('base64')).join('.');
}

export function descifrarTexto(cifrado: string, secreto: string): string {
  const [iv, tag, cuerpo] = cifrado.split('.').map((x) => Buffer.from(x, 'base64'));
  const d = createDecipheriv('aes-256-gcm', scryptSync(secreto, SAL_TOKEN, 32), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(cuerpo), d.final()]).toString('utf8');
}
