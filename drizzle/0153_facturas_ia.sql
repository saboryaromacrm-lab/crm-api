-- ===========================================================================
-- 0153 · FACTURAS DE COMPRA LEÍDAS CON IA (9/10/2026)
-- ===========================================================================
-- Pedido del dueño: que la IA (Claude, por la API de Anthropic) lea las
-- facturas de la bandeja —PDF, fotos y escaneos— y deje la carga lista para
-- revisar. Reemplaza ENTERA a la lectura de PDF en el navegador (recetas por
-- proveedor, estructura del asistente y lectura automática), que se elimina.
-- `proveedores.formato_factura` y `plantilla_factura` quedan SIN USO (el
-- código ya no las nombra) y se borran en una migración posterior: Dokploy
-- aplica la migración antes de cambiar el contenedor, y el código viejo, que
-- las lee, seguiría atendiendo esos minutos.
--
--   · factura_lecturas.ia_estado / ia: en qué anda la lectura de cada papel
--     y lo que devolvió la IA (encabezado, renglones, pie, control de la
--     cuenta, modelo y costo).
--   · facturas_ia_usos: cada llamada a la IA con sus tokens y su costo en
--     dólares (el consumo del mes y el tope salen de acá). Sin clave foránea a
--     propósito: es el registro de lo gastado y sobrevive a la limpieza.
--   · facturas_ia_config: el tope de gasto mensual y si se lee sola al subir.
-- ===========================================================================
ALTER TABLE "factura_lecturas" ADD COLUMN "ia_estado" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "factura_lecturas" ADD CONSTRAINT "ck_factura_lecturas_ia_estado" CHECK (
  "ia_estado" IN ('', 'en_cola', 'leyendo', 'lista', 'error', 'tope')
);
--> statement-breakpoint
ALTER TABLE "factura_lecturas" ADD COLUMN "ia" jsonb;
--> statement-breakpoint
CREATE INDEX "ix_factura_lecturas_ia_estado" ON "factura_lecturas" ("ia_estado") WHERE "ia_estado" IN ('en_cola', 'leyendo');
--> statement-breakpoint
CREATE TABLE "facturas_ia_usos" (
  "id" serial PRIMARY KEY,
  "fecha" timestamptz NOT NULL DEFAULT now(),
  "lectura_id" integer,
  "tarea" text NOT NULL,
  "modelo" text NOT NULL,
  "tokens_entrada" integer NOT NULL DEFAULT 0,
  "tokens_salida" integer NOT NULL DEFAULT 0,
  "tokens_cache_escritura" integer NOT NULL DEFAULT 0,
  "tokens_cache_lectura" integer NOT NULL DEFAULT 0,
  "costo_usd" double precision NOT NULL DEFAULT 0,
  "ok" boolean NOT NULL DEFAULT true,
  "error" text NOT NULL DEFAULT '',
  "usuario_id" integer,
  CONSTRAINT "ck_facturas_ia_usos_tarea" CHECK ("tarea" IN ('leer', 'elegir'))
);
--> statement-breakpoint
CREATE INDEX "ix_facturas_ia_usos_fecha" ON "facturas_ia_usos" ("fecha");
--> statement-breakpoint
CREATE TABLE "facturas_ia_config" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "tope_mensual_usd" double precision NOT NULL DEFAULT 5,
  "leer_al_subir" boolean NOT NULL DEFAULT true,
  "actualizado_en" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ck_facturas_ia_config_uno" CHECK ("id" = 1),
  CONSTRAINT "ck_facturas_ia_config_tope" CHECK ("tope_mensual_usd" >= 0 AND "tope_mensual_usd" <= 1000)
);
--> statement-breakpoint
INSERT INTO "facturas_ia_config" ("id") VALUES (1);
