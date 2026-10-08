-- ===========================================================================
-- 0146 · RETIROS SIN COSTO (8/10/2026, pedido del dueño)
-- ===========================================================================
-- Los socios se llevan mercadería del local. En el POS se arma el ticket como
-- siempre, pero con un cliente marcado «Retiros sin costo»: no se cobra nada,
-- baja el stock y queda el COSTO REAL congelado de cada renglón, en la ficha
-- del cliente («cuánto consumo en costo»).
--
-- ES UN DOCUMENTO APARTE A PROPÓSITO, no una venta en $0: una venta en cero
-- ensucia el ticket promedio, deja margen negativo en Rentabilidad y entra al
-- arqueo, al IVA, al ranking de clientes y a ARCA. El retiro NO TOCA ventas,
-- caja, ARCA, IVA ni las métricas de ventas: tablas propias y un tipo de
-- movimiento propio ('retiro'), que ninguna suma de ventas ni de pérdidas lee.
-- ===========================================================================
ALTER TYPE "tipo_movimiento" ADD VALUE IF NOT EXISTS 'retiro';
--> statement-breakpoint
ALTER TABLE "clientes" ADD COLUMN IF NOT EXISTS "retiro_sin_costo" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retiros" (
  "id" serial PRIMARY KEY,
  "fecha" timestamp with time zone NOT NULL DEFAULT now(),
  "cliente_id" integer NOT NULL REFERENCES "clientes"("id") ON DELETE RESTRICT,
  "sucursal_id" integer REFERENCES "sucursales"("id") ON DELETE SET NULL,
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "costo_total" double precision NOT NULL DEFAULT 0,
  "anulado_en" timestamp with time zone,
  "anulado_por" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "anulado_motivo" text NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_retiros_cliente" ON "retiros" ("cliente_id", "fecha" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_retiros_fecha" ON "retiros" ("fecha");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retiro_items" (
  "id" serial PRIMARY KEY,
  "retiro_id" integer NOT NULL REFERENCES "retiros"("id") ON DELETE CASCADE,
  "producto_id" integer NOT NULL REFERENCES "productos"("id") ON DELETE RESTRICT,
  "presentacion_id" integer REFERENCES "presentaciones"("id") ON DELETE SET NULL,
  "nombre" text NOT NULL DEFAULT '',
  "cantidad" double precision NOT NULL,
  "costo_unitario" double precision NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_retiro_items_retiro" ON "retiro_items" ("retiro_id");
