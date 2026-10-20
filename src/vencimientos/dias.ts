import { sql } from 'drizzle-orm';
import { vencimientos } from '../db/schema';

/** Día "para vencer" contra el calendario argentino, no el UTC del server. */
export const HOY_AR = sql`(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date`;
export const DIAS = sql<number>`(${vencimientos.fechaVencimiento} - ${HOY_AR})`;
