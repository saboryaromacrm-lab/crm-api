-- Envíos a Cafetería (puente con coffit) + imputación de gastos por negocio.
-- El envío NO es una transferencia: la cafetería vive en otro sistema (coffit,
-- dueño de su stock). La mercadería EGRESA del CRM a costo congelado.
ALTER TYPE "tipo_movimiento" ADD VALUE IF NOT EXISTS 'envio_cafeteria';--> statement-breakpoint
CREATE TYPE "negocio_gasto" AS ENUM ('distribuidora', 'cafeteria');--> statement-breakpoint
CREATE TYPE "tipo_envio_cafe" AS ENUM ('envio', 'devolucion');--> statement-breakpoint
CREATE TYPE "destino_envio_cafe" AS ENUM ('venta', 'uso');--> statement-breakpoint
CREATE TYPE "estado_envio_cafe" AS ENUM ('confirmado', 'anulado');--> statement-breakpoint
ALTER TABLE "gastos" ADD COLUMN "negocio" "negocio_gasto" DEFAULT 'distribuidora' NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "envios_cafeteria" (
	"id" serial PRIMARY KEY NOT NULL,
	"codigo" text DEFAULT '' NOT NULL,
	"tipo" "tipo_envio_cafe" DEFAULT 'envio' NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"sucursal_id" integer NOT NULL,
	"usuario_id" integer,
	"estado" "estado_envio_cafe" DEFAULT 'confirmado' NOT NULL,
	"total_costo" double precision DEFAULT 0 NOT NULL,
	"observaciones" text DEFAULT '' NOT NULL,
	"motivo_anulacion" text DEFAULT '' NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "envio_cafeteria_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"envio_id" integer NOT NULL,
	"producto_id" integer NOT NULL,
	"presentacion_id" integer,
	"destino" "destino_envio_cafe" DEFAULT 'venta' NOT NULL,
	"cantidad" double precision DEFAULT 0 NOT NULL,
	"costo_unitario" double precision DEFAULT 0 NOT NULL,
	"nombre" text DEFAULT '' NOT NULL,
	"unidad" text DEFAULT '' NOT NULL,
	"codigo_barras" text DEFAULT '' NOT NULL,
	"codigo_propio" text DEFAULT '' NOT NULL
);--> statement-breakpoint
ALTER TABLE "envios_cafeteria" ADD CONSTRAINT "envios_cafeteria_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envios_cafeteria" ADD CONSTRAINT "envios_cafeteria_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envio_cafeteria_items" ADD CONSTRAINT "envio_cafeteria_items_envio_id_envios_cafeteria_id_fk" FOREIGN KEY ("envio_id") REFERENCES "public"."envios_cafeteria"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envio_cafeteria_items" ADD CONSTRAINT "envio_cafeteria_items_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envio_cafeteria_items" ADD CONSTRAINT "envio_cafeteria_items_presentacion_id_presentaciones_id_fk" FOREIGN KEY ("presentacion_id") REFERENCES "public"."presentaciones"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_envios_cafe_fecha" ON "envios_cafeteria" ("fecha");
