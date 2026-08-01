CREATE TYPE "public"."condicion_pago" AS ENUM('contado', 'cuenta_corriente');--> statement-breakpoint
CREATE TYPE "public"."estado_comprobante" AS ENUM('borrador', 'confirmado', 'anulado');--> statement-breakpoint
CREATE TYPE "public"."letra_comprobante" AS ENUM('A', 'B', 'C', 'X');--> statement-breakpoint
CREATE TYPE "public"."tipo_comprobante" AS ENUM('orden_compra', 'remito', 'factura', 'nota_credito', 'nota_debito');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "comprobante_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"comprobante_id" integer NOT NULL,
	"producto_id" integer NOT NULL,
	"presentacion_id" integer,
	"cantidad" double precision DEFAULT 0 NOT NULL,
	"costo_unitario" double precision DEFAULT 0 NOT NULL,
	"descuento" double precision DEFAULT 0 NOT NULL,
	"iva" double precision DEFAULT 21 NOT NULL,
	"subtotal" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "comprobantes" (
	"id" serial PRIMARY KEY NOT NULL,
	"tipo" "tipo_comprobante" NOT NULL,
	"letra" "letra_comprobante" DEFAULT 'A' NOT NULL,
	"punto_venta" text DEFAULT '0001' NOT NULL,
	"numero" integer,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"proveedor_id" integer NOT NULL,
	"sucursal_id" integer,
	"estado" "estado_comprobante" DEFAULT 'confirmado' NOT NULL,
	"condicion_pago" "condicion_pago" DEFAULT 'cuenta_corriente' NOT NULL,
	"vencimiento_pago" timestamp with time zone,
	"recepcion" boolean DEFAULT false NOT NULL,
	"subtotal_neto" double precision DEFAULT 0 NOT NULL,
	"iva_total" double precision DEFAULT 0 NOT NULL,
	"total" double precision DEFAULT 0 NOT NULL,
	"ref_comprobante_id" integer,
	"observaciones" text DEFAULT '' NOT NULL,
	"usuario_id" integer
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "comprobante_items" ADD CONSTRAINT "comprobante_items_comprobante_id_comprobantes_id_fk" FOREIGN KEY ("comprobante_id") REFERENCES "public"."comprobantes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "comprobante_items" ADD CONSTRAINT "comprobante_items_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "comprobante_items" ADD CONSTRAINT "comprobante_items_presentacion_id_presentaciones_id_fk" FOREIGN KEY ("presentacion_id") REFERENCES "public"."presentaciones"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "comprobantes" ADD CONSTRAINT "comprobantes_proveedor_id_proveedores_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedores"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "comprobantes" ADD CONSTRAINT "comprobantes_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "comprobantes" ADD CONSTRAINT "comprobantes_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
