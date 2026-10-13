-- ===========================================================================
-- 0162 · SE QUITA EL STOCK PROVISORIO DE GRANEL (12/10/2026, pedido del dueño)
-- ===========================================================================
-- La planilla temporal de 0138 (bolsas cerradas contadas a ojo) se hizo
-- mientras el stock real no era confiable. Ya se controló el stock real: se
-- borra, como estaba previsto en el encabezado de 0138. Era una isla: nada
-- del sistema la leía (solo su propia sección y el cuadro «bolsas a ojo» del
-- pedido entre sucursales, que también se van). NO toca `stock`,
-- `movimientos`, controles ni productos.
-- ===========================================================================
DROP TABLE IF EXISTS "stock_provisorio_conteos";
--> statement-breakpoint
UPDATE "roles" SET "permisos" = "permisos" - 'proveedores.stock_provisorio'
 WHERE "permisos" ? 'proveedores.stock_provisorio';
