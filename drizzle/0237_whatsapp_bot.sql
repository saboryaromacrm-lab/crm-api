-- EL BOT DE VENTAS POR WHATSAPP (0237, 19/11/2026).
-- wa_chats: una charla por número (o la de prueba de cada usuario del ERP).
-- wa_mensajes: lo que se ve en WhatsApp (cliente, bot, persona del local).
-- wa_turnos: la conversación con la IA, TAL CUAL la devolvió la API (se reenvía sin tocar).
CREATE TABLE IF NOT EXISTS "wa_chats" (
  "id" serial PRIMARY KEY,
  "wa_id" text NOT NULL,
  "telefono" text NOT NULL DEFAULT '',
  "nombre" text NOT NULL DEFAULT '',
  "prueba" boolean NOT NULL DEFAULT false,
  "acceso_id" integer REFERENCES "tienda_accesos"("id") ON DELETE SET NULL,
  "ia_pausada_hasta" timestamptz,
  "derivado_en" timestamptz,
  "derivado_motivo" text NOT NULL DEFAULT '',
  "ultimo_incluido" integer NOT NULL DEFAULT 0,
  "sesion_desde" timestamptz NOT NULL DEFAULT now(),
  "ultimo_mensaje_en" timestamptz NOT NULL DEFAULT now(),
  "creado_en" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "ux_wa_chats_wa" ON "wa_chats" ("wa_id", "prueba");
CREATE INDEX IF NOT EXISTS "ix_wa_chats_ultimo" ON "wa_chats" ("ultimo_mensaje_en");

CREATE TABLE IF NOT EXISTS "wa_mensajes" (
  "id" serial PRIMARY KEY,
  "chat_id" integer NOT NULL REFERENCES "wa_chats"("id") ON DELETE CASCADE,
  "rol" text NOT NULL,
  "texto" text NOT NULL DEFAULT '',
  "meta_id" text,
  "error" text NOT NULL DEFAULT '',
  "creado_en" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "ux_wa_mensajes_meta" ON "wa_mensajes" ("meta_id") WHERE "meta_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "ix_wa_mensajes_chat" ON "wa_mensajes" ("chat_id", "id");

CREATE TABLE IF NOT EXISTS "wa_turnos" (
  "id" serial PRIMARY KEY,
  "chat_id" integer NOT NULL REFERENCES "wa_chats"("id") ON DELETE CASCADE,
  "rol" text NOT NULL,
  "contenido" jsonb NOT NULL,
  "modelo" text NOT NULL DEFAULT '',
  "costo" double precision NOT NULL DEFAULT 0,
  "creado_en" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ix_wa_turnos_chat" ON "wa_turnos" ("chat_id", "id");
CREATE INDEX IF NOT EXISTS "ix_wa_turnos_fecha" ON "wa_turnos" ("creado_en") WHERE "costo" > 0;
