-- 0209 · GERENCIA › INDICADORES (1/11/2026, pedido del dueño: «mostrarle datos a mi encargada pero
-- sin montos, solo porcentajes»). Los % se calculan en el servidor; los objetivos viven en
-- `configuracion` (clave `indicadores_objetivos`) y los cambia solo el superadmin.
-- Decisión del dueño: la ve el rol Administrador (Karen, la encargada; también Agustín).
UPDATE roles
   SET permisos = permisos || '["gerencia.indicadores"]'::jsonb
 WHERE clave = 'admin'
   AND NOT (permisos @> '["gerencia.indicadores"]'::jsonb);
