-- ===========================================================================
-- EVOLUCIÓN DE PRECIOS
-- ===========================================================================
-- El precio se deriva, no se edita: no existe un evento "cambió el precio".
-- Esta tabla lo registra por snapshot-diff después de cada operación que puede
-- moverlo (costos, formato de compra, formato de venta, activación, reversión).
-- Guarda el precio FINAL con IVA — el número de la etiqueta.

CREATE TYPE "public"."origen_precio" AS ENUM('inicial', 'costo', 'formato_compra', 'formato_venta', 'activacion', 'reversion');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "precio_historial" (
	"id" serial PRIMARY KEY NOT NULL,
	"producto_id" integer NOT NULL,
	"lista_id" integer NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"precio_anterior" double precision,
	"precio" double precision DEFAULT 0 NOT NULL,
	"origen" "origen_precio" DEFAULT 'costo' NOT NULL,
	"detalle" text DEFAULT '' NOT NULL,
	"usuario_id" integer
);
--> statement-breakpoint

ALTER TABLE "precio_historial" ADD CONSTRAINT "precio_historial_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "precio_historial" ADD CONSTRAINT "precio_historial_lista_id_listas_venta_id_fk" FOREIGN KEY ("lista_id") REFERENCES "public"."listas_venta"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "precio_historial" ADD CONSTRAINT "precio_historial_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "ix_precio_historial_producto" ON "precio_historial" USING btree ("producto_id","fecha");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_precio_historial_fecha" ON "precio_historial" USING btree ("fecha");
