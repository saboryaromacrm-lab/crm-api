-- ENVÍOS A CAFETERÍA, MODELO NUEVO (9/8/2026)
-- ============================================================================
-- Tres decisiones del dueño:
--   · El DESTINO (venta/uso) es una decisión de coffit, no de Sabor y Aroma:
--     coffit crea un almacén "Sabor y Aroma" y clasifica al recibir. El CRM
--     escribía este campo y jamás lo leía.
--   · SIN etapas: con el envío ya se da por hecho que coffit lo recibió. El
--     ciclo queda enviado | anulado, y la corrección es EDITAR el envío.
--   · SIN devoluciones.
-- Más lo que el edit exige: version + actualizado_en (el pulso que coffit
-- sincroniza) y el modo de unidad EXPLÍCITO por renglón (antes se deducía de
-- presentacion_id null — la ambigüedad que convierte 10 paquetes en 10 kg).
--
-- Los envíos existentes son pruebas locales (decisión del dueño): se borran,
-- junto con sus huellas en el registro de movimientos.

DELETE FROM envio_cafeteria_items;
--> statement-breakpoint
DELETE FROM movimientos WHERE tipo = 'envio_cafeteria' OR descripcion ~ '^CAFD?[0-9]{4}:';
--> statement-breakpoint
DELETE FROM envios_cafeteria;
--> statement-breakpoint

-- El destino se va (columna y tipo).
ALTER TABLE "envio_cafeteria_items" DROP COLUMN IF EXISTS "destino";
--> statement-breakpoint
DROP TYPE IF EXISTS "destino_envio_cafe";
--> statement-breakpoint

-- El tipo se va: sin devoluciones queda un solo valor, y una columna de un
-- solo valor es ruido.
ALTER TABLE "envios_cafeteria" DROP COLUMN IF EXISTS "tipo";
--> statement-breakpoint
DROP TYPE IF EXISTS "tipo_envio_cafe";
--> statement-breakpoint

-- El estado pasa a enviado | anulado. Postgres NO puede quitar valores de un
-- enum: se crea el tipo nuevo, se convierte la columna y se tira el viejo.
ALTER TABLE "envios_cafeteria" ALTER COLUMN "estado" DROP DEFAULT;
--> statement-breakpoint
CREATE TYPE "estado_envio_cafe_v2" AS ENUM ('enviado', 'anulado');
--> statement-breakpoint
ALTER TABLE "envios_cafeteria" ALTER COLUMN "estado" TYPE "estado_envio_cafe_v2"
  USING (CASE WHEN "estado"::text = 'anulado' THEN 'anulado' ELSE 'enviado' END)::"estado_envio_cafe_v2";
--> statement-breakpoint
DROP TYPE "estado_envio_cafe";
--> statement-breakpoint
ALTER TYPE "estado_envio_cafe_v2" RENAME TO "estado_envio_cafe";
--> statement-breakpoint
ALTER TABLE "envios_cafeteria" ALTER COLUMN "estado" SET DEFAULT 'enviado';
--> statement-breakpoint

-- El modo de unidad explícito por renglón + los kg por unidad.
CREATE TYPE "modo_envio_cafe" AS ENUM ('granel', 'paquete', 'unidad');
--> statement-breakpoint
ALTER TABLE "envio_cafeteria_items" ADD COLUMN "modo" "modo_envio_cafe" DEFAULT 'unidad' NOT NULL;
--> statement-breakpoint
ALTER TABLE "envio_cafeteria_items" ADD COLUMN "tam_kg" double precision DEFAULT 0 NOT NULL;
--> statement-breakpoint

-- El pulso para coffit.
ALTER TABLE "envios_cafeteria" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "envios_cafeteria" ADD COLUMN "actualizado_en" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_envios_cafe_actualizado" ON "envios_cafeteria" ("actualizado_en");
