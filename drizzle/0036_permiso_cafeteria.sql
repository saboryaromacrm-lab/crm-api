-- La sección Almacén › Cafetería es de administración: envíos valorizados a
-- costo hacia el otro negocio del dueño. Los cajeros no la necesitan.
UPDATE "roles" SET "permisos" = "permisos" || '["almacen.cafeteria"]'::jsonb
WHERE "clave" IN ('admin', 'superadmin') AND NOT ("permisos" ? 'almacen.cafeteria');
