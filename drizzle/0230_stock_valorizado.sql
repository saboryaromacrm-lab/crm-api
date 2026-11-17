-- ===========================================================================
-- 0230 · GERENCIA › STOCK VALORIZADO (17/11/2026, pedido del dueño)
-- ===========================================================================
-- La pestaña Stock de Métricas pasa a ser una sección propia con su llave.
-- Quien veía Métricas la sigue viendo: nadie pierde acceso. El superadmin pasa
-- con el comodín.
-- ===========================================================================
UPDATE "roles" SET "permisos" = "permisos" || '["gerencia.stock"]'::jsonb
 WHERE "permisos" ? 'gerencia.metricas' AND NOT ("permisos" ? 'gerencia.stock');
