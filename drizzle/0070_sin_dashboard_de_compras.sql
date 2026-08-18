-- 0070 · EL DASHBOARD DE COMPRAS DEJA DE EXISTIR COMO SECCIÓN
-- ---------------------------------------------------------------------------
-- El resumen del inventario (valor disponible, stock bajo, stock por sucursal,
-- últimos movimientos) se mudó a la pantalla **Dashboard del menú principal**,
-- que hasta ahora mostraba métricas de ejemplo. La pestaña dentro de Compras ya
-- no existe, así que su clave de permiso no habilita nada.
--
-- Se saca de los roles para que no quede colgada: una clave que ya no está en
-- el catálogo no se puede ver ni quitar desde Gerencia, y quedaría ahí para
-- siempre confundiendo a quien mire.
--
-- Nadie pierde acceso: el Dashboard usa el permiso general 'dashboard' y le
-- muestra el resumen a quien tenga alguna sección de Compras o Almacén.
--
-- `permisos` es un array JSONB en la tabla `roles` (no hay tabla puente): se
-- reconstruye sin ese elemento, y el WHERE evita tocar a los roles que no la
-- tienen — incluido el `['*']` del superadmin, que sigue intacto.
UPDATE "roles"
SET "permisos" = (
  SELECT coalesce(jsonb_agg(elem), '[]'::jsonb)
  FROM jsonb_array_elements("permisos") AS elem
  WHERE elem <> '"compras.dashboard"'::jsonb
)
WHERE "permisos" @> '["compras.dashboard"]'::jsonb;
