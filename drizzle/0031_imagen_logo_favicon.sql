-- El logo del sitio y el favicon entran por el mismo estándar de imágenes.
ALTER TYPE "tipo_imagen_web" ADD VALUE IF NOT EXISTS 'logo';
--> statement-breakpoint
ALTER TYPE "tipo_imagen_web" ADD VALUE IF NOT EXISTS 'favicon';
