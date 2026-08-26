-- LA MIGRACIÓN DESDE EL SISTEMA VIEJO SE HACE PROVEEDOR POR PROVEEDOR (26/8),
-- y el administrativo necesita ver por dónde va. Dos campos en el padrón:
--
--   productos_esperados  cuántos productos tiene este proveedor en el sistema
--                        viejo (columna "Productos asociados" de su export).
--                        Es REFERENCIA, no verdad: puede incluir discontinuados
--                        que nunca van a migrar. Contra este número se muestra
--                        el avance ("35 de 64").
--   migracion_lista      el tilde MANUAL de "terminé con este proveedor".
--                        Manual a propósito: el que sabe si el catálogo está
--                        completo es el que lo carga, no un contador.
--
-- Idempotente: se puede correr sobre una base que ya los tenga.

ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS productos_esperados integer NOT NULL DEFAULT 0;
ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS migracion_lista boolean NOT NULL DEFAULT false;
