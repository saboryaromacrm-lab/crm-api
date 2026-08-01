import 'dotenv/config';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

/** Aplica las migraciones generadas en ./drizzle contra DATABASE_URL. */
async function main() {
  const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/crm';
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: './drizzle' });
  await pool.end();
  // eslint-disable-next-line no-console
  console.log('✓ Migraciones aplicadas.');
}
main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Error aplicando migraciones:', e);
  process.exit(1);
});
