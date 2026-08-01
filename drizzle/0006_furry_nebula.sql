CREATE TYPE "public"."origen_costo" AS ENUM('alta', 'manual', 'masiva', 'recepcion', 'reversion');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "producto_proveedor_costos" (
	"id" serial PRIMARY KEY NOT NULL,
	"producto_proveedor_id" integer NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"costo_anterior" double precision DEFAULT 0 NOT NULL,
	"descuento_anterior" double precision DEFAULT 0 NOT NULL,
	"flete_anterior" double precision DEFAULT 0 NOT NULL,
	"costo" double precision DEFAULT 0 NOT NULL,
	"descuento" double precision DEFAULT 0 NOT NULL,
	"flete" double precision DEFAULT 0 NOT NULL,
	"origen" "origen_costo" DEFAULT 'manual' NOT NULL,
	"motivo" text DEFAULT '' NOT NULL,
	"lote" text DEFAULT '' NOT NULL,
	"usuario_id" integer,
	"comprobante_id" integer
);
--> statement-breakpoint
ALTER TABLE "presentaciones" ADD COLUMN "recargo" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "producto_proveedor_costos" ADD CONSTRAINT "producto_proveedor_costos_producto_proveedor_id_producto_proveedores_id_fk" FOREIGN KEY ("producto_proveedor_id") REFERENCES "public"."producto_proveedores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "producto_proveedor_costos" ADD CONSTRAINT "producto_proveedor_costos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_ppc_entrada" ON "producto_proveedor_costos" USING btree ("producto_proveedor_id","fecha");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_ppc_lote" ON "producto_proveedor_costos" USING btree ("lote");--> statement-breakpoint
-- BACKFILL: `ganancia` era el margen COMPLETO de la presentación; `recargo` es
-- solo lo que agrega el fraccionamiento sobre el precio por kg de la lista.
-- Se despeja el recargo que deja el precio actual intacto contra la primera
-- lista del producto, así el cambio de modelo no mueve ni un peso el día uno.
UPDATE presentaciones p
SET recargo = (
  (1 + p.ganancia / 100.0)
  / (1 + COALESCE((
      SELECT l.ganancia FROM listas_precio l
      WHERE l.producto_id = p.producto_id
      ORDER BY l.id LIMIT 1
    ), 0) / 100.0)
  - 1
) * 100.0;
