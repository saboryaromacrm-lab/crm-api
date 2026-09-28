-- ===========================================================================
-- 0116 · LA CAFETERÍA SE LLAMA COFFIT (28/9/2026, pedido del dueño)
-- ===========================================================================
-- En pantallas, avisos y remitos el café pasó a nombrarse "Coffit". Lo único
-- que vive en la base es el nombre del rol y el del usuario del café. Solo se
-- tocan si siguen con el nombre de fábrica: si alguien ya los renombró a mano
-- en Gerencia › Usuarios y roles, se respeta. La clave `cafeteria` y los
-- permisos NO cambian.
-- ===========================================================================

UPDATE "roles" SET "nombre" = 'Coffit',
  "descripcion" = 'El usuario de Coffit: arma el pedido a la distribuidora y le sigue el estado, y carga lo que manda a las sucursales.'
WHERE "clave" = 'cafeteria' AND "nombre" = 'Cafetería';
--> statement-breakpoint
UPDATE "usuarios" SET "nombre" = 'Coffit'
WHERE "nombre" IN ('Cafetería (Coffit)', 'Cafetería');
