-- ===========================================================================
-- OFERTAS — promociones del punto de venta
-- ===========================================================================
-- Tipo (la mecánica) + alcance (a qué artículos) + condiciones (vigencia, días,
-- sucursales, medio de pago). El renglón de venta guarda qué oferta se le
-- aplicó y cuánto se descontó, congelando el nombre igual que hace con la
-- lista: el ticket viejo se tiene que poder reimprimir idéntico.

CREATE TYPE "public"."tipo_oferta" AS ENUM('porcentaje', 'precio_fijo', 'nxm', 'segunda_unidad', 'pack', 'combo', 'ticket');
--> statement-breakpoint
CREATE TYPE "public"."alcance_oferta" AS ENUM('producto', 'marca', 'categoria', 'etiqueta');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ofertas" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"tipo" "tipo_oferta" NOT NULL,
	"porcentaje" double precision DEFAULT 0 NOT NULL,
	"precio" double precision DEFAULT 0 NOT NULL,
	"lleva" double precision DEFAULT 0 NOT NULL,
	"paga" double precision DEFAULT 0 NOT NULL,
	"monto_minimo" double precision DEFAULT 0 NOT NULL,
	"desde" timestamp with time zone,
	"hasta" timestamp with time zone,
	"dias" text DEFAULT '' NOT NULL,
	"sucursales" text DEFAULT '' NOT NULL,
	"medios_pago" text DEFAULT '' NOT NULL,
	"solo_precio_base" boolean DEFAULT true NOT NULL,
	"activa" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oferta_alcances" (
	"id" serial PRIMARY KEY NOT NULL,
	"oferta_id" integer NOT NULL,
	"tipo" "alcance_oferta" NOT NULL,
	"ref_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oferta_componentes" (
	"id" serial PRIMARY KEY NOT NULL,
	"oferta_id" integer NOT NULL,
	"producto_id" integer NOT NULL,
	"cantidad" double precision DEFAULT 1 NOT NULL
);
--> statement-breakpoint

ALTER TABLE "oferta_alcances" ADD CONSTRAINT "oferta_alcances_oferta_id_ofertas_id_fk" FOREIGN KEY ("oferta_id") REFERENCES "public"."ofertas"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oferta_componentes" ADD CONSTRAINT "oferta_componentes_oferta_id_ofertas_id_fk" FOREIGN KEY ("oferta_id") REFERENCES "public"."ofertas"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oferta_componentes" ADD CONSTRAINT "oferta_componentes_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uq_oferta_alcance" ON "oferta_alcances" USING btree ("oferta_id","tipo","ref_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_oferta_componente" ON "oferta_componentes" USING btree ("oferta_id","producto_id");
--> statement-breakpoint

ALTER TABLE "venta_items" ADD COLUMN "oferta_id" integer;
--> statement-breakpoint
ALTER TABLE "venta_items" ADD COLUMN "oferta" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "venta_items" ADD COLUMN "oferta_descuento" double precision DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "venta_items" ADD CONSTRAINT "venta_items_oferta_id_ofertas_id_fk" FOREIGN KEY ("oferta_id") REFERENCES "public"."ofertas"("id") ON DELETE set null ON UPDATE no action;
