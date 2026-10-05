-- ===========================================================================
-- 0138 · STOCK PROVISORIO DE GRANEL (5/10/2026, pedido del dueño) — TEMPORAL
-- ===========================================================================
-- Una planilla APARTE, en Proveedores, para anotar cuántas BOLSAS CERRADAS hay
-- de cada producto a granel madre, contadas a ojo en el depósito, mientras el
-- stock real del sistema no está confiable. NO toca `stock`, ni ventas, ni
-- compras: nadie más la lee. Cada conteo queda guardado (fecha, quién, cuánto).
--
-- PARA ELIMINARLA el día que el stock real esté bien: borrar el módulo
-- `src/stock-provisorio`, el panel del ERP y una migración nueva con
--   DROP TABLE "stock_provisorio_conteos";
--   UPDATE "roles" SET "permisos" = "permisos" - 'proveedores.stock_provisorio';
CREATE TABLE IF NOT EXISTS "stock_provisorio_conteos" (
  "id" serial PRIMARY KEY,
  "producto_id" integer NOT NULL REFERENCES "productos"("id") ON DELETE CASCADE,
  "bolsas" integer NOT NULL CHECK ("bolsas" >= 0),
  "fecha" timestamp with time zone NOT NULL DEFAULT now(),
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "observacion" text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS "ix_stock_provisorio_producto" ON "stock_provisorio_conteos" ("producto_id", "id" DESC);
-- Solo administración (decisión del dueño); el superadmin pasa con el comodín.
UPDATE "roles" SET "permisos" = "permisos" || '["proveedores.stock_provisorio"]'::jsonb
WHERE "clave" = 'admin' AND NOT ("permisos" ? 'proveedores.stock_provisorio');
