import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { schema } from './schema';

/** Token de inyección del cliente Drizzle. */
export const DRIZZLE = Symbol('DRIZZLE');

/** Tipo del cliente Drizzle tipado con todo el esquema. */
export type Database = NodePgDatabase<typeof schema>;
