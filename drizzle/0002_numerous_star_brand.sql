CREATE TYPE "public"."condicion_iva" AS ENUM('responsable_inscripto', 'monotributo', 'consumidor_final', 'exento', 'no_categorizado');--> statement-breakpoint
CREATE TYPE "public"."estado_cobranza" AS ENUM('confirmada', 'anulada');--> statement-breakpoint
CREATE TYPE "public"."estado_venta" AS ENUM('borrador', 'confirmada', 'anulada', 'pendiente_cae');--> statement-breakpoint
CREATE TYPE "public"."medio_pago" AS ENUM('efectivo', 'transferencia', 'tarjeta_debito', 'tarjeta_credito', 'cheque', 'qr', 'otro');--> statement-breakpoint
CREATE TYPE "public"."tipo_doc" AS ENUM('cuit', 'cuil', 'dni', 'sin_identificar');--> statement-breakpoint
CREATE TYPE "public"."tipo_venta" AS ENUM('ticket', 'factura_a', 'factura_b', 'factura_c', 'nota_credito', 'nota_debito');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clientes" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"nombre_fantasia" text DEFAULT '' NOT NULL,
	"tipo_doc" "tipo_doc" DEFAULT 'dni' NOT NULL,
	"numero_doc" text DEFAULT '' NOT NULL,
	"condicion_iva" "condicion_iva" DEFAULT 'consumidor_final' NOT NULL,
	"direccion" text DEFAULT '' NOT NULL,
	"localidad" text DEFAULT '' NOT NULL,
	"telefono" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"lista_precio" text DEFAULT '' NOT NULL,
	"descuento" double precision DEFAULT 0 NOT NULL,
	"vendedor_id" integer,
	"sucursal_id" integer,
	"cta_cte_habilitada" boolean DEFAULT false NOT NULL,
	"limite_credito" double precision DEFAULT 0 NOT NULL,
	"dias_plazo" integer DEFAULT 0 NOT NULL,
	"observaciones" text DEFAULT '' NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"es_consumidor_final" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cobranza_imputaciones" (
	"id" serial PRIMARY KEY NOT NULL,
	"cobranza_id" integer NOT NULL,
	"venta_id" integer NOT NULL,
	"importe" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cobranza_pagos" (
	"id" serial PRIMARY KEY NOT NULL,
	"cobranza_id" integer NOT NULL,
	"medio" "medio_pago" DEFAULT 'efectivo' NOT NULL,
	"importe" double precision DEFAULT 0 NOT NULL,
	"referencia" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cobranzas" (
	"id" serial PRIMARY KEY NOT NULL,
	"punto_venta" text DEFAULT '0001' NOT NULL,
	"numero" integer DEFAULT 0 NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"cliente_id" integer NOT NULL,
	"sucursal_id" integer,
	"usuario_id" integer,
	"total" double precision DEFAULT 0 NOT NULL,
	"a_cuenta" double precision DEFAULT 0 NOT NULL,
	"estado" "estado_cobranza" DEFAULT 'confirmada' NOT NULL,
	"observaciones" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "configuracion" (
	"id" serial PRIMARY KEY NOT NULL,
	"clave" text NOT NULL,
	"valor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "venta_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"venta_id" integer NOT NULL,
	"producto_id" integer NOT NULL,
	"presentacion_id" integer,
	"cantidad" double precision DEFAULT 0 NOT NULL,
	"precio_lista" double precision DEFAULT 0 NOT NULL,
	"descuento" double precision DEFAULT 0 NOT NULL,
	"precio_unitario" double precision DEFAULT 0 NOT NULL,
	"iva" double precision DEFAULT 21 NOT NULL,
	"subtotal" double precision DEFAULT 0 NOT NULL,
	"ref_item_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "venta_pagos" (
	"id" serial PRIMARY KEY NOT NULL,
	"venta_id" integer NOT NULL,
	"medio" "medio_pago" DEFAULT 'efectivo' NOT NULL,
	"importe" double precision DEFAULT 0 NOT NULL,
	"referencia" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ventas" (
	"id" serial PRIMARY KEY NOT NULL,
	"tipo" "tipo_venta" DEFAULT 'ticket' NOT NULL,
	"punto_venta" text DEFAULT '0001' NOT NULL,
	"numero" integer DEFAULT 0 NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"cliente_id" integer NOT NULL,
	"sucursal_id" integer,
	"usuario_id" integer,
	"estado" "estado_venta" DEFAULT 'confirmada' NOT NULL,
	"condicion_pago" "condicion_pago" DEFAULT 'contado' NOT NULL,
	"vencimiento_pago" timestamp with time zone,
	"lista_precio" text DEFAULT '' NOT NULL,
	"subtotal_neto" double precision DEFAULT 0 NOT NULL,
	"descuento_total" double precision DEFAULT 0 NOT NULL,
	"iva_total" double precision DEFAULT 0 NOT NULL,
	"total" double precision DEFAULT 0 NOT NULL,
	"cae" text DEFAULT '' NOT NULL,
	"cae_vencimiento" timestamp with time zone,
	"ref_venta_id" integer,
	"observaciones" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "clientes" ADD CONSTRAINT "clientes_vendedor_id_usuarios_id_fk" FOREIGN KEY ("vendedor_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "clientes" ADD CONSTRAINT "clientes_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cobranza_imputaciones" ADD CONSTRAINT "cobranza_imputaciones_cobranza_id_cobranzas_id_fk" FOREIGN KEY ("cobranza_id") REFERENCES "public"."cobranzas"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cobranza_imputaciones" ADD CONSTRAINT "cobranza_imputaciones_venta_id_ventas_id_fk" FOREIGN KEY ("venta_id") REFERENCES "public"."ventas"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cobranza_pagos" ADD CONSTRAINT "cobranza_pagos_cobranza_id_cobranzas_id_fk" FOREIGN KEY ("cobranza_id") REFERENCES "public"."cobranzas"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cobranzas" ADD CONSTRAINT "cobranzas_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cobranzas" ADD CONSTRAINT "cobranzas_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cobranzas" ADD CONSTRAINT "cobranzas_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "venta_items" ADD CONSTRAINT "venta_items_venta_id_ventas_id_fk" FOREIGN KEY ("venta_id") REFERENCES "public"."ventas"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "venta_items" ADD CONSTRAINT "venta_items_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "venta_items" ADD CONSTRAINT "venta_items_presentacion_id_presentaciones_id_fk" FOREIGN KEY ("presentacion_id") REFERENCES "public"."presentaciones"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "venta_pagos" ADD CONSTRAINT "venta_pagos_venta_id_ventas_id_fk" FOREIGN KEY ("venta_id") REFERENCES "public"."ventas"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ventas" ADD CONSTRAINT "ventas_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ventas" ADD CONSTRAINT "ventas_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ventas" ADD CONSTRAINT "ventas_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_clientes_nombre" ON "clientes" USING btree ("nombre");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_clientes_doc" ON "clientes" USING btree ("tipo_doc","numero_doc");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_cobranza_imput_cobranza" ON "cobranza_imputaciones" USING btree ("cobranza_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_cobranza_imput_venta" ON "cobranza_imputaciones" USING btree ("venta_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_cobranza_pagos_cobranza" ON "cobranza_pagos" USING btree ("cobranza_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_cobranzas_cliente" ON "cobranzas" USING btree ("cliente_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cobranzas_numero" ON "cobranzas" USING btree ("punto_venta","numero");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_configuracion_clave" ON "configuracion" USING btree ("clave");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_venta_items_venta" ON "venta_items" USING btree ("venta_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_venta_pagos_venta" ON "venta_pagos" USING btree ("venta_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_ventas_cliente" ON "ventas" USING btree ("cliente_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_ventas_fecha" ON "ventas" USING btree ("fecha");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ventas_numero" ON "ventas" USING btree ("tipo","punto_venta","numero");