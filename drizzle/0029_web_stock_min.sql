-- Piso de stock para la venta online, por producto: cuando el disponible de
-- la Distribuidora llega a este número, el sitio muestra "Sin stock" y lo que
-- queda se prioriza para fraccionamiento / venta minorista. 0 = sin piso.
ALTER TABLE "productos" ADD COLUMN "web_stock_min" double precision DEFAULT 0 NOT NULL;
