-- ===========================================================================
-- 0166 · PROVEEDORES › MONTOS (14/10/2026, pedido del dueño)
-- ===========================================================================
-- Sección nueva, de solo lectura: la plata en mercadería de cada proveedor, a
-- costo. Es información de costos, así que la ve quien ya ve los estados de
-- cuenta de los proveedores. El superadmin pasa con el comodín.
-- ===========================================================================
UPDATE "roles" SET "permisos" = "permisos" || '["proveedores.montos"]'::jsonb
 WHERE "permisos" ? 'proveedores.edoc' AND NOT ("permisos" ? 'proveedores.montos');
