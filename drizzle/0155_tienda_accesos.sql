-- ===========================================================================
-- 0155 · TIENDA MAYORISTA CON INGRESO (10/10/2026)
-- ===========================================================================
-- Pedido del dueño: el precio mayorista no se muestra a todo el público. Quien
-- quiere comprar pide ingreso (nombre o comercio, DNI, WhatsApp, localidad y
-- CUIT opcional); alguien del ERP lo habilita y le avisa por WhatsApp; desde
-- ahí entra con su DNI y ve precios y compra.
--
--   tienda_accesos   una fila por DNI: pendiente → habilitado | bloqueado.
--                    Bloqueado = rechazado o deshabilitado: ese DNI no entra ni
--                    puede volver a pedir. `cliente_id`: la ficha del cliente
--                    (la que ya existía con ese DNI, o la que se crea al habilitar).
--   tienda_sesiones  el aparato que ingresó: se guarda el HASH del token (el
--                    token viaja solo en la cookie del cliente). Vence a los 90
--                    días sin uso; se renueva sola mientras se use.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS "tienda_accesos" (
  "id" serial PRIMARY KEY,
  "dni" text NOT NULL,
  "nombre" text NOT NULL,
  "whatsapp" text NOT NULL,
  "localidad" text NOT NULL DEFAULT '',
  "cuit" text NOT NULL DEFAULT '',
  "cliente_id" integer REFERENCES "clientes"("id") ON DELETE SET NULL,
  "estado" text NOT NULL DEFAULT 'pendiente',
  "creado_en" timestamp with time zone NOT NULL DEFAULT now(),
  "resuelto_en" timestamp with time zone,
  "resuelto_por" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "avisado_recibida_en" timestamp with time zone,
  "avisado_habilitado_en" timestamp with time zone,
  "ultimo_ingreso" timestamp with time zone,
  CONSTRAINT "ck_tienda_accesos_estado" CHECK ("estado" IN ('pendiente', 'habilitado', 'bloqueado'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_tienda_accesos_dni" ON "tienda_accesos" ("dni");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_tienda_accesos_estado" ON "tienda_accesos" ("estado", "creado_en");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tienda_sesiones" (
  "token_hash" text PRIMARY KEY,
  "acceso_id" integer NOT NULL REFERENCES "tienda_accesos"("id") ON DELETE CASCADE,
  "creado_en" timestamp with time zone NOT NULL DEFAULT now(),
  "expira_en" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_tienda_sesiones_acceso" ON "tienda_sesiones" ("acceso_id");
--> statement-breakpoint
-- La bandeja la ven el superadmin (comodín) y el admin; el dueño se la puede dar a otro rol.
UPDATE "roles" SET "permisos" = "permisos" || '["ventas.accesos_tienda"]'::jsonb
WHERE "clave" = 'admin' AND NOT ("permisos" ? 'ventas.accesos_tienda');
