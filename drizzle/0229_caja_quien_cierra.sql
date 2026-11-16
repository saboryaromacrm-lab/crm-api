-- QUIÉN CIERRA LA CAJA Y LOS CAMBIOS DE CAJERO (16/11/2026, pedido del dueño).
-- 1) El que cierra se elige al cerrar y firma con su PIN: queda en el turno.
ALTER TABLE "caja_sesiones" ADD COLUMN IF NOT EXISTS "cerrado_por" integer REFERENCES "usuarios"("id") ON DELETE SET NULL;
--> statement-breakpoint
-- Los turnos ya cerrados: el que firmó el conteo del cierre por envío (lo que las pantallas ya mostraban como cajero).
UPDATE "caja_sesiones" cs SET "cerrado_por" = cx.usuario_id
  FROM (
    SELECT DISTINCT ON (cc.caja_sesion_id) cc.caja_sesion_id, cc.usuario_id
      FROM "caja_controles" cc
     WHERE cc.observaciones LIKE 'Cierre por envío%' AND cc.usuario_id IS NOT NULL
     ORDER BY cc.caja_sesion_id, cc.id DESC
  ) cx
 WHERE cx.caja_sesion_id = cs.id AND cs."cerrado_por" IS NULL;
--> statement-breakpoint
-- 2) Quién tomó la caja durante el turno: el que entra en la PC de la caja con otro usuario, o el relevo con PIN.
CREATE TABLE IF NOT EXISTS "caja_cajeros" (
  "id" serial PRIMARY KEY,
  "caja_sesion_id" integer NOT NULL REFERENCES "caja_sesiones"("id") ON DELETE CASCADE,
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "desde" timestamp with time zone NOT NULL DEFAULT now(),
  "origen" text NOT NULL,
  "terminal_id" integer REFERENCES "terminales"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_caja_cajeros_sesion" ON "caja_cajeros" ("caja_sesion_id", "id");
