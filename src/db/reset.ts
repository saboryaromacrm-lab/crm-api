import 'dotenv/config';
import { Pool } from 'pg';
import { truncateAll } from './truncate';

/** Vacía la base (sin insertar datos). */
async function main() {
  const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/crm';
  const pool = new Pool({ connectionString: url });
  await truncateAll(pool);
  await pool.end();
  // eslint-disable-next-line no-console
  console.log('✓ Base vaciada.');
}
main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Error:', e);
  process.exit(1);
});
