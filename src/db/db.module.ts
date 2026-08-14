import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { schema } from './schema';
import { DRIZZLE } from './drizzle';
import { resolverDatabaseUrl } from './url';

/**
 * Módulo global que provee el cliente Drizzle (token DRIZZLE) a toda la app.
 * Una sola pool de conexiones a PostgreSQL, leída de DATABASE_URL.
 */
@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = resolverDatabaseUrl(config.get<string>('DATABASE_URL'));
        const pool = new Pool({ connectionString: url });
        return drizzle(pool, { schema, casing: 'snake_case' });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DbModule {}
