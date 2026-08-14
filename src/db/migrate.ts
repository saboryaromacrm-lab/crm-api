import 'dotenv/config';
import { resolverDatabaseUrl } from './url';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

/** Aplica las migraciones generadas en ./drizzle contra DATABASE_URL. */
async function main() {
  const url = resolverDatabaseUrl();
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
