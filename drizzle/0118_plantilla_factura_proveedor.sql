-- ===========================================================================
-- 0118 · LA ESTRUCTURA PROPIA DE LAS FACTURAS DE UN PROVEEDOR (28/9/2026)
-- ===========================================================================
-- El asistente de Procesamiento de facturas guarda acá las posiciones de las
-- columnas (código, descripción, cantidad, precio, importe…) que la persona
-- marcó en un renglón de ejemplo. Con eso el navegador lee solas las
-- próximas facturas de ese proveedor, sin tocar el sistema. Nula = no tiene.
-- ===========================================================================

ALTER TABLE "proveedores" ADD COLUMN IF NOT EXISTS "plantilla_factura" jsonb;
