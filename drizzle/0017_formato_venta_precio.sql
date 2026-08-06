-- ===========================================================================
-- FORMATO DE VENTA — código propio, unidades por formato y modo de precio
-- ===========================================================================
-- El formato deja de ser solo "lista + markup": ahora dice EN QUÉ SE VENDE
-- (unidad o caja de N, con su propio código de barras) y CÓMO se define el
-- precio — por markup sobre el costo, o un precio final fijado a mano que no
-- se mueve aunque el costo cambie.

CREATE TYPE "public"."modo_precio" AS ENUM('markup', 'precio');
--> statement-breakpoint

ALTER TABLE "producto_listas" ADD COLUMN "unidades" double precision DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "producto_listas" ADD COLUMN "codigo_barras" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "producto_listas" ADD COLUMN "modo_precio" "modo_precio" DEFAULT 'markup' NOT NULL;
--> statement-breakpoint
ALTER TABLE "producto_listas" ADD COLUMN "precio_fijo" double precision DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_producto_lista_codigo" ON "producto_listas" USING btree ("codigo_barras") WHERE "producto_listas"."codigo_barras" <> '';
