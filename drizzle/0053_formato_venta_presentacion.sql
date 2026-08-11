-- ============================================================================
-- EL PAQUETE FRACCIONADO SE VENDE SOLO
-- ============================================================================
-- Hasta acá el precio de un paquete era derivado de la madre: precio por kg de
-- la lista × tamaño × un `recargo` de fraccionamiento. Eso alcanzaba mientras
-- el paquete fuera "un kilo partido", pero no es lo que pasa en el mostrador:
-- el paquete tiene su propio precio, su propia caja por N, su propio mínimo y
-- sus propias ofertas. Y sobre todo: 73 de las 103 madres con fraccionados NO
-- tienen listas de venta, así que sus paquetes no tenían precio de verdad (el
-- cálculo se caía al costo neto — había paquetes cotizando por debajo del
-- costo).
--
-- Así que el FORMATO DE VENTA deja de ser del producto y pasa a ser de "lo que
-- se vende": el producto suelto (presentacion_id NULL) o uno de sus paquetes.
-- Es la misma tabla a propósito: un solo motor de precio, un solo lugar donde
-- vive "cómo se vende esto". Una tabla aparte habría duplicado la derivación
-- markup/precio-fijo, el redondeo de góndola y la validación de códigos.
ALTER TABLE "producto_listas" ADD COLUMN "presentacion_id" integer;
--> statement-breakpoint
ALTER TABLE "producto_listas" ADD CONSTRAINT "producto_listas_presentacion_id_presentaciones_id_fk"
  FOREIGN KEY ("presentacion_id") REFERENCES "public"."presentaciones"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- El único de siempre era (producto, lista). Ahora son DOS reglas distintas y
-- un único común NO sirve: en Postgres los NULL son distintos entre sí, así que
-- (5, NULL, 3) podría entrar dos veces y la madre tendría dos precios para la
-- misma lista. Dos índices parciales dicen exactamente lo que se quiere decir.
DROP INDEX IF EXISTS "uq_producto_lista";
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_producto_lista" ON "producto_listas" USING btree ("producto_id","lista_id")
  WHERE "producto_listas"."presentacion_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_presentacion_lista" ON "producto_listas" USING btree ("presentacion_id","lista_id")
  WHERE "producto_listas"."presentacion_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "ix_producto_listas_presentacion" ON "producto_listas" USING btree ("presentacion_id");
--> statement-breakpoint

-- Y muere el recargo. No queda como columna dormida: mientras exista, alguien
-- la va a leer y va a haber dos formas de decir cuánto vale un paquete. Los 44
-- que tenían recargo cargado arrancan sin precio y se cargan a mano — decisión
-- del dueño, con el contador de "paquetes sin precio" para no perderlos de vista.
ALTER TABLE "presentaciones" DROP COLUMN "recargo";
