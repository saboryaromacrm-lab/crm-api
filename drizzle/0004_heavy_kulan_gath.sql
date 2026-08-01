CREATE TABLE IF NOT EXISTS "venta_extras" (
	"id" serial PRIMARY KEY NOT NULL,
	"venta_id" integer NOT NULL,
	"concepto" text DEFAULT '' NOT NULL,
	"importe" double precision DEFAULT 0 NOT NULL,
	"iva" double precision DEFAULT 21 NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "uq_ventas_numero";--> statement-breakpoint
ALTER TABLE "ventas" ALTER COLUMN "numero" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "ventas" ALTER COLUMN "numero" DROP NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "venta_extras" ADD CONSTRAINT "venta_extras_venta_id_ventas_id_fk" FOREIGN KEY ("venta_id") REFERENCES "public"."ventas"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_venta_extras_venta" ON "venta_extras" USING btree ("venta_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_ventas_abiertas" ON "ventas" USING btree ("sucursal_id","estado");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ventas_numero" ON "ventas" USING btree ("tipo","punto_venta","numero") WHERE "ventas"."numero" is not null;