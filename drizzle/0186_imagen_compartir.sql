-- ===========================================================================
-- 0186 · TIENDA ONLINE › LA IMAGEN PARA COMPARTIR (20/10/2026)
-- ===========================================================================
-- La imagen que se ve al compartir el link del sitio por WhatsApp o Facebook
-- (og:image), subida en Tienda online › Configuración › General. Hay una sola:
-- cuelga del refId 1, como el logo y el favicon.

ALTER TYPE "tipo_imagen_web" ADD VALUE IF NOT EXISTS 'compartir';
