-- 24/11/2026: Almacén › Ingresos (el historial de pedidos recibidos, que vivía en Proveedores › Pedidos).
-- Llave propia; la reciben de entrada los roles que ya veían Pedidos, que son los que lo veían.
UPDATE "roles" SET "permisos" = "permisos" || '["almacen.ingresos"]'::jsonb
 WHERE "permisos" ? 'proveedores.pedidos' AND NOT ("permisos" ? 'almacen.ingresos');
