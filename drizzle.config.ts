import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * Configuración de Drizzle Kit (generación de migraciones y push).
 * Lee DATABASE_URL del entorno (.env). El esquema vive en src/db/schema.ts y las
 * migraciones SQL se generan en ./drizzle.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/crm',
  },
  casing: 'snake_case',
  verbose: true,
  strict: true,
});
