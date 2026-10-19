-- ===========================================================================
-- 0183 · SIN «PRODUCTOS DEL SITIO» EN TIENDA ONLINE (19/10/2026)
-- ===========================================================================
-- La foto, el destacado y el mínimo web de cada producto pasaron a Compras ›
-- Productos (pestaña «Tienda online» del detalle), con la llave de esa
-- sección. La llave `web.productos` ya no existe: se saca de los roles para
-- que no quede colgada. Idempotente.
UPDATE roles SET permisos = permisos - 'web.productos' WHERE permisos ? 'web.productos';
