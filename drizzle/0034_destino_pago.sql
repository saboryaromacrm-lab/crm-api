-- DESTINO DEL PAGO A PROVEEDOR: mercadería o gastos.
-- Lo elige la cajera al registrar el egreso; reparte las bandejas (Compras ›
-- Pagos en sucursal vs Gastos › Pagos en sucursal) y restringe la aplicación:
-- cada pago solo se aplica a documentos de su mundo.
CREATE TYPE "destino_pago_prov" AS ENUM('mercaderia', 'gastos');
--> statement-breakpoint
ALTER TABLE "proveedor_pagos" ADD COLUMN "destino" "destino_pago_prov" DEFAULT 'mercaderia' NOT NULL;
--> statement-breakpoint
-- Backfill de los pagos existentes. La imputación es la mejor evidencia de a
-- qué mundo pertenece cada uno; para los sin aplicar deciden las marcas del
-- proveedor (el que SOLO factura gastos no puede ser de mercadería).
UPDATE "proveedor_pagos" p SET "destino" = 'gastos'
WHERE EXISTS (SELECT 1 FROM "proveedor_imputaciones" i WHERE i."pago_id" = p."id" AND i."gasto_id" IS NOT NULL);
--> statement-breakpoint
UPDATE "proveedor_pagos" p SET "destino" = 'mercaderia'
WHERE EXISTS (SELECT 1 FROM "proveedor_imputaciones" i WHERE i."pago_id" = p."id" AND i."comprobante_id" IS NOT NULL);
--> statement-breakpoint
UPDATE "proveedor_pagos" p SET "destino" = 'gastos'
WHERE p."aplicado" <= 0.009
  AND (
    p."proveedor_id" IS NULL
    OR EXISTS (
      SELECT 1 FROM "proveedores" pr
      WHERE pr."id" = p."proveedor_id" AND pr."provee_gastos" = true AND pr."provee_mercaderia" = false
    )
  );
--> statement-breakpoint
-- La bandeja de Compras es una sección nueva con su propio permiso.
UPDATE "roles" SET "permisos" = "permisos" || '["compras.pagos"]'::jsonb WHERE "clave" = 'admin';
