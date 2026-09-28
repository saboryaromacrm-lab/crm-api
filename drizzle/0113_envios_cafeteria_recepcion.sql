-- ===========================================================================
-- 0113 · CONTROL DE RECEPCIÓN DE LOS ENVÍOS DE CAFETERÍA (27/9/2026)
-- ===========================================================================
-- Pedido del dueño: todo envío de mercadería se imprime siempre, y el que lo
-- recibe lo CONTROLA contra el remito y lo marca recibido, en los dos
-- sentidos (distribuidora → café y café → sucursal).
--
--   recepcion      pendiente | recibido | con_diferencias
--   recibido_en    cuándo se controló
--   recibido_por   quién lo controló
--   recepcion_obs  lo que anotó al recibir
--   cantidad_recibida (por renglón) lo que contó
--
-- En una ENTRADA (café → sucursal) el stock de la sucursal se mueve recién al
-- recibir, con lo contado. Los envíos YA EXISTENTES quedan como `recibido`
-- con lo enviado como recibido: su stock ya se movió al crearlos.
-- ===========================================================================

ALTER TABLE "envios_cafeteria" ADD COLUMN IF NOT EXISTS "recepcion" text NOT NULL DEFAULT 'recibido';
--> statement-breakpoint
ALTER TABLE "envios_cafeteria" ALTER COLUMN "recepcion" SET DEFAULT 'pendiente';
--> statement-breakpoint
ALTER TABLE "envios_cafeteria" ADD COLUMN IF NOT EXISTS "recibido_en" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "envios_cafeteria" ADD COLUMN IF NOT EXISTS "recibido_por" integer REFERENCES "usuarios"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "envios_cafeteria" ADD COLUMN IF NOT EXISTS "recepcion_obs" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "envio_cafeteria_items" ADD COLUMN IF NOT EXISTS "cantidad_recibida" double precision;
--> statement-breakpoint
UPDATE "envio_cafeteria_items" SET "cantidad_recibida" = "cantidad" WHERE "cantidad_recibida" IS NULL;
