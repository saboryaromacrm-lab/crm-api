-- ===========================================================================
-- 0224 · EL ROL DICE CÓMO ENTRA A LAS SUCURSALES (9/11/2026, pedido del dueño)
-- ===========================================================================
-- «¿Dónde pongo en un rol si le pide la sucursal donde trabaja o es libre como
-- el superadmin?» Hasta acá eran dos cosas sueltas: la marca `sin_sucursal`
-- (0098, solo la cafetería, sin pantalla) y «Administrador y Superadmin entran a
-- todas», atado a la clave del rol en el código. Ahora es un campo del rol, con
-- tres valores, que se elige en Gerencia › Usuarios y roles › Roles y permisos:
--
--   usuario  entra en las sucursales tildadas en su usuario (ninguna = elige
--            cualquiera al entrar) y se queda en esa. Lo de siempre.
--   libre    entra en cualquiera y cambia desde el encabezado, como el admin.
--            No le da más permisos: solo dónde puede pararse.
--   ninguna  no trabaja en una sucursal y no se le pide (la cafetería).
--
-- Cada rol arranca como venía: la cafetería en «ninguna», Administrador y
-- Superadmin en «libre», el resto en «usuario». El superadmin cruza siempre
-- (el comodín), diga lo que diga el campo.
-- ===========================================================================
DO $$ BEGIN
  CREATE TYPE "modo_sucursal" AS ENUM ('usuario', 'libre', 'ninguna');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "roles"
  ADD COLUMN IF NOT EXISTS "modo_sucursal" "modo_sucursal" NOT NULL DEFAULT 'usuario';

UPDATE "roles" SET "modo_sucursal" = 'ninguna' WHERE "sin_sucursal";
UPDATE "roles" SET "modo_sucursal" = 'libre'
 WHERE NOT "sin_sucursal" AND ("clave" IN ('admin', 'superadmin') OR "permisos" ? '*');

ALTER TABLE "roles" DROP COLUMN IF EXISTS "sin_sucursal";
