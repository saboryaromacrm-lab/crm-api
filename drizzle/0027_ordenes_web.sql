-- Órdenes web: el pedido del sitio nace en estado `pendiente` (bandeja de
-- revisión) con su origen marcado en columna propia, y puede llegar SIN
-- cliente (DNI desconocido: los datos esperan en web_cliente hasta aceptar).
ALTER TYPE "estado_presupuesto" ADD VALUE IF NOT EXISTS 'pendiente';
--> statement-breakpoint
ALTER TABLE "presupuestos" ADD COLUMN "origen" text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
ALTER TABLE "presupuestos" ADD COLUMN "web_cliente" jsonb;
--> statement-breakpoint
ALTER TABLE "presupuestos" ALTER COLUMN "cliente_id" DROP NOT NULL;
--> statement-breakpoint
-- Backfill de los pedidos web identificables (los que conservaron la marca en observaciones).
UPDATE "presupuestos" SET "origen" = 'web' WHERE "observaciones" = 'Pedido recibido desde el sitio web.';
--> statement-breakpoint
-- La bandeja de órdenes es una sección nueva del módulo Ventas.
UPDATE "roles" SET "permisos" = "permisos" || '["ventas.ordenes"]'::jsonb WHERE "clave" = 'admin';
