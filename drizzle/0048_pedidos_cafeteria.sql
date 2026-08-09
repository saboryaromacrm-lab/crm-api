-- PEDIDOS DE LA CAFETERÍA — la demanda, separada del envío.
--
-- Coffit (la cafetería) arma su pedido y la distribuidora lo recibe para
-- armarlo. El pedido lo carga el usuario del rol Cafetería desde el CRM (una
-- sola sección visible: el catálogo completo con disponibilidad, que es lo que
-- coffit no puede ver). NO toca stock ni costo: la realidad entra con el ENVÍO,
-- que se crea desde el pedido y lo cierra.
--
--   pendiente → armando → enviado · anulado (con motivo)

CREATE TYPE "estado_pedido_cafe" AS ENUM ('pendiente', 'armando', 'enviado', 'anulado');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pedidos_cafeteria" (
  "id" serial PRIMARY KEY NOT NULL,
  "codigo" text DEFAULT '' NOT NULL,
  "fecha" timestamp with time zone DEFAULT now() NOT NULL,
  "usuario_id" integer,
  "estado" "estado_pedido_cafe" DEFAULT 'pendiente' NOT NULL,
  "observaciones" text DEFAULT '' NOT NULL,
  "motivo_anulacion" text DEFAULT '' NOT NULL,
  "actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pedidos_cafeteria" ADD CONSTRAINT "pedidos_cafeteria_usuario_id_usuarios_id_fk"
  FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_pedidos_cafe_estado" ON "pedidos_cafeteria" ("estado");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pedido_cafeteria_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "pedido_id" integer NOT NULL,
  "producto_id" integer NOT NULL,
  "presentacion_id" integer,
  "cantidad" double precision DEFAULT 0 NOT NULL,
  "nombre" text DEFAULT '' NOT NULL,
  "unidad" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pedido_cafeteria_items" ADD CONSTRAINT "pedido_cafeteria_items_pedido_id_fk"
  FOREIGN KEY ("pedido_id") REFERENCES "pedidos_cafeteria"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pedido_cafeteria_items" ADD CONSTRAINT "pedido_cafeteria_items_producto_id_fk"
  FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pedido_cafeteria_items" ADD CONSTRAINT "pedido_cafeteria_items_presentacion_id_fk"
  FOREIGN KEY ("presentacion_id") REFERENCES "presentaciones"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- El envío conoce su origen (sin FK dura: la tabla del pedido se declara
-- después en el schema, mismo criterio que ref_comprobante_id).
ALTER TABLE "envios_cafeteria" ADD COLUMN "pedido_id" integer;
--> statement-breakpoint

-- EL ROL CAFETERÍA: una sola sección. Sin ninguna otra clave, ese usuario no
-- ve nada más del CRM (sin sección = módulo invisible). No es de sistema: el
-- admin puede ajustarlo desde Usuarios y roles.
INSERT INTO "roles" ("clave", "nombre", "descripcion", "permisos", "es_sistema")
SELECT 'cafeteria', 'Cafetería',
  'El usuario del café: arma el pedido a la distribuidora y le sigue el estado. No ve nada más.',
  '["almacen.cafeteria-pedidos"]'::jsonb, false
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "clave" = 'cafeteria');
--> statement-breakpoint

-- La sección nueva también para admin y superadmin (los roles guardan lista
-- explícita, no wildcard — mismo patrón que compras.lecturas en la 0041).
UPDATE "roles" SET "permisos" = "permisos" || '["almacen.cafeteria-pedidos"]'::jsonb
WHERE "clave" IN ('admin', 'superadmin')
  AND NOT ("permisos" ? 'almacen.cafeteria-pedidos');
