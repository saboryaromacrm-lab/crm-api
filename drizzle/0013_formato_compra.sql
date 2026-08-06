-- ===========================================================================
-- FORMATO DE COMPRA — cómo entra el producto
-- ===========================================================================
-- `producto_proveedores` deja de ser "el costo del producto en tal proveedor" y
-- pasa a ser un FORMATO DE COMPRA: cantidad por bulto, escala de descuentos y
-- flete. Un producto puede tener varios, incluso del mismo proveedor (caja x12
-- y caja x24), y uno solo define el costo con el que se calcula el precio.
--
-- Se EXTIENDE la tabla en vez de crear una nueva a propósito: el historial de
-- costos (`producto_proveedor_costos`, con auditoría y deshacer) apunta a estas
-- filas. Con una tabla nueva habría que migrar ese historial, y un error ahí no
-- se recupera. Extendiendo, los ids sobreviven y el historial sigue válido.
--
-- Las filas que ya existen quedan como "formato x1 en modo lista", que es
-- exactamente lo que eran.

CREATE TYPE "public"."modo_costo" AS ENUM('lista', 'final');
--> statement-breakpoint

-- El mismo proveedor puede vender el mismo producto en dos formatos distintos.
DROP INDEX IF EXISTS "uq_producto_proveedor";
--> statement-breakpoint

ALTER TABLE "producto_proveedores" ADD COLUMN "cantidad" double precision DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "producto_proveedores" ADD COLUMN "descuento2" double precision DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "producto_proveedores" ADD COLUMN "descuento3" double precision DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "producto_proveedores" ADD COLUMN "descuento4" double precision DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "producto_proveedores" ADD COLUMN "modo_costo" "modo_costo" DEFAULT 'lista' NOT NULL;
--> statement-breakpoint
ALTER TABLE "producto_proveedores" ADD COLUMN "costo_final" double precision DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "producto_proveedores" ADD COLUMN "usar_para_precio" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- El formato que define el precio es el del proveedor que hoy está activo. Si
-- el producto no tiene proveedor activo, gana el de menor id (el mismo criterio
-- de desempate que ya usaba el código al leer).
UPDATE "producto_proveedores" pp SET "usar_para_precio" = true
FROM "productos" p
WHERE p."id" = pp."producto_id" AND p."proveedor_activo_id" = pp."proveedor_id";
--> statement-breakpoint
UPDATE "producto_proveedores" pp SET "usar_para_precio" = true
WHERE pp."id" = (
  SELECT MIN(x."id") FROM "producto_proveedores" x
  WHERE x."producto_id" = pp."producto_id"
    AND NOT EXISTS (
      SELECT 1 FROM "producto_proveedores" y
      WHERE y."producto_id" = x."producto_id" AND y."usar_para_precio"
    )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "ix_producto_proveedores_producto" ON "producto_proveedores" USING btree ("producto_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_producto_proveedores_proveedor" ON "producto_proveedores" USING btree ("proveedor_id");
--> statement-breakpoint

-- Ya nadie lo lee: el proveedor que fija el costo sale del formato marcado con
-- `usar_para_precio`. Dejarlo sería una segunda fuente de verdad para el mismo
-- dato, y con varios formatos por proveedor ni siquiera alcanzaba.
ALTER TABLE "productos" DROP COLUMN IF EXISTS "proveedor_activo_id";
