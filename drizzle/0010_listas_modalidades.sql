-- Listas de precio: modalidad › lista › excepción por producto.
-- `listas_precio` (una fila por producto y nombre de lista) se reemplaza por el
-- catálogo `modalidades_venta`/`listas_venta` + `producto_listas` (excepciones).
DROP TABLE IF EXISTS "listas_precio" CASCADE;--> statement-breakpoint
CREATE TYPE "public"."condicion_lista" AS ENUM('ninguna', 'unidades_producto', 'unidades_marca', 'monto_ticket');--> statement-breakpoint
CREATE TYPE "public"."origen_lista" AS ENUM('base', 'cliente', 'auto', 'manual');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "modalidades_venta" (
  "id" serial PRIMARY KEY NOT NULL,
  "nombre" text NOT NULL,
  "orden" integer DEFAULT 0 NOT NULL,
  "activa" boolean DEFAULT true NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "listas_venta" (
  "id" serial PRIMARY KEY NOT NULL,
  "modalidad_id" integer NOT NULL REFERENCES "modalidades_venta"("id") ON DELETE cascade,
  "numero" integer NOT NULL,
  "nombre" text NOT NULL,
  "markup" double precision DEFAULT 0 NOT NULL,
  "condicion_tipo" "condicion_lista" DEFAULT 'ninguna' NOT NULL,
  "condicion_valor" double precision DEFAULT 0 NOT NULL,
  "disponible_por_defecto" boolean DEFAULT true NOT NULL,
  "orden" integer DEFAULT 0 NOT NULL,
  "activa" boolean DEFAULT true NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "producto_listas" (
  "id" serial PRIMARY KEY NOT NULL,
  "producto_id" integer NOT NULL REFERENCES "productos"("id") ON DELETE cascade,
  "lista_id" integer NOT NULL REFERENCES "listas_venta"("id") ON DELETE cascade,
  "markup" double precision,
  "condicion_tipo" "condicion_lista",
  "condicion_valor" double precision,
  "disponible" boolean
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cliente_listas" (
  "id" serial PRIMARY KEY NOT NULL,
  "cliente_id" integer NOT NULL REFERENCES "clientes"("id") ON DELETE cascade,
  "lista_id" integer NOT NULL REFERENCES "listas_venta"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_lista_modalidad_numero" ON "listas_venta" ("modalidad_id","numero");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_listas_venta_orden" ON "listas_venta" ("orden");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_producto_lista" ON "producto_listas" ("producto_id","lista_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cliente_lista" ON "cliente_listas" ("cliente_id","lista_id");--> statement-breakpoint
ALTER TABLE "clientes" DROP COLUMN IF EXISTS "lista_precio";--> statement-breakpoint
ALTER TABLE "venta_items" ADD COLUMN IF NOT EXISTS "lista_id" integer REFERENCES "listas_venta"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "venta_items" ADD COLUMN IF NOT EXISTS "lista_origen" "origen_lista" DEFAULT 'base' NOT NULL;
