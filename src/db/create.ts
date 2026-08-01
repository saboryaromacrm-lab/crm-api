import 'dotenv/config';
import { Client } from 'pg';

/**
 * Crea la base de datos indicada en DATABASE_URL si no existe. Se conecta a la
 * base de mantenimiento `postgres` con las mismas credenciales. No requiere psql.
 */
async function main() {
  const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/crm';
  const target = new URL(url);
  const dbName = decodeURIComponent(target.pathname.replace(/^\//, '')) || 'crm';

  const admin = new URL(url);
  admin.pathname = '/postgres';

  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (exists.rowCount === 0) {
    await client.query(`CREATE DATABASE "${dbName}"`);
    // eslint-disable-next-line no-console
    console.log(`✓ Base "${dbName}" creada.`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`La base "${dbName}" ya existía.`);
  }
  await client.end();
}
main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Error creando la base:', e.message);
  process.exit(1);
});
