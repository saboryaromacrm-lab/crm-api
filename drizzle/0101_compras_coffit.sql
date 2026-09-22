-- ===========================================================================
-- 0101 · LA PLATA SIGUE A LA MERCADERIA: que parte de una compra es de Coffit
-- ===========================================================================
-- El dueno tiene DOS negocios con el MISMO CUIT. El proveedor le factura a la
-- distribuidora y la distribuidora le paga: lo fiscal y la deuda no se mueven.
-- Lo que SI se mueve es a quien le pesa el costo, y hasta aca todo le pesaba a
-- la distribuidora aunque la mercaderia fuera del cafe.
--
-- Tres columnas, ninguna decision nueva para el que carga:
--
-- `comprobante_items.para_cafeteria` — el renglon es de un articulo de USO
--   EXCLUSIVO de la cafeteria (`productos.solo_cafeteria`), congelado al
--   cargar. Se congela porque la marca de la ficha puede cambiar manana y
--   una factura de hace seis meses no puede cambiar de dueno con ella.
--
-- `comprobantes.neto_cafeteria` — la suma de esos renglones, ya bonificados.
--   Desnormalizado a proposito: Gerencia y el resumen del cafe lo leen en
--   cada apertura, agrupado por periodo, y no tienen por que recorrer los
--   renglones para eso. Sin IVA: el credito fiscal es del CUIT, no del cafe.
--
-- `envio_cafeteria_items.exclusivo` — el renglon salio del stock exclusivo
--   del cafe (su costo YA se le imputo al comprarlo). Es lo que evita contar
--   la misma plata dos veces: lo que se compro directo para el cafe no se
--   vuelve a descontar de la distribuidora cuando cruza la calle.
--
-- Sin backfill (decision del dueno, 22/9/2026): el sistema todavia no esta
-- en uso real y la imputacion arranca de cero desde hoy.
-- ===========================================================================

ALTER TABLE "comprobante_items"
  ADD COLUMN IF NOT EXISTS "para_cafeteria" boolean NOT NULL DEFAULT false;

ALTER TABLE "comprobantes"
  ADD COLUMN IF NOT EXISTS "neto_cafeteria" double precision NOT NULL DEFAULT 0;

ALTER TABLE "envio_cafeteria_items"
  ADD COLUMN IF NOT EXISTS "exclusivo" boolean NOT NULL DEFAULT false;
