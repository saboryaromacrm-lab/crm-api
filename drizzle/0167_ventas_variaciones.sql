-- ===========================================================================
-- 0167 · VENTAS › VARIACIONES (14/10/2026, pedido del dueño)
-- ===========================================================================
-- Sección nueva, de solo lectura: cuánto subió o bajó lo vendido entre dos
-- períodos, en cantidad y en plata (sin costos ni margen). La ve la
-- administración; el superadmin pasa con el comodín.
-- ===========================================================================
UPDATE "roles" SET "permisos" = "permisos" || '["ventas.variaciones"]'::jsonb
 WHERE "clave" = 'admin' AND NOT ("permisos" ? 'ventas.variaciones');
