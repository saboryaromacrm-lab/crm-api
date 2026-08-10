-- Sección propia para el LISTADO DE VENTAS del POS.
--
-- Hasta acá el sistema no tenía ninguna pantalla que respondiera "¿qué se
-- vendió?": la única lista de ventas vivía adentro del detalle de un cliente
-- (sus últimas 100). El turno de caja mostraba la plata, no los tickets.
--
-- Va como sección aparte de `ventas.caja` a propósito: el listado es una
-- CONSULTA de todo el negocio (buscar un ticket viejo, ver cuánto vendió cada
-- cajero, cuánto costaron las promos) y meterlo dentro de Caja lo ataba al
-- turno abierto. Además así se puede dar el listado sin dar el cierre de caja,
-- que es una responsabilidad distinta.
--
-- Se otorga a admin y a cajero. El CAJERO la necesita para su propio mostrador
-- (buscar el ticket de alguien que volvió, reimprimirlo), y la pantalla lo
-- ata a la sucursal donde está operando; admin y superadmin ven todas.
-- El superadmin ya tiene '*'.
UPDATE "roles" SET "permisos" = "permisos" || '["ventas.listado"]'::jsonb
WHERE "clave" IN ('admin', 'cajero') AND NOT ("permisos" ? 'ventas.listado');
