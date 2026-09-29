-- ===========================================================================
-- 0121 · RESPALDO A GOOGLE DRIVE (29/9/2026)
-- ===========================================================================
-- Una sola fila (id = 1): con qué cuenta de Google está conectado el sistema,
-- a qué hora respalda, cuántos días guarda y cómo le fue la última vez.
-- El token de acceso a Drive se guarda CIFRADO (AES-256-GCM, con una clave que
-- sale de las variables de entorno del servidor): la base sola no alcanza para
-- usarlo. La copia externa de la base se genera con el mismo volcado de
-- Sistema › Respaldos y sube a una carpeta que crea el propio sistema.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "respaldo_drive" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "email" text NOT NULL DEFAULT '',
  "token_cifrado" text NOT NULL DEFAULT '',
  "carpeta_id" text NOT NULL DEFAULT '',
  "activo" boolean NOT NULL DEFAULT true,
  "hora" text NOT NULL DEFAULT '03:00',
  "dias" integer NOT NULL DEFAULT 30,
  "cifrar" boolean NOT NULL DEFAULT true,
  "conectado_en" timestamp with time zone,
  "ultimo_intento" timestamp with time zone,
  "ultimo_ok" timestamp with time zone,
  "ultimo_archivo" text NOT NULL DEFAULT '',
  "ultimo_tamano" bigint NOT NULL DEFAULT 0,
  "ultimo_error" text NOT NULL DEFAULT '',
  "ultimo_origen" text NOT NULL DEFAULT '',
  CONSTRAINT "ck_respaldo_drive_unica" CHECK ("id" = 1),
  CONSTRAINT "ck_respaldo_drive_hora" CHECK ("hora" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT "ck_respaldo_drive_dias" CHECK ("dias" BETWEEN 3 AND 365)
);
