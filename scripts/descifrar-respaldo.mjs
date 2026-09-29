#!/usr/bin/env node
/**
 * ABRIR UNA COPIA CIFRADA DEL SISTEMA (respaldo a Google Drive)
 * ============================================================================
 * Convierte el archivo que baja de Drive (respaldo-erp-AAAA-MM-DD-HHMM.sql.gz.enc; las anteriores al 29/9/2026 se llaman respaldo-crm-…)
 * en el .sql de la base, listo para restaurar con `psql`.
 *
 * NO necesita el sistema ni instalar nada: solo Node.js (versión 18 o más) y
 * la contraseña con que se cifró (la variable BACKUP_CLAVE del servidor, que el
 * titular guardó aparte).
 *
 * USO
 *   node descifrar-respaldo.mjs  ARCHIVO.sql.gz.enc  [SALIDA.sql]
 *
 * Pide la contraseña por teclado (no se ve al escribirla). Si preferís, se la
 * puede pasar en la variable BACKUP_CLAVE:
 *   PowerShell:  $env:BACKUP_CLAVE = "la-contraseña" ; node descifrar-respaldo.mjs ...
 *   Linux/Mac:   BACKUP_CLAVE="la-contraseña" node descifrar-respaldo.mjs ...
 *
 * Si la contraseña es incorrecta, o el archivo está dañado o fue modificado, se
 * detiene con un error y NO deja un .sql a medias.
 *
 * Una copia SIN cifrar (.sql.gz) no necesita este programa: se abre con
 * 7-Zip o con `gunzip`.
 *
 * FORMATO (tiene que coincidir con src/respaldos/cifrado.ts):
 *   "SYAENC01" (8) · sal scrypt (16) · IV (12) · contenido cifrado · etiqueta GCM (16)
 */
import { createDecipheriv, scryptSync } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, openSync, readSync, closeSync, statSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';

const MARCA = 'SYAENC01';
const LARGO_SAL = 16;
const LARGO_IV = 12;
const LARGO_TAG = 16;
const ENCABEZADO = MARCA.length + LARGO_SAL + LARGO_IV;

const [, , entrada, salidaArg] = process.argv;
if (!entrada) {
  console.error('Uso: node descifrar-respaldo.mjs ARCHIVO.sql.gz.enc [SALIDA.sql]');
  process.exit(1);
}
if (!existsSync(entrada)) {
  console.error(`No existe el archivo: ${entrada}`);
  process.exit(1);
}
const salida = salidaArg || (/\.sql\.gz\.enc$/i.test(entrada) ? entrada.replace(/\.gz\.enc$/i, '') : `${entrada}.sql`);
if (existsSync(salida)) {
  console.error(`Ya existe ${salida}: no lo piso. Borralo o elegí otro nombre de salida.`);
  process.exit(1);
}

/** Pide la contraseña sin mostrarla. */
function pedirContrasena() {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const original = rl._writeToOutput;
    process.stdout.write('Contraseña de cifrado (BACKUP_CLAVE): ');
    rl._writeToOutput = () => {};
    rl.question('', (r) => { rl._writeToOutput = original; rl.close(); process.stdout.write('\n'); resolve(r); });
  });
}

const contrasena = process.env.BACKUP_CLAVE || await pedirContrasena();
if (!contrasena) { console.error('Falta la contraseña.'); process.exit(1); }

const tamano = statSync(entrada).size;
if (tamano < ENCABEZADO + LARGO_TAG) { console.error('El archivo es demasiado chico: no parece una copia cifrada.'); process.exit(1); }

// Encabezado (marca, sal, IV) y etiqueta final.
const fd = openSync(entrada, 'r');
const cabecera = Buffer.alloc(ENCABEZADO);
readSync(fd, cabecera, 0, ENCABEZADO, 0);
const etiqueta = Buffer.alloc(LARGO_TAG);
readSync(fd, etiqueta, 0, LARGO_TAG, tamano - LARGO_TAG);
closeSync(fd);
if (cabecera.subarray(0, MARCA.length).toString() !== MARCA) {
  console.error('Este archivo no es una copia cifrada del sistema (falta la marca SYAENC01).');
  process.exit(1);
}
const sal = cabecera.subarray(MARCA.length, MARCA.length + LARGO_SAL);
const iv = cabecera.subarray(MARCA.length + LARGO_SAL);

const descifrador = createDecipheriv('aes-256-gcm', scryptSync(contrasena, sal, 32), iv);
descifrador.setAuthTag(etiqueta);

try {
  await pipeline(
    createReadStream(entrada, { start: ENCABEZADO, end: tamano - LARGO_TAG - 1 }),
    descifrador,
    createGunzip(),
    createWriteStream(salida),
  );
  console.log(`Listo: ${salida}`);
  console.log('Para restaurar: crear la base, correr las migraciones del sistema y cargarlo con psql (las instrucciones están al principio del propio .sql).');
} catch (e) {
  rmSync(salida, { force: true });
  // Con una contraseña equivocada el contenido sale basura y el primer error que
  // se ve es el de la descompresión, no el de la etiqueta de autenticación.
  const clave = /auth|unsupported state|bad decrypt|header check|invalid|unexpected end|incorrect/i.test(String(e?.message));
  console.error(clave
    ? 'No se pudo abrir: la contraseña es incorrecta o el archivo está dañado o fue modificado.'
    : `No se pudo abrir: ${e?.message ?? e}`);
  process.exit(1);
}
