-- ===========================================================================
-- 0134 · CASH FLOW: «CONTAR MI CAJA» (4/10/2026, parte 3)
-- ===========================================================================
-- El dueño cuenta el efectivo que tiene en mano, billete por billete, y el
-- sistema lo compara con lo que debería haber (el saldo del libro). Cada
-- conteo queda guardado; si hubo diferencia y se ajustó, el ajuste es un
-- movimiento del libro (origen 'conteo') que apunta acá.
CREATE TABLE IF NOT EXISTS "cashflow_conteos" (
  "id" serial PRIMARY KEY,
  "fecha" timestamp with time zone NOT NULL DEFAULT now(),
  "billetes" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "otros" double precision NOT NULL DEFAULT 0,
  "contado" double precision NOT NULL,
  "esperado" double precision NOT NULL,
  "diferencia" double precision NOT NULL,
  "ajustado" boolean NOT NULL DEFAULT false,
  "motivo" text NOT NULL DEFAULT '',
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL
);
ALTER TABLE "cashflow_movimientos" ADD COLUMN IF NOT EXISTS "conteo_id" integer REFERENCES "cashflow_conteos"("id") ON DELETE RESTRICT;
