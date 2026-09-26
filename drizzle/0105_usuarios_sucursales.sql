-- ===========================================================================
-- 0105 · CADA USUARIO TRABAJA EN SUS SUCURSALES (25/9/2026, QA del fraccionador)
-- ===========================================================================
-- La sucursal se elegia libremente al entrar: el fraccionador entraba "como"
-- el Deposito para preparar y despachar un pedido, y "como" la sucursal que lo
-- pedia para recibirlo. Todos los candados "solo tu sucursal" dependian de lo
-- que eligio en el login.
--
-- `sucursales` es la lista de sucursales en las que el usuario puede entrar.
-- VACIA = TODAS (lo de siempre): nadie queda afuera por esta migracion salvo
-- lo que se decide abajo. La administracion (admin y superadmin) entra a todas
-- aunque tenga la lista cargada: cruza sucursales por su selector.
--
-- LOS FRACCIONADORES, AL DEPOSITO: todo se fracciona en la distribuidora (ahi
-- llega el granel). Si alguno trabaja en otro lado, se le cambia desde
-- Gerencia > Usuarios.
-- ===========================================================================

ALTER TABLE "usuarios" ADD COLUMN IF NOT EXISTS "sucursales" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint

UPDATE "usuarios" u
   SET "sucursales" = d.ids
  FROM (SELECT coalesce(jsonb_agg(s.id ORDER BY s.id), '[]'::jsonb) AS ids
          FROM "sucursales" s WHERE s.tipo = 'distribuidora') d
 WHERE u.rol_id IN (SELECT id FROM "roles" WHERE clave = 'fraccionador')
   AND u."sucursales" = '[]'::jsonb
   AND d.ids <> '[]'::jsonb;
