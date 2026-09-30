-- ===========================================================================
-- 0124 · FACTURA ELECTRÓNICA POR SUCURSAL (30/9/2026)
-- ===========================================================================
-- Pedido del dueño: cada sucursal factura con SU punto de venta y se enciende
-- de a una. La Distribuidora (punto de venta 34, Sarmiento 1314) ya factura en
-- producción; las demás todavía no tienen el suyo.
--
-- Antes, con ARCA prendido, una sucursal sin punto de venta propio facturaba
-- con el de la variable de entorno (el 34): una factura real con el domicilio
-- de OTRO local. Desde acá una sucursal factura electrónicamente SOLO si:
--   · ARCA está prendido (el interruptor general de Ventas › Configuración),
--   · tiene su propio punto de venta cargado, y
--   · esta marca está tildada (Gerencia › Sucursales).
-- Si falta algo, esa sucursal trabaja como antes de ARCA: comprobante interno
-- sin CAE, y nunca con el punto de venta de otro local.
-- ===========================================================================

ALTER TABLE "sucursales" ADD COLUMN IF NOT EXISTS "factura_electronica" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- La que ya factura hoy sigue facturando sin tocar nada: la del punto de venta 34.
UPDATE "sucursales" SET "factura_electronica" = true
WHERE nullif(regexp_replace("punto_venta", '\D', '', 'g'), '')::int = 34;
