-- Módulo WEB: destacados del sitio + imágenes (producto/categoría/marca/banner)
-- y las secciones nuevas de permisos para el rol admin.
ALTER TABLE "productos" ADD COLUMN "destacado" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TYPE "public"."tipo_imagen_web" AS ENUM('producto', 'categoria', 'marca', 'banner');
--> statement-breakpoint
CREATE TABLE "web_imagenes" (
	"id" serial PRIMARY KEY NOT NULL,
	"tipo" "tipo_imagen_web" NOT NULL,
	"ref_id" integer NOT NULL,
	"mime" text DEFAULT 'image/jpeg' NOT NULL,
	"data" text NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_web_imagen" ON "web_imagenes" USING btree ("tipo","ref_id");
--> statement-breakpoint
UPDATE "roles" SET "permisos" = "permisos" || '["web.productos", "web.ofertas", "web.contenido"]'::jsonb WHERE "clave" = 'admin';
