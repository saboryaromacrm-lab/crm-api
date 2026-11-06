-- ===========================================================================
-- 0221 · EL PERSONAL, PARA LOS ADELANTOS DE SUELDO (6/11/2026, pedido del dueño)
-- ===========================================================================
-- «En Gerencia › Usuarios, cargar nombres de empleados que no usan el sistema;
-- y al sacar un adelanto, que sí o sí pida el nombre de esa lista y también de
-- los usuarios que usan el sistema que también son empleados.»
--
-- Una sola lista, `personal`: cada fila es un empleado.
--   · con `usuario_id`: un usuario del ERP marcado «es empleado» (su nombre es
--     el del usuario; a lo sumo una fila por usuario);
--   · sin `usuario_id`: alguien que no usa el sistema (solo el nombre).
-- El adelanto (egreso con concepto de adelanto) guarda a quién se le dio en
-- `personal_id`, tanto en la caja central como en la caja de los locales. Los
-- adelantos de antes quedan en NULL (solo tenían el detalle escrito a mano).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS "personal" (
  "id" serial PRIMARY KEY,
  "nombre" text NOT NULL DEFAULT '',
  "usuario_id" integer UNIQUE REFERENCES "usuarios"("id") ON DELETE CASCADE,
  "activo" boolean NOT NULL DEFAULT true,
  "creado_en" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ck_personal_nombre" CHECK ("usuario_id" IS NOT NULL OR btrim("nombre") <> '')
);
ALTER TABLE "cashflow_movimientos" ADD COLUMN IF NOT EXISTS "personal_id" integer REFERENCES "personal"("id") ON DELETE RESTRICT;
ALTER TABLE "caja_movimientos" ADD COLUMN IF NOT EXISTS "personal_id" integer REFERENCES "personal"("id") ON DELETE RESTRICT;
