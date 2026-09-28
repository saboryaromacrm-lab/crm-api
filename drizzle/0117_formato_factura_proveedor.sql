-- ===========================================================================
-- 0117 · CON QUÉ FORMATO SE LEEN LAS FACTURAS DE CADA PROVEEDOR (28/9/2026)
-- ===========================================================================
-- La lectura de facturas PDF se mudó al navegador y sus recetas pasaron a ser
-- FORMATOS que se le asignan al proveedor (varios comparten el de Tango). La
-- columna guarda el id del formato; vacía = el proveedor todavía no tiene
-- estructura. Bavosi, que tenía su receta atada al CUIT, conserva la suya.
-- ===========================================================================

ALTER TABLE "proveedores" ADD COLUMN IF NOT EXISTS "formato_factura" text NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE "proveedores" SET "formato_factura" = 'tango-bavosi'
WHERE regexp_replace("cuit", '\D', '', 'g') = '30629646708' AND "formato_factura" = '';
