-- ===========================================================================
-- 0163 · ALMACÉN › BAJOS EN STOCK (12/10/2026, pedido del dueño)
-- ===========================================================================
-- Sección nueva, de solo lectura (más el mínimo a mano del producto, que ya
-- existía como `productos.stock_min`). La ve quien ya ve Existencias: es la
-- misma información mirada por proveedor. El superadmin pasa con el comodín.
-- ===========================================================================
UPDATE "roles" SET "permisos" = "permisos" || '["almacen.bajos"]'::jsonb
 WHERE "permisos" ? 'almacen.existencias' AND NOT ("permisos" ? 'almacen.bajos');
