-- ===========================================================================
-- 0225 · USUARIOS Y ROLES Y SUCURSALES PASAN A SISTEMA (9/11/2026, pedido del dueño)
-- ===========================================================================
-- «Usuarios y roles de Gerencia llevarlo a Sistema, y aparte también
-- Sucursales.» Gerencia queda para los números del negocio; quién entra, con
-- qué permisos y los locales son configuración del sistema.
--
-- Las llaves cambian de nombre y Sucursales tiene la suya:
--   gerencia.usuarios  →  sistema.usuarios   (Usuarios, Empleados, Roles y permisos)
--                      +  sistema.sucursales (Sistema › Sucursales)
-- Cada rol que tenía `gerencia.usuarios` sigue viendo lo mismo: recibe las dos.
-- ===========================================================================
UPDATE "roles"
   SET "permisos" = (
     SELECT jsonb_agg(DISTINCT x ORDER BY x) FROM (
       SELECT CASE WHEN e = 'gerencia.usuarios' THEN 'sistema.usuarios' ELSE e END AS x
         FROM jsonb_array_elements_text("roles"."permisos") AS e
       UNION SELECT 'sistema.sucursales'
     ) t)
 WHERE "permisos" ? 'gerencia.usuarios';
