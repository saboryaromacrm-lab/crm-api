-- ===========================================================================
-- CATÁLOGOS DEL PRODUCTO — marca / categoría › subcategoría / etiquetas
-- ===========================================================================
-- `productos.marca` y `productos.categoria` eran texto libre. Pasan a ser
-- entidades con id. La parte delicada es la NORMALIZACIÓN: los valores que hoy
-- difieren solo en mayúsculas o espacios son la misma marca, y tienen que
-- terminar en una sola fila. Se compara por `upper(btrim(...))` y se conserva
-- la primera grafía encontrada.
--
-- Las reglas de marca también migran a id: si alguna apunta a una marca que
-- ningún producto usa, la marca se crea igual (borrar la regla sería perder
-- una decisión del usuario sin avisar).

CREATE TABLE IF NOT EXISTS "marcas" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"activa" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "categorias" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"activa" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subcategorias" (
	"id" serial PRIMARY KEY NOT NULL,
	"categoria_id" integer NOT NULL,
	"nombre" text NOT NULL,
	"activa" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "etiquetas" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"color" text DEFAULT '' NOT NULL,
	"activa" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "producto_etiquetas" (
	"id" serial PRIMARY KEY NOT NULL,
	"producto_id" integer NOT NULL,
	"etiqueta_id" integer NOT NULL
);
--> statement-breakpoint

ALTER TABLE "subcategorias" ADD CONSTRAINT "subcategorias_categoria_id_categorias_id_fk" FOREIGN KEY ("categoria_id") REFERENCES "public"."categorias"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "producto_etiquetas" ADD CONSTRAINT "producto_etiquetas_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "producto_etiquetas" ADD CONSTRAINT "producto_etiquetas_etiqueta_id_etiquetas_id_fk" FOREIGN KEY ("etiqueta_id") REFERENCES "public"."etiquetas"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uq_marca_nombre" ON "marcas" USING btree ("nombre");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_categoria_nombre" ON "categorias" USING btree ("nombre");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_subcategoria_nombre" ON "subcategorias" USING btree ("categoria_id","nombre");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_etiqueta_nombre" ON "etiquetas" USING btree ("nombre");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_producto_etiqueta" ON "producto_etiquetas" USING btree ("producto_id","etiqueta_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_producto_etiquetas_etiqueta" ON "producto_etiquetas" USING btree ("etiqueta_id");
--> statement-breakpoint

-- Normalización: una fila por marca distinta ignorando caja y espacios.
INSERT INTO "marcas" ("nombre")
SELECT DISTINCT ON (upper(btrim("marca"))) btrim("marca")
FROM "productos"
WHERE btrim("marca") <> ''
ORDER BY upper(btrim("marca")), btrim("marca");
--> statement-breakpoint
-- Marcas que solo existen en una regla (ningún producto las usa todavía).
INSERT INTO "marcas" ("nombre")
SELECT DISTINCT ON (upper(btrim(r."marca"))) btrim(r."marca")
FROM "reglas_marca" r
WHERE btrim(r."marca") <> ''
  AND NOT EXISTS (SELECT 1 FROM "marcas" m WHERE upper(m."nombre") = upper(btrim(r."marca")))
ORDER BY upper(btrim(r."marca")), btrim(r."marca");
--> statement-breakpoint
INSERT INTO "categorias" ("nombre")
SELECT DISTINCT ON (upper(btrim("categoria"))) btrim("categoria")
FROM "productos"
WHERE btrim("categoria") <> ''
ORDER BY upper(btrim("categoria")), btrim("categoria");
--> statement-breakpoint

-- Campos nuevos del producto.
ALTER TABLE "productos" ADD COLUMN "descripcion" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "productos" ADD COLUMN "codigo_propio" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "productos" ADD COLUMN "dun" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "productos" ADD COLUMN "unidades_por_bulto" double precision DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "productos" ADD COLUMN "marca_id" integer;
--> statement-breakpoint
ALTER TABLE "productos" ADD COLUMN "categoria_id" integer;
--> statement-breakpoint
ALTER TABLE "productos" ADD COLUMN "subcategoria_id" integer;
--> statement-breakpoint
ALTER TABLE "productos" ADD COLUMN "redondeo" integer;
--> statement-breakpoint
ALTER TABLE "productos" ADD COLUMN "publicado" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "productos" ADD COLUMN "id_externo" text DEFAULT '' NOT NULL;
--> statement-breakpoint

UPDATE "productos" p SET "marca_id" = m."id"
FROM "marcas" m WHERE upper(btrim(p."marca")) = upper(m."nombre");
--> statement-breakpoint
UPDATE "productos" p SET "categoria_id" = c."id"
FROM "categorias" c WHERE upper(btrim(p."categoria")) = upper(c."nombre");
--> statement-breakpoint

ALTER TABLE "productos" ADD CONSTRAINT "productos_marca_id_marcas_id_fk" FOREIGN KEY ("marca_id") REFERENCES "public"."marcas"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "productos" ADD CONSTRAINT "productos_categoria_id_categorias_id_fk" FOREIGN KEY ("categoria_id") REFERENCES "public"."categorias"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "productos" ADD CONSTRAINT "productos_subcategoria_id_subcategorias_id_fk" FOREIGN KEY ("subcategoria_id") REFERENCES "public"."subcategorias"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "productos" DROP COLUMN IF EXISTS "marca";
--> statement-breakpoint
ALTER TABLE "productos" DROP COLUMN IF EXISTS "categoria";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "ix_productos_codigo_propio" ON "productos" USING btree ("codigo_propio");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_productos_marca" ON "productos" USING btree ("marca_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_productos_categoria" ON "productos" USING btree ("categoria_id");
--> statement-breakpoint
-- Parciales: el código vacío significa "sin código" y puede repetirse.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_producto_codigo_propio" ON "productos" USING btree ("codigo_propio") WHERE "productos"."codigo_propio" <> '';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_producto_codigo_barras" ON "productos" USING btree ("codigo_barras") WHERE "productos"."codigo_barras" <> '';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_producto_dun" ON "productos" USING btree ("dun") WHERE "productos"."dun" <> '';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_presentacion_codigo_barras" ON "presentaciones" USING btree ("codigo_barras") WHERE "presentaciones"."codigo_barras" <> '';
--> statement-breakpoint

-- Reglas de marca: de texto a id.
ALTER TABLE "reglas_marca" ADD COLUMN "marca_id" integer;
--> statement-breakpoint
UPDATE "reglas_marca" r SET "marca_id" = m."id"
FROM "marcas" m WHERE upper(btrim(r."marca")) = upper(m."nombre");
--> statement-breakpoint
DELETE FROM "reglas_marca" WHERE "marca_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "reglas_marca" ALTER COLUMN "marca_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "reglas_marca" ADD CONSTRAINT "reglas_marca_marca_id_marcas_id_fk" FOREIGN KEY ("marca_id") REFERENCES "public"."marcas"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
DROP INDEX IF EXISTS "uq_regla_marca";
--> statement-breakpoint
ALTER TABLE "reglas_marca" DROP COLUMN IF EXISTS "marca";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_regla_marca" ON "reglas_marca" USING btree ("marca_id","modalidad_id");
--> statement-breakpoint

-- El código del proveedor es del par producto × proveedor: el mismo artículo
-- tiene un código distinto en cada uno.
ALTER TABLE "producto_proveedores" ADD COLUMN "codigo_proveedor" text DEFAULT '' NOT NULL;
