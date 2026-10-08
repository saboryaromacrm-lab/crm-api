-- ===========================================================================
-- 0145 · CAJAS A CONTROLAR (8/10/2026, pedido del dueño)
-- ===========================================================================
-- Al terminar un control (el del sobre en el Cash Flow, el cierre del turno o
-- un control a mitad de turno) el dueño ve la diferencia y, si le parece
-- mucha, MARCA la caja: va a «Cajas a controlar» hasta que la resuelva
-- escribiendo qué pasó. Si no marca nada, quedó todo bien.
--
-- Se marca LA CAJA (el turno), no una cifra suelta: la lista muestra en vivo la
-- diferencia del cierre, la del sobre y la de sus controles. Una sola marca
-- pendiente por turno (marcarla de nuevo suma la nota); resuelta, queda de
-- historial y el turno se puede volver a marcar.
--
-- `umbral_controlar`: desde qué diferencia la pantalla propone el tilde
-- (la decisión sigue siendo del dueño).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS "cajas_a_controlar" (
  "id" serial PRIMARY KEY,
  "caja_sesion_id" integer NOT NULL REFERENCES "caja_sesiones"("id") ON DELETE CASCADE,
  "origen" text NOT NULL,
  "nota" text NOT NULL DEFAULT '',
  "marcada_en" timestamp with time zone NOT NULL DEFAULT now(),
  "marcada_por" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "resuelta_en" timestamp with time zone,
  "resuelta_por" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "resolucion" text NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_caja_a_controlar_pendiente" ON "cajas_a_controlar" ("caja_sesion_id") WHERE "resuelta_en" IS NULL;
--> statement-breakpoint
ALTER TABLE "cashflow_caja" ADD COLUMN IF NOT EXISTS "umbral_controlar" double precision NOT NULL DEFAULT 5000;
