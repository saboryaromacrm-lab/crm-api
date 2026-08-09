-- SOLO PARA FRACCIONAR — el "SOLO STOCK" del sistema viejo.
--
-- Hay granel que no se vende suelto: existe únicamente para fraccionarse (la
-- Pimienta de Jamaica llega 1 kg y se fracciona entera en 20 paquetes de 50 g).
-- Sin este flag, el POS podía vender "0,5 kg de pimienta suelta" Y la bolsa de
-- 50 g del mismo producto. El candado real está en la venta (API); el POS
-- además no la ofrece suelta.
ALTER TABLE "productos" ADD COLUMN "solo_fraccionar" boolean DEFAULT false NOT NULL;
