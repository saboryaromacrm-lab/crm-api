-- ===========================================================================
-- 0141 · LOS COSTOS DE LOS INGREDIENTES VIAJAN A COFFITCOST (7/10/2026)
-- ===========================================================================
-- CoffitCost (la app de recetas de Coffit) recibe los costos por POST con su
-- clave (`X-API-Key`). El nombre tiene que ser el de CoffitCost, así que cada
-- ingrediente lleva el suyo; y se suma la unidad «docena» (huevos).
-- Cada envío queda registrado: cuándo, cuántos, la respuesta, y la firma de
-- lo enviado (para mandar solo cuando algún costo cambió).
ALTER TABLE "coffit_ingredientes" ADD COLUMN IF NOT EXISTS "nombre_coffit" text NOT NULL DEFAULT '';
ALTER TABLE "coffit_ingredientes" DROP CONSTRAINT IF EXISTS "coffit_ingredientes_unidad_costo_check";
ALTER TABLE "coffit_ingredientes" ADD CONSTRAINT "coffit_ingredientes_unidad_costo_check"
  CHECK ("unidad_costo" IN ('kg', 'g', '100g', 'l', 'ml', '100ml', 'u', 'doc'));

CREATE TABLE IF NOT EXISTS "coffitcost_envios" (
  "id" serial PRIMARY KEY,
  "fecha" timestamp with time zone NOT NULL DEFAULT now(),
  "referencia" text NOT NULL DEFAULT '',
  "origen" text NOT NULL DEFAULT 'manual' CHECK ("origen" IN ('manual', 'automatico')),
  "cantidad" integer NOT NULL DEFAULT 0,
  "ok" boolean NOT NULL DEFAULT false,
  "estado_http" integer,
  "respuesta" text NOT NULL DEFAULT '',
  "firma" text NOT NULL DEFAULT '',
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "ix_coffitcost_envios_fecha" ON "coffitcost_envios" ("id" DESC);
