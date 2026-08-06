-- El envío a Cafetería gana ciclo de vida con el stock acompañando:
-- pedido (demanda, sin stock) → transito (disponible → en_transito, costo
-- congelado al despachar) → recibido (egresa del CRM). Se rearma el enum:
-- 'confirmado' (el estado único de la fase anterior) equivale a 'recibido'.
ALTER TABLE "envios_cafeteria" ALTER COLUMN "estado" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "envios_cafeteria" ALTER COLUMN "estado" TYPE text;--> statement-breakpoint
DROP TYPE "estado_envio_cafe";--> statement-breakpoint
CREATE TYPE "estado_envio_cafe" AS ENUM ('pedido', 'transito', 'recibido', 'anulado');--> statement-breakpoint
UPDATE "envios_cafeteria" SET "estado" = 'recibido' WHERE "estado" = 'confirmado';--> statement-breakpoint
ALTER TABLE "envios_cafeteria" ALTER COLUMN "estado" TYPE "estado_envio_cafe" USING "estado"::"estado_envio_cafe";--> statement-breakpoint
ALTER TABLE "envios_cafeteria" ALTER COLUMN "estado" SET DEFAULT 'pedido';--> statement-breakpoint
ALTER TABLE "envios_cafeteria" ALTER COLUMN "estado" SET NOT NULL;
