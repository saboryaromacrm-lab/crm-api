-- ===========================================================================
-- 0100 · EL RECARGO POR CUOTAS, EN EL PAGO QUE LO GENERO
-- ===========================================================================
-- Cuando se cobra con tarjeta de credito en cuotas, el recargo se le traslada
-- al cliente: entra a la venta como un cargo propio (`venta_extras`, con su
-- renglon y su IVA) y el total sube. Eso ya tenia donde vivir.
--
-- Lo que no tenia donde vivir es EN QUE PLAN se cobro y CUANTO de ese pago es
-- recargo. Sin las dos columnas, el dia de manana "cuanto me llevo la
-- financiacion este mes" se responde estimando -- y estimar sobre plata que ya
-- paso es exactamente lo que este sistema evita en todos lados.
--
-- `cuotas` NULA = no aplica (efectivo, debito, transferencia) o una tarjeta
-- cobrada sin plan. No es lo mismo que 1: uno es "no corresponde" y el otro es
-- "se eligio una cuota". Y `recargo` queda CONGELADO en el pago igual que el
-- costo en un renglon: cambiar el % en configuracion manana no puede mover lo
-- que ya se cobro, o la caja de un dia cerrado dejaria de cerrar.
-- ===========================================================================

ALTER TABLE "venta_pagos"
  ADD COLUMN IF NOT EXISTS "cuotas" integer;

ALTER TABLE "venta_pagos"
  ADD COLUMN IF NOT EXISTS "recargo" double precision NOT NULL DEFAULT 0;
