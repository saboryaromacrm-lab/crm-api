-- ===========================================================================
-- ALMACÉN — mercadería en tránsito y recepción con diferencias
-- ===========================================================================
-- `en_transito` cierra el agujero de que lo despachado no estaba en NINGUNA
-- sucursal: queda en el origen hasta que el destino firme. `cantidad_recibida`
-- registra lo que de verdad llegó, y `costo_unitario` congela el costo al
-- despachar para que Operaciones valúe "a costo" con verdad histórica.

ALTER TYPE "public"."estado_stock" ADD VALUE IF NOT EXISTS 'en_transito';
--> statement-breakpoint

ALTER TABLE "transferencias" ADD COLUMN "observaciones" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "transferencia_items" ADD COLUMN "cantidad_recibida" double precision;
--> statement-breakpoint
ALTER TABLE "transferencia_items" ADD COLUMN "costo_unitario" double precision DEFAULT 0 NOT NULL;
