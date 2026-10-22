-- ===========================================================================
-- 0193 · LOS ASESORES: IAs QUE MIRAN TUS NÚMEROS (21/10/2026)
-- ===========================================================================
-- Pedido del dueño: IAs que conozcan el negocio, lean sus números, avisen lo
-- raro y aconsejen. La IA NO hace cuentas: el sistema arma la «foto» con sus
-- números y señales, y la IA la interpreta. Dos especialistas con el mismo
-- funcionamiento (análisis a pedido + preguntas con tope mensual):
--   'negocio'    Gerencia › Asesor: rentabilidad, métricas, granel y
--                fraccionado, stock, cajas, gastos. Solo superadmin.
--   'comercial'  Ventas › Asesor comercial: ofertas, combos, fechas
--                comerciales, tienda online y productos por vencer. Propone
--                promociones que se crean DESACTIVADAS con un botón.
--                Superadmin y administradores (llave `ventas.asesor`).
--
--   asesor_config         una fila por especialista: tope de gasto mensual (USD) y su ficha.
--   asesor_aprendizajes   lo que sabe del negocio, confirmado por el dueño.
--   asesor_informes       cada análisis: la foto, las señales y lo que escribió la IA.
--   asesor_opiniones      «Útil / No aplica / Ya lo sé» de cada alerta: así aprende.
--   asesor_acciones       lo que se hizo con una propuesta (la oferta que se creó).
--   asesor_conversaciones / asesor_mensajes   las preguntas, con el contenido tal
--                         cual lo devolvió la API (se reenvía sin tocar).
--   asesor_usos           cada llamada a la IA con sus tokens y su costo (el tope).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS "asesor_config" (
  "especialidad" text PRIMARY KEY CHECK ("especialidad" IN ('negocio', 'comercial')),
  "tope_mensual_usd" double precision NOT NULL DEFAULT 10,
  "ficha" text NOT NULL DEFAULT '',
  "actualizado_en" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO "asesor_config" ("especialidad") VALUES ('negocio'), ('comercial') ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asesor_aprendizajes" (
  "id" serial PRIMARY KEY,
  "especialidad" text NOT NULL CHECK ("especialidad" IN ('negocio', 'comercial')),
  "texto" text NOT NULL,
  "activo" boolean NOT NULL DEFAULT true,
  "creado_en" timestamp with time zone NOT NULL DEFAULT now(),
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asesor_informes" (
  "id" serial PRIMARY KEY,
  "especialidad" text NOT NULL CHECK ("especialidad" IN ('negocio', 'comercial')),
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
CREATE INDEX IF NOT EXISTS "ix_asesor_informes_esp" ON "asesor_informes" ("especialidad", "id");
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
CREATE TABLE IF NOT EXISTS "asesor_acciones" (
  "id" serial PRIMARY KEY,
  "informe_id" integer NOT NULL REFERENCES "asesor_informes"("id") ON DELETE CASCADE,
  "propuesta" integer NOT NULL,
  "oferta_id" integer REFERENCES "ofertas"("id") ON DELETE SET NULL,
  "fecha" timestamp with time zone NOT NULL DEFAULT now(),
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL
);
--> statement-breakpoint
-- Una propuesta se crea una vez: dos clics no hacen dos ofertas.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_asesor_accion" ON "asesor_acciones" ("informe_id", "propuesta");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asesor_conversaciones" (
  "id" serial PRIMARY KEY,
  "especialidad" text NOT NULL CHECK ("especialidad" IN ('negocio', 'comercial')),
  "titulo" text NOT NULL DEFAULT '',
  "creada_en" timestamp with time zone NOT NULL DEFAULT now(),
  "actualizada_en" timestamp with time zone NOT NULL DEFAULT now(),
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_asesor_conv_esp" ON "asesor_conversaciones" ("especialidad", "actualizada_en");
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
  "especialidad" text NOT NULL CHECK ("especialidad" IN ('negocio', 'comercial')),
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
CREATE INDEX IF NOT EXISTS "ix_asesor_usos_esp" ON "asesor_usos" ("especialidad", "fecha");
--> statement-breakpoint
-- Las fechas propias del asesor comercial (aniversario del local, una feria, el día de la ciudad…).
-- `anual`: se repite todos los años en el mismo día y mes.
CREATE TABLE IF NOT EXISTS "asesor_fechas" (
  "id" serial PRIMARY KEY,
  "fecha" date NOT NULL,
  "nombre" text NOT NULL,
  "nota" text NOT NULL DEFAULT '',
  "anual" boolean NOT NULL DEFAULT true,
  "creado_en" timestamp with time zone NOT NULL DEFAULT now(),
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL
);
--> statement-breakpoint
-- El asesor comercial lo usan también los administradores (decisión del dueño): la llave nueva se les da de entrada.
UPDATE "roles" SET "permisos" = "permisos" || '["ventas.asesor"]'::jsonb
  WHERE "nombre" = 'Administrador' AND NOT ("permisos" ? 'ventas.asesor');
