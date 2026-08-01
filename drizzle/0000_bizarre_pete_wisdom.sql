CREATE TYPE "public"."estado_incidencia" AS ENUM('pendiente', 'revision', 'resuelta');--> statement-breakpoint
CREATE TYPE "public"."estado_stock" AS ENUM('disponible', 'comprometido', 'retenido', 'defectuoso', 'vencido');--> statement-breakpoint
CREATE TYPE "public"."estado_transferencia" AS ENUM('pendiente', 'preparada', 'transito', 'recibida', 'cancelada');--> statement-breakpoint
CREATE TYPE "public"."rol" AS ENUM('admin', 'fraccionador', 'vendedor');--> statement-breakpoint
CREATE TYPE "public"."tipo_movimiento" AS ENUM('compra', 'fraccionamiento', 'venta_granel', 'venta_fraccionada', 'devolucion', 'ajuste', 'merma', 'vencido', 'defectuoso', 'transferencia');--> statement-breakpoint
CREATE TYPE "public"."tipo_producto" AS ENUM('granel', 'entero');--> statement-breakpoint
CREATE TYPE "public"."tipo_sucursal" AS ENUM('distribuidora', 'express');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "incidencias" (
	"id" serial PRIMARY KEY NOT NULL,
	"codigo" text DEFAULT '' NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"tipo" text NOT NULL,
	"estado" "estado_incidencia" DEFAULT 'pendiente' NOT NULL,
	"responsable_id" integer,
	"motivo" text DEFAULT '' NOT NULL,
	"producto_id" integer NOT NULL,
	"sucursal_id" integer NOT NULL,
	"presentacion_id" integer,
	"cantidad" double precision DEFAULT 0 NOT NULL,
	"unidad" text DEFAULT '' NOT NULL,
	"resolucion" text,
	"fecha_resolucion" timestamp with time zone,
	"activa" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "listas_precio" (
	"id" serial PRIMARY KEY NOT NULL,
	"producto_id" integer NOT NULL,
	"nombre" text NOT NULL,
	"ganancia" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "movimientos" (
	"id" serial PRIMARY KEY NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"tipo" "tipo_movimiento" NOT NULL,
	"producto_id" integer,
	"sucursal_id" integer,
	"presentacion_id" integer,
	"signo" integer DEFAULT 0 NOT NULL,
	"cantidad" double precision DEFAULT 0 NOT NULL,
	"unidad" text DEFAULT '' NOT NULL,
	"motivo" text DEFAULT '' NOT NULL,
	"pres_label" text DEFAULT '' NOT NULL,
	"estado_desde" "estado_stock",
	"estado_hacia" "estado_stock",
	"sucursal_destino_id" integer,
	"vencimiento" timestamp with time zone,
	"proveedor_nombre" text DEFAULT '' NOT NULL,
	"usuario_id" integer,
	"ref_transferencia_id" integer,
	"ref_incidencia_id" integer,
	"descripcion" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "presentaciones" (
	"id" serial PRIMARY KEY NOT NULL,
	"producto_id" integer NOT NULL,
	"tam_kg" double precision NOT NULL,
	"ganancia" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "producto_proveedores" (
	"id" serial PRIMARY KEY NOT NULL,
	"producto_id" integer NOT NULL,
	"proveedor_id" integer NOT NULL,
	"costo" double precision DEFAULT 0 NOT NULL,
	"descuento" double precision DEFAULT 0 NOT NULL,
	"flete" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "productos" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"marca" text DEFAULT '' NOT NULL,
	"categoria" text DEFAULT 'General' NOT NULL,
	"iva" double precision DEFAULT 21 NOT NULL,
	"tipo" "tipo_producto" DEFAULT 'entero' NOT NULL,
	"stock_min" double precision DEFAULT 0 NOT NULL,
	"proveedor_activo_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proveedores" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"cuit" text DEFAULT '' NOT NULL,
	"direccion" text DEFAULT '' NOT NULL,
	"telefono" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock" (
	"id" serial PRIMARY KEY NOT NULL,
	"producto_id" integer NOT NULL,
	"sucursal_id" integer NOT NULL,
	"presentacion_id" integer,
	"estado" "estado_stock" DEFAULT 'disponible' NOT NULL,
	"cantidad" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sucursales" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"tipo" "tipo_sucursal" DEFAULT 'express' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transferencia_hist" (
	"id" serial PRIMARY KEY NOT NULL,
	"transferencia_id" integer NOT NULL,
	"estado" "estado_transferencia" NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"usuario_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transferencia_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"transferencia_id" integer NOT NULL,
	"producto_id" integer NOT NULL,
	"presentacion_id" integer,
	"cantidad" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transferencias" (
	"id" serial PRIMARY KEY NOT NULL,
	"codigo" text DEFAULT '' NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"origen_id" integer NOT NULL,
	"destino_id" integer NOT NULL,
	"usuario_id" integer,
	"estado" "estado_transferencia" DEFAULT 'pendiente' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usuarios" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"rol" "rol" DEFAULT 'vendedor' NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "incidencias" ADD CONSTRAINT "incidencias_responsable_id_usuarios_id_fk" FOREIGN KEY ("responsable_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "incidencias" ADD CONSTRAINT "incidencias_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "incidencias" ADD CONSTRAINT "incidencias_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "incidencias" ADD CONSTRAINT "incidencias_presentacion_id_presentaciones_id_fk" FOREIGN KEY ("presentacion_id") REFERENCES "public"."presentaciones"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "listas_precio" ADD CONSTRAINT "listas_precio_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "movimientos" ADD CONSTRAINT "movimientos_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "movimientos" ADD CONSTRAINT "movimientos_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "movimientos" ADD CONSTRAINT "movimientos_presentacion_id_presentaciones_id_fk" FOREIGN KEY ("presentacion_id") REFERENCES "public"."presentaciones"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "movimientos" ADD CONSTRAINT "movimientos_sucursal_destino_id_sucursales_id_fk" FOREIGN KEY ("sucursal_destino_id") REFERENCES "public"."sucursales"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "movimientos" ADD CONSTRAINT "movimientos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "presentaciones" ADD CONSTRAINT "presentaciones_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "producto_proveedores" ADD CONSTRAINT "producto_proveedores_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "producto_proveedores" ADD CONSTRAINT "producto_proveedores_proveedor_id_proveedores_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "productos" ADD CONSTRAINT "productos_proveedor_activo_id_proveedores_id_fk" FOREIGN KEY ("proveedor_activo_id") REFERENCES "public"."proveedores"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock" ADD CONSTRAINT "stock_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock" ADD CONSTRAINT "stock_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock" ADD CONSTRAINT "stock_presentacion_id_presentaciones_id_fk" FOREIGN KEY ("presentacion_id") REFERENCES "public"."presentaciones"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transferencia_hist" ADD CONSTRAINT "transferencia_hist_transferencia_id_transferencias_id_fk" FOREIGN KEY ("transferencia_id") REFERENCES "public"."transferencias"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transferencia_hist" ADD CONSTRAINT "transferencia_hist_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transferencia_items" ADD CONSTRAINT "transferencia_items_transferencia_id_transferencias_id_fk" FOREIGN KEY ("transferencia_id") REFERENCES "public"."transferencias"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transferencia_items" ADD CONSTRAINT "transferencia_items_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transferencia_items" ADD CONSTRAINT "transferencia_items_presentacion_id_presentaciones_id_fk" FOREIGN KEY ("presentacion_id") REFERENCES "public"."presentaciones"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transferencias" ADD CONSTRAINT "transferencias_origen_id_sucursales_id_fk" FOREIGN KEY ("origen_id") REFERENCES "public"."sucursales"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transferencias" ADD CONSTRAINT "transferencias_destino_id_sucursales_id_fk" FOREIGN KEY ("destino_id") REFERENCES "public"."sucursales"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transferencias" ADD CONSTRAINT "transferencias_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_producto_proveedor" ON "producto_proveedores" USING btree ("producto_id","proveedor_id");