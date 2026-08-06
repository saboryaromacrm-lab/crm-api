-- Configuración del sitio (logo, favicon, contacto y redes) es una sección
-- nueva del módulo Web.
UPDATE "roles" SET "permisos" = "permisos" || '["web.configuracion"]'::jsonb WHERE "clave" = 'admin';
