-- ===========================================================================
-- 0184 · UNA FOTO NUEVA TAMBIÉN RENUEVA EL CATÁLOGO DEL ERP (19/10/2026)
-- ===========================================================================
-- El ERP guarda una copia del catálogo y la renueva cuando sube `ver_catalogo`
-- (0094). La foto de cada producto ahora se ve y se carga en Compras ›
-- Productos (`fotoUrl`), pero `web_imagenes` no movía la versión: una foto
-- subida en otra computadora no aparecía hasta que cambiara otra cosa del
-- catálogo (el filtro «con / sin foto» ya tenía ese atraso). Se suma su
-- disparador, igual a los de 0094.
DROP TRIGGER IF EXISTS tg_ver_web_imagenes ON "web_imagenes";
CREATE TRIGGER tg_ver_web_imagenes AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "web_imagenes" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_catalogo');
