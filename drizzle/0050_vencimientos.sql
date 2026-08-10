-- VENCIMIENTOS — la lista de control de fechas, SIN lote.
--
-- El registro NO es stock: es un vigía ("6 unidades vencen el 15/9 en
-- Express 2") con el costo CONGELADO al anotar. El stock se toca recién al
-- PROCESAR lo vencido: ahí se genera la baja real (movimiento 'vencido') por
-- las unidades que no se salvaron. La oferta que se arma desde acá es una
-- oferta REAL de Ventas (aplica en caja) y queda vinculada.

CREATE TABLE IF NOT EXISTS "vencimiento_sesiones" (
  "id" serial PRIMARY KEY NOT NULL,
  "fecha" timestamp with time zone DEFAULT now() NOT NULL,
  "sucursal_id" integer NOT NULL,
  "usuario_id" integer,
  "total_items" integer DEFAULT 0 NOT NULL,
  "total_unidades" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vencimiento_sesiones" ADD CONSTRAINT "vencimiento_sesiones_sucursal_id_fk"
  FOREIGN KEY ("sucursal_id") REFERENCES "sucursales"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vencimiento_sesiones" ADD CONSTRAINT "vencimiento_sesiones_usuario_id_fk"
  FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_venc_sesiones_fecha" ON "vencimiento_sesiones" ("fecha");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "vencimientos" (
  "id" serial PRIMARY KEY NOT NULL,
  "producto_id" integer NOT NULL,
  "presentacion_id" integer,
  "sucursal_id" integer NOT NULL,
  "sesion_id" integer,
  "fecha_vencimiento" date NOT NULL,
  "cantidad" double precision DEFAULT 0 NOT NULL,
  "costo_unitario" double precision DEFAULT 0 NOT NULL,
  "nombre" text DEFAULT '' NOT NULL,
  "unidad" text DEFAULT '' NOT NULL,
  "codigo_barras" text DEFAULT '' NOT NULL,
  "observaciones" text DEFAULT '' NOT NULL,
  "unidades_vendidas" double precision DEFAULT 0 NOT NULL,
  "procesado" boolean DEFAULT false NOT NULL,
  "procesado_en" timestamp with time zone,
  "merma_movimiento_id" integer,
  "oferta_id" integer,
  "usuario_id" integer,
  "creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vencimientos" ADD CONSTRAINT "vencimientos_producto_id_fk"
  FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vencimientos" ADD CONSTRAINT "vencimientos_presentacion_id_fk"
  FOREIGN KEY ("presentacion_id") REFERENCES "presentaciones"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vencimientos" ADD CONSTRAINT "vencimientos_sucursal_id_fk"
  FOREIGN KEY ("sucursal_id") REFERENCES "sucursales"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vencimientos" ADD CONSTRAINT "vencimientos_sesion_id_fk"
  FOREIGN KEY ("sesion_id") REFERENCES "vencimiento_sesiones"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vencimientos" ADD CONSTRAINT "vencimientos_oferta_id_fk"
  FOREIGN KEY ("oferta_id") REFERENCES "ofertas"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vencimientos" ADD CONSTRAINT "vencimientos_usuario_id_fk"
  FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_vencimientos_fecha" ON "vencimientos" ("fecha_vencimiento");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_vencimientos_sucursal" ON "vencimientos" ("sucursal_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_vencimientos_producto" ON "vencimientos" ("producto_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_vencimientos_procesado" ON "vencimientos" ("procesado");
--> statement-breakpoint

-- Costo congelado en los movimientos de PÉRDIDA (merma/vencido/defectuoso):
-- el reporte en pesos no puede cambiar retroactivamente con el catálogo.
ALTER TABLE "movimientos" ADD COLUMN "costo_unitario" double precision DEFAULT 0 NOT NULL;
--> statement-breakpoint

-- FONTANA: la quinta sucursal (existía en la app vieja de vencimientos y es
-- real). Idempotente por nombre.
INSERT INTO "sucursales" ("nombre", "tipo")
SELECT 'Fontana', 'express'
WHERE NOT EXISTS (SELECT 1 FROM "sucursales" WHERE "nombre" = 'Fontana');
--> statement-breakpoint

-- La sección nueva para admin y superadmin (lista explícita, patrón 0041).
-- Es una pantalla de administración: acá el reflejo SÍ corresponde.
UPDATE "roles" SET "permisos" = "permisos" || '["almacen.vencimientos"]'::jsonb
WHERE "clave" IN ('admin', 'superadmin')
  AND NOT ("permisos" ? 'almacen.vencimientos');
