-- ============================================================================
-- SESIONES: la API pasa a saber QUIÉN la está llamando
-- ============================================================================
-- Hasta acá el login verificaba la contraseña bien y devolvía el usuario con su
-- rol… y ahí terminaba. Después de eso cada request era ANÓNIMA: el frontend
-- guardaba la sesión en su localStorage y el servidor no volvía a preguntar
-- nada. Cualquiera con la URL leía y escribía todo — costos, precios, stock,
-- ventas. Esta tabla es lo que convierte ese login en una credencial que el
-- servidor puede verificar en cada llamada.
--
-- POR QUÉ UNA TABLA Y NO UN JWT FIRMADO. Un JWT no necesita esta tabla, pero
-- tampoco se puede desactivar antes de que venza, y acá eso hace falta de
-- verdad: un empleado que se va, una tablet que se pierde en una sucursal.
-- Además, con la sesión en la base:
--   * los PERMISOS se leen frescos en cada request — cambiar un rol tiene
--     efecto ya, sin esperar que la sesión caduque;
--   * desactivar un usuario le corta el acceso en el acto;
--   * LA SUCURSAL VIVE DEL LADO DEL SERVIDOR. Esto es lo más importante para
--     este sistema: el cajero está clavado a su sucursal en la consulta de
--     ventas, y si la sucursal viaja en la request, ese candado se abre
--     cambiando un número. Acá no se puede.
--
-- SE GUARDA EL HASH, NO EL TOKEN. Un token en claro en la base es una
-- credencial usable: cualquiera con un dump —o con el backup diario— entra como
-- quien quiera. Con el hash, el dump no sirve para entrar.
-- Alcanza sha256 y no hace falta scrypt: el token son 32 bytes de aleatorio
-- puro, no una contraseña de 4 dígitos que se pueda adivinar por fuerza bruta.
CREATE TABLE IF NOT EXISTS "sesiones" (
  "id" serial PRIMARY KEY NOT NULL,
  "token_hash" text NOT NULL,
  "usuario_id" integer NOT NULL,
  -- La sucursal con la que se entró: es el contexto de trabajo de TODA la
  -- sesión, no un parámetro de cada pantalla.
  "sucursal_id" integer NOT NULL,
  "creada_en" timestamp with time zone DEFAULT now() NOT NULL,
  "ultimo_uso" timestamp with time zone DEFAULT now() NOT NULL,
  -- Vence por INACTIVIDAD, corriéndose hacia adelante con el uso. Un vencimiento
  -- absoluto corto dejaría al cajero afuera en mitad de un turno; uno largo deja
  -- la caja abierta toda la noche en una máquina compartida.
  "expira_en" timestamp with time zone NOT NULL,
  -- Para que el dueño pueda mirar la lista y reconocer una sesión que no es de
  -- nadie del local.
  "user_agent" text DEFAULT '' NOT NULL
);
--> statement-breakpoint

-- CASCADE en los dos, a propósito: una sesión es efímera y no puede ser lo que
-- impida borrar o reasignar nada. Es lo contrario del criterio de los
-- documentos (0051), donde el `restrict` protege el historial.
ALTER TABLE "sesiones"
  ADD CONSTRAINT "sesiones_usuario_id_usuarios_id_fk"
  FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "sesiones"
  ADD CONSTRAINT "sesiones_sucursal_id_sucursales_id_fk"
  FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- Único: es la búsqueda que corre en CADA request del sistema, y de paso
-- garantiza que dos sesiones no compartan token.
CREATE UNIQUE INDEX IF NOT EXISTS "ix_sesiones_token" ON "sesiones" ("token_hash");
--> statement-breakpoint

-- Para cortar TODAS las sesiones de alguien de una sola vez (se fue, o se le
-- cambió la contraseña).
CREATE INDEX IF NOT EXISTS "ix_sesiones_usuario" ON "sesiones" ("usuario_id");
--> statement-breakpoint

-- Para la limpieza de las vencidas.
CREATE INDEX IF NOT EXISTS "ix_sesiones_expira" ON "sesiones" ("expira_en");
