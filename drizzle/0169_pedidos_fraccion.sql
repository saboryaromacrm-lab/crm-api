-- ===========================================================================
-- 0169 · PEDIDOS DE FRACCIONADO DE LA DISTRIBUIDORA (15/10/2026)
-- ===========================================================================
-- Pedido del dueño: la Distribuidora se pide paquetes a sí misma (qué armar
-- para su góndola). Pendiente → hecho cuando el fraccionador registra lo
-- fraccionado desde el pedido. No mueve stock por sí mismo.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS "fraccion_pedidos" (
  "id" serial PRIMARY KEY,
  "sucursal_id" integer NOT NULL REFERENCES "sucursales"("id") ON DELETE RESTRICT,
  "estado" text NOT NULL DEFAULT 'pendiente' CHECK ("estado" IN ('pendiente', 'hecho')),
  "observaciones" text NOT NULL DEFAULT '',
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "creado_en" timestamptz NOT NULL DEFAULT now(),
  "actualizado_en" timestamptz NOT NULL DEFAULT now(),
  "hecho_en" timestamptz,
  "hecho_por" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "fraccionamiento_id" integer REFERENCES "fraccionamientos"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_fracc_pedidos_estado" ON "fraccion_pedidos" ("estado", "creado_en" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fraccion_pedido_items" (
  "id" serial PRIMARY KEY,
  "pedido_id" integer NOT NULL REFERENCES "fraccion_pedidos"("id") ON DELETE CASCADE,
  "producto_id" integer NOT NULL REFERENCES "productos"("id") ON DELETE CASCADE,
  "presentacion_id" integer REFERENCES "presentaciones"("id") ON DELETE SET NULL,
  "tam_kg" double precision NOT NULL,
  "paquetes" integer NOT NULL CHECK ("paquetes" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_fracc_pedido_items_pedido" ON "fraccion_pedido_items" ("pedido_id");
