-- 0228 · FACTURAS QUE PAGA COFFIT (16/11/2026, pedido del dueño: «muchas veces Coffit ya paga algunas
-- facturas, entonces que no sume a la cuenta de Coffit con Sabor y Aroma»).
-- Un medio de pago a proveedor más: «Lo pagó Coffit». La factura queda pagada en la cuenta del
-- proveedor, no sale plata de la caja ni de Mis cuentas, y en la cuenta con Coffit entra a su favor
-- por el mismo importe (cafeteria/cuenta.ts, renglón `pago_proveedor`).
-- Nada lo usa en esta misma migración (ver 0204: un valor agregado no se puede usar antes de confirmar).
ALTER TYPE "medio_pago" ADD VALUE IF NOT EXISTS 'pago_coffit';
