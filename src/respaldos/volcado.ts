/**
 * EL VOLCADO DE LA BASE (Sistema › Respaldos)
 * ============================================================================
 * Genera el archivo .sql con TODA la base sin `pg_dump` (la imagen del
 * contenedor no lo trae; ver el encabezado de `respaldos.module.ts`). Vive acá
 * y no dentro del servicio porque lo usan DOS caminos que no se conocen: la
 * descarga a mano (escribe sobre la respuesta HTTP) y el respaldo a Google
 * Drive (escribe a un archivo comprimido). El que llama decide a dónde va cada
 * pedazo con `escribir`, que puede ser asíncrona para respetar la contrapresión.
 */
import type { Pool } from 'pg';

/** Literal SQL: comillas simples dobladas. `standard_conforming_strings` es el
 *  default de Postgres, así que la barra invertida no necesita nada. */
const literal = (v: string | null) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);

/** Tablas del esquema público, orden alfabético (las FKs no importan: el
 *  archivo carga con los triggers apagados). */
export async function tablasDelEsquema(pool: Pool): Promise<string[]> {
  const r = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
  return r.rows.map((x: any) => x.tablename as string);
}

export interface ResultadoVolcado { tablas: number; filas: number; bytes: number }

/**
 * Escribe el volcado completo por `escribir`. Valores como TEXTO crudo (sin
 * type parsers): lo que Postgres escribe es exactamente lo que Postgres sabe
 * volver a leer. Se lee UNA tabla por vez, así que la memoria máxima es la de
 * la tabla más grande y no la de la base entera.
 */
export async function volcarA(
  pool: Pool,
  escribir: (texto: string) => void | Promise<void>,
): Promise<ResultadoVolcado> {
  const tablas = await tablasDelEsquema(pool);
  const fecha = new Date();
  let bytes = 0;
  let filas = 0;
  const out = async (s: string) => { bytes += Buffer.byteLength(s); await escribir(s); };

  await out([
    `-- Respaldo del CRM Sabor y Aroma — ${fecha.toISOString()}`,
    `-- ${tablas.length} tablas. Generado desde Sistema › Respaldos.`,
    '--',
    '-- CÓMO SE RESTAURA (en una base NUEVA):',
    '--   1. Crear la base y correr las migraciones del sistema:  node dist/db/migrate.js',
    '--   2. Cargar este archivo como superusuario (postgres):    psql "DATABASE_URL" -f este_archivo.sql',
    '-- El archivo vacía las tablas y las vuelve a llenar; corre con los',
    '-- triggers apagados (session_replication_role), por eso pide superusuario.',
    '',
    'BEGIN;',
    'SET session_replication_role = replica;',
    `TRUNCATE ${tablas.map((t) => `"${t}"`).join(', ')} CASCADE;`,
    '',
  ].join('\n'));

  // Sin parsers: cada valor llega como el texto que Postgres emitiría en un COPY.
  const crudo = { getTypeParser: () => (v: string) => v } as any;

  for (const t of tablas) {
    const r = await pool.query({ text: `SELECT * FROM "${t}"`, types: crudo });
    if (!r.rows.length) continue;
    const cols = r.fields.map((f: any) => `"${f.name}"`).join(', ');
    await out(`-- ${t}: ${r.rows.length} fila(s)\n`);
    const LOTE = 200;
    for (let i = 0; i < r.rows.length; i += LOTE) {
      const lote = r.rows.slice(i, i + LOTE)
        .map((row: any) => `(${r.fields.map((f: any) => literal(row[f.name])).join(', ')})`);
      await out(`INSERT INTO "${t}" (${cols}) VALUES\n${lote.join(',\n')};\n`);
    }
    filas += r.rows.length;
  }

  // Las secuencias arrancan después del último id insertado, tabla por tabla.
  const conSerial = await pool.query(`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'id' AND column_default LIKE 'nextval%'`);
  await out('\n-- Secuencias al día\n');
  for (const row of conSerial.rows as any[]) {
    await out(`SELECT setval(pg_get_serial_sequence('"${row.table_name}"', 'id'), COALESCE((SELECT MAX(id) FROM "${row.table_name}"), 0) + 1, false);\n`);
  }
  await out('\nSET session_replication_role = DEFAULT;\nCOMMIT;\n');
  return { tablas: tablas.length, filas, bytes };
}
