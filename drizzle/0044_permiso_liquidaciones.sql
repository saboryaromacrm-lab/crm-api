-- Permiso para cargar y ver liquidaciones.
--
-- Va SEPARADO del permiso `facturas` a propósito: la liquidación es la mitad que
-- el proveedor entrega sin factura, es un documento no fiscal, y quién lo ve es
-- decisión del dueño — no una consecuencia de poder cargar compras.
--
-- Arranca solo para admin y superadmin. Aflojarlo después es fácil (Sistema ›
-- Roles); apretarlo una vez que todos lo vieron, no.
--
-- Por qué es una migración aparte y no un statement más en 0043: drizzle decide
-- qué migración corrió por su marca de tiempo del journal, no por el contenido
-- del archivo. Agregarle statements a una migración YA APLICADA los ejecuta solo
-- en las bases nuevas — en esta nunca hubieran corrido.
UPDATE "roles" SET "permisos" = "permisos" || '["liquidaciones"]'::jsonb
WHERE "clave" IN ('admin', 'superadmin') AND NOT ("permisos" ? 'liquidaciones');
