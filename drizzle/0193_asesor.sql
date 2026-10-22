-- ===========================================================================
-- 0193 · GERENCIA › ASESOR: LA IA QUE MIRA TUS NÚMEROS (21/10/2026)
-- ===========================================================================
-- Pedido del dueño: una IA que conozca el negocio, analice rentabilidad,
-- métricas y el fraccionado de granel, avise lo raro y aconseje. Decisiones:
-- el análisis lo pide él (botón), puede hacerle preguntas con tope mensual,
-- solo superadmin. La IA NO hace cuentas: el sistema arma la «foto» con sus
-- números y señales, y la IA la interpreta.
--
--   asesor_config         una fila: tope de gasto mensual (USD) y la ficha del
--                         negocio que escribe el dueño.
--   asesor_aprendizajes   lo que el asesor sabe del negocio, confirmado por el dueño.
--   asesor_informes       cada análisis: la foto, las señales y lo que escribió la IA.
--   asesor_opiniones      «Útil / No aplica / Ya lo sé» de cada alerta: así aprende
--                         qué importa y deja de insistir con lo que no.
--   asesor_conversaciones / asesor_mensajes   las preguntas, con el contenido tal
--                         cual lo devolvió la API (se reenvía sin tocar).
--   asesor_usos           cada llamada a la IA con sus tokens y su costo (el tope).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS "asesor_config" (
  "id" integer PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
  "tope_mensual_usd" double precision NOT NULL DEFAULT 10,
  "ficha" text NOT NULL DEFAULT '',
  "actualizado_en" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO "asesor_config" ("id") VALUES (1) ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asesor_aprendizajes" (
  "id" serial PRIMARY KEY,
  "texto" text NOT NULL,
  "activo" boolean NOT NULL DEFAULT true,
  "creado_en" timestamp with time zone NOT NULL DEFAULT now(),
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asesor_informes" (
  "id" serial PRIMARY KEY,
  "fecha" timestamp with time zone NOT NULL DEFAULT now(),
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "enfoque" text NOT NULL DEFAULT '',
  "foto" jsonb NOT NULL,
  "senales" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "informe" jsonb,
  "modelo" text NOT NULL DEFAULT '',
  "costo_usd" double precision NOT NULL DEFAULT 0,
  "error" text NOT NULL DEFAULT '',
  -- El análisis corre en segundo plano: 'analizando' mientras la IA escribe, 'listo' al terminar (bien o con error).
  "estado" text NOT NULL DEFAULT 'listo' CHECK ("estado" IN ('analizando', 'listo'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_asesor_informes_fecha" ON "asesor_informes" ("fecha");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asesor_opiniones" (
  "id" serial PRIMARY KEY,
  "informe_id" integer NOT NULL REFERENCES "asesor_informes"("id") ON DELETE CASCADE,
  "alerta" integer NOT NULL,
  "titulo" text NOT NULL,
  "area" text NOT NULL DEFAULT '',
  "valor" text NOT NULL CHECK ("valor" IN ('util', 'no_aplica', 'ya_lo_se')),
  "nota" text NOT NULL DEFAULT '',
  "fecha" timestamp with time zone NOT NULL DEFAULT now(),
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL
);
--> statement-breakpoint
-- Una opinión por alerta: cambiarla la reemplaza.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_asesor_opinion" ON "asesor_opiniones" ("informe_id", "alerta");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asesor_conversaciones" (
  "id" serial PRIMARY KEY,
  "titulo" text NOT NULL DEFAULT '',
  "creada_en" timestamp with time zone NOT NULL DEFAULT now(),
  "actualizada_en" timestamp with time zone NOT NULL DEFAULT now(),
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asesor_mensajes" (
  "id" serial PRIMARY KEY,
  "conversacion_id" integer NOT NULL REFERENCES "asesor_conversaciones"("id") ON DELETE CASCADE,
  "rol" text NOT NULL CHECK ("rol" IN ('user', 'assistant')),
  "contenido" jsonb NOT NULL,
  "texto" text NOT NULL DEFAULT '',
  "herramientas" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "costo_usd" double precision NOT NULL DEFAULT 0,
  "fecha" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_asesor_mensajes_conv" ON "asesor_mensajes" ("conversacion_id", "id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asesor_usos" (
  "id" serial PRIMARY KEY,
  "fecha" timestamp with time zone NOT NULL DEFAULT now(),
  "tarea" text NOT NULL,
  "modelo" text NOT NULL DEFAULT '',
  "tokens_entrada" integer NOT NULL DEFAULT 0,
  "tokens_salida" integer NOT NULL DEFAULT 0,
  "tokens_cache_escritura" integer NOT NULL DEFAULT 0,
  "tokens_cache_lectura" integer NOT NULL DEFAULT 0,
  "costo_usd" double precision NOT NULL DEFAULT 0,
  "ok" boolean NOT NULL DEFAULT true,
  "error" text NOT NULL DEFAULT '',
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_asesor_usos_fecha" ON "asesor_usos" ("fecha");
