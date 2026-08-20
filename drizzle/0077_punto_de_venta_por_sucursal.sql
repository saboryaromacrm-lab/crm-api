-- UN PUNTO DE VENTA POR SUCURSAL (0077)
-- ============================================================================
-- Hasta acá el punto de venta era UNO para toda la empresa: una variable de
-- entorno para ARCA y un campo en Ventas › Configuración para los tickets. Con
-- un solo local alcanza; con cinco, no.
--
-- ARCA declara los puntos de venta CONTRA UN DOMICILIO, y cada uno lleva su
-- numeración correlativa independiente. Sabor y Aroma tiene cinco, uno por
-- local, todos bajo el mismo CUIT:
--
--   00028  28 de Junio 85          venta al por MAYOR   (la Distribuidora)
--   00029  Pringles 808            al por menor
--   00030  Belgrano 728            al por menor
--   00031  Av. 9 de Julio 1291     al por menor
--   00032  Av. González Lelong 1501 al por menor
--
-- Los números NO se cargan acá: son datos de la empresa, no del código. Van por
-- Gerencia › Sucursales, y en el servidor de producción hay que cargarlos igual
-- (una migración que los escriba los inventaría en cualquier base nueva).
--
-- CINCO DÍGITOS, NO CUATRO. Ninguno de los cinco entra en cuatro, y el número
-- del comprobante es lo que se coteja contra Mis Comprobantes. Es `text` y no
-- un entero justamente para que los ceros a la izquierda sean parte del dato.
--
-- EL DOMICILIO TAMBIÉN ES DE LA SUCURSAL: la factura lleva el domicilio
-- comercial del punto de venta que la emitió, no uno solo de la empresa. La de
-- Belgrano 728 tiene que decir Belgrano 728.

ALTER TABLE "sucursales" ADD COLUMN IF NOT EXISTS "punto_venta" text NOT NULL DEFAULT '';
ALTER TABLE "sucursales" ADD COLUMN IF NOT EXISTS "direccion" text NOT NULL DEFAULT '';

-- DOS SUCURSALES NO PUEDEN COMPARTIR PUNTO DE VENTA. Si lo hicieran, las dos
-- pedirían el mismo próximo número a ARCA y se pisarían —una emite, la otra
-- rebota con "el número no se corresponde con el próximo a registrar"—, y en el
-- libro de IVA quedarían mezcladas dos bocas de expendio. Parcial porque el
-- vacío es válido y hay varias: es "todavía no cargado".
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sucursal_punto_venta"
  ON "sucursales" ("punto_venta")
  WHERE "punto_venta" <> '';
