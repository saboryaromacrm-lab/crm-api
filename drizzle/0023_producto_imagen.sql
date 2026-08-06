-- Foto del producto para el sitio web. Vacío = el frontend muestra una
-- imagen genérica; la carga real es del módulo Web, más adelante.
ALTER TABLE "productos" ADD COLUMN "imagen_url" text NOT NULL DEFAULT '';
