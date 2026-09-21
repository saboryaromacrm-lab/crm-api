-- ===========================================================================
-- 0098 · LA CAFETERÍA COMO INTERLOCUTOR, NO COMO SUCURSAL
-- ===========================================================================
-- Dos cambios que van juntos porque son la misma idea: la cafetería no está
-- adentro de una sucursal, habla CON las sucursales.
--
--  1. El pedido ahora dice A QUIÉN se le pide. Antes iba "a la distribuidora"
--     por defecto y nadie decidía nada; ahora la cafetería elige la sucursal,
--     ve la disponibilidad de ESA sucursal al pedir, y el envío que lo cumple
--     sale de ahí y de ningún otro lado.
--
--     Nace NULA a propósito: los pedidos que ya existen no tienen a quién
--     atribuirles y ponerles uno a dedo sería inventar un dato. Se muestran
--     como "—" y la obligatoriedad corre solo para los nuevos, en la API.
--
--  2. `roles.sin_sucursal` marca los puestos que trabajan FUERA de las
--     sucursales. Hoy es uno solo (la cafetería), pero va en el rol y no en el
--     usuario: es una propiedad del puesto, no de la persona, y así el día que
--     haya otro (un repartidor, un vendedor de calle) funciona sin tocar nada.
--     La pantalla de login deja de pedirle sucursal y el servidor se la ignora
--     si la manda igual.
-- ===========================================================================

ALTER TABLE "pedidos_cafeteria"
  ADD COLUMN IF NOT EXISTS "sucursal_id" integer REFERENCES "sucursales"("id") ON DELETE RESTRICT;

-- La lista de pedidos se filtra por sucursal en cada carga y en cada poll del
-- contador del menú: van las dos columnas juntas porque siempre se preguntan
-- juntas ("los pendientes DE ESTA sucursal").
CREATE INDEX IF NOT EXISTS "ix_pedidos_cafe_sucursal" ON "pedidos_cafeteria" ("sucursal_id", "estado");

ALTER TABLE "roles"
  ADD COLUMN IF NOT EXISTS "sin_sucursal" boolean NOT NULL DEFAULT false;

UPDATE "roles" SET "sin_sucursal" = true WHERE "clave" = 'cafeteria';
