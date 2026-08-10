-- EL PRODUCTO NO SE BORRA: SE DA DE BAJA (y se puede reactivar).
--
-- El sistema ya tenía el principio escrito ("lo que está en uso se desactiva,
-- no se borra") y lo cumplían las marcas, las categorías, las listas, las
-- ofertas, los clientes y los usuarios. El PRODUCTO —el que más historia
-- acumula— era la única excepción: solo tenía Eliminar, y era borrado real.
--
-- Y son DOS decisiones distintas, no una:
--   discontinuado  no se compra más, PERO SE SIGUE VENDIENDO hasta agotar.
--                  Apagarlo todo de golpe deja sin vender lo que hay en
--                  góndola; no apagar nada ensucia las compras para siempre.
--   archivado      fuera de catálogo: no se compra ni se vende.
--
-- Reactivar es un clic y conserva TODO: códigos, historial de precios,
-- presentaciones, formatos de compra por proveedor, cuántas veces venció.

CREATE TYPE "estado_producto" AS ENUM ('activo', 'discontinuado', 'archivado');
--> statement-breakpoint
ALTER TABLE "productos" ADD COLUMN "estado" "estado_producto" DEFAULT 'activo' NOT NULL;
--> statement-breakpoint
ALTER TABLE "productos" ADD COLUMN "estado_desde" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "productos" ADD COLUMN "motivo_baja" text DEFAULT '' NOT NULL;
--> statement-breakpoint
-- El índice lo usan TODOS los listados (POS, tienda, compras, reposición).
CREATE INDEX IF NOT EXISTS "ix_productos_estado" ON "productos" ("estado");
--> statement-breakpoint

-- FK QUE PODÍAN MUTILAR HISTORIA. Con `cascade`, borrar un producto hacía
-- desaparecer en silencio sus existencias, los renglones de transferencias
-- viejas y sus incidencias. Ahora es `restrict`: el borrado real solo pasa si
-- el producto no dejó NINGUNA huella, y el servicio corta antes con un mensaje
-- que explica cuál es la huella (en vez del error crudo de la base).
ALTER TABLE "stock" DROP CONSTRAINT IF EXISTS "stock_producto_id_productos_id_fk";
--> statement-breakpoint
ALTER TABLE "stock" ADD CONSTRAINT "stock_producto_id_productos_id_fk"
  FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transferencia_items" DROP CONSTRAINT IF EXISTS "transferencia_items_producto_id_productos_id_fk";
--> statement-breakpoint
ALTER TABLE "transferencia_items" ADD CONSTRAINT "transferencia_items_producto_id_productos_id_fk"
  FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "incidencias" DROP CONSTRAINT IF EXISTS "incidencias_producto_id_productos_id_fk";
--> statement-breakpoint
ALTER TABLE "incidencias" ADD CONSTRAINT "incidencias_producto_id_productos_id_fk"
  FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE restrict ON UPDATE no action;
