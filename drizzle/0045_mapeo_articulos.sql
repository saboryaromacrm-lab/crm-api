-- MAPEO APRENDIDO: código del artículo en la factura del proveedor → producto.
--
-- Es lo que hace que la lectura del PDF reconozca un artículo la SEGUNDA vez:
-- la primera lo asocia el admin a mano en el alta, y al guardar el comprobante
-- el sistema recuerda (proveedor, código) → producto. Si se cancela, no se
-- aprende nada.
--
-- No reemplaza a producto_proveedores.codigo_proveedor (dato curado del
-- catálogo, que vino del sistema viejo con corrimientos): este se aprende de
-- facturas confirmadas por una persona y por eso resuelve primero.
CREATE TABLE IF NOT EXISTS "proveedor_articulos" (
  "id" serial PRIMARY KEY NOT NULL,
  "proveedor_id" integer NOT NULL,
  "codigo" text NOT NULL,
  "producto_id" integer NOT NULL,
  "descripcion" text DEFAULT '' NOT NULL,
  "actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proveedor_articulos" ADD CONSTRAINT "proveedor_articulos_proveedor_id_proveedores_id_fk"
  FOREIGN KEY ("proveedor_id") REFERENCES "proveedores"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proveedor_articulos" ADD CONSTRAINT "proveedor_articulos_producto_id_productos_id_fk"
  FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_proveedor_articulo" ON "proveedor_articulos" ("proveedor_id","codigo");
