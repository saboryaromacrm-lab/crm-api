-- ===========================================================================
-- 0170 · PEDIDOS DE LA CAJA A FRACCIONADO (16/10/2026)
-- ===========================================================================
-- Pedido del dueño: en la Distribuidora el cliente pide «un paquete de avena
-- de 400 g» que no está en la góndola; el cajero lo pide desde la caja y
-- fraccionado lo arma. Es el mismo pedido de fraccionado de la 0169 con otro
-- origen y dos estados más:
--   pendiente → armando (alguien lo tomó, con su operador) → hecho (registra
--   el fraccionado en la misma transacción) | rechazado (con motivo).
-- `hecho_en` / `hecho_por` = cuándo y quién lo cerró (hecho o rechazado).
-- `visto_en` = el cajero ya vio cómo terminó (se le deja de mostrar).
-- ===========================================================================
ALTER TABLE "fraccion_pedidos" ADD COLUMN IF NOT EXISTS "origen" text NOT NULL DEFAULT 'distribuidora';
--> statement-breakpoint
ALTER TABLE "fraccion_pedidos" DROP CONSTRAINT IF EXISTS "fraccion_pedidos_origen_check";
--> statement-breakpoint
ALTER TABLE "fraccion_pedidos" ADD CONSTRAINT "fraccion_pedidos_origen_check" CHECK ("origen" IN ('distribuidora', 'caja'));
--> statement-breakpoint
ALTER TABLE "fraccion_pedidos" DROP CONSTRAINT IF EXISTS "fraccion_pedidos_estado_check";
--> statement-breakpoint
ALTER TABLE "fraccion_pedidos" ADD CONSTRAINT "fraccion_pedidos_estado_check" CHECK ("estado" IN ('pendiente', 'armando', 'hecho', 'rechazado'));
--> statement-breakpoint
ALTER TABLE "fraccion_pedidos" ADD COLUMN IF NOT EXISTS "tomado_en" timestamptz;
--> statement-breakpoint
ALTER TABLE "fraccion_pedidos" ADD COLUMN IF NOT EXISTS "tomado_por" integer REFERENCES "usuarios"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "fraccion_pedidos" ADD COLUMN IF NOT EXISTS "operador_id" integer REFERENCES "fraccion_operadores"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "fraccion_pedidos" ADD COLUMN IF NOT EXISTS "motivo" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "fraccion_pedidos" ADD COLUMN IF NOT EXISTS "visto_en" timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_fracc_pedidos_caja_usuario" ON "fraccion_pedidos" ("usuario_id", "creado_en" DESC) WHERE "origen" = 'caja';
