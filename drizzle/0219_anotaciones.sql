-- ===========================================================================
-- 0219 · ANOTACIONES DEL DASHBOARD CON RECORDATORIO (5/11/2026, pedido del dueño)
-- ===========================================================================
-- «Una parte de anotación que pueda ir haciendo algún admin o yo, y que se
-- asiente con fecha, hora y usuario.» Es un asiento: no se edita. Quien la
-- escribió (o el superadmin) la puede borrar, y el borrado queda marcado
-- (quién y cuándo), no se pierde la fila.
--
-- `usuario_nombre` guarda el nombre tal como era al escribirla: si después le
-- cambian el nombre al usuario, el asiento no cambia.
--
-- RECORDATORIO (optativo): «que avise con banner y poder elegir a qué usuario
-- avisarle». `recordar_en` es cuándo empieza a salir el aviso; cada usuario
-- elegido tiene su fila en `anotacion_avisos` y el aviso le sale arriba de toda
-- la app hasta que toca «Listo» (`visto_en`). Así quien la escribió ve quién
-- ya la vio.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS "anotaciones" (
  "id" serial PRIMARY KEY,
  "creado_en" timestamptz NOT NULL DEFAULT now(),
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "usuario_nombre" text NOT NULL,
  "texto" text NOT NULL,
  "recordar_en" timestamptz,
  "borrada_en" timestamptz,
  "borrada_por" integer REFERENCES "usuarios"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "ix_anotaciones_vivas" ON "anotaciones" ("id" DESC) WHERE "borrada_en" IS NULL;

CREATE TABLE IF NOT EXISTS "anotacion_avisos" (
  "anotacion_id" integer NOT NULL REFERENCES "anotaciones"("id") ON DELETE CASCADE,
  "usuario_id" integer NOT NULL REFERENCES "usuarios"("id") ON DELETE CASCADE,
  "visto_en" timestamptz,
  PRIMARY KEY ("anotacion_id", "usuario_id")
);
-- Lo que sondea el banner: los avisos sin ver de un usuario.
CREATE INDEX IF NOT EXISTS "ix_anotacion_avisos_pendientes" ON "anotacion_avisos" ("usuario_id") WHERE "visto_en" IS NULL;
