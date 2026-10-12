-- ===========================================================================
-- 0157 · COMISIÓN DEL PROVEEDOR EN EL FORMATO DE COMPRA (11/10/2026)
-- ===========================================================================
-- Pedido del dueño: un proveedor cobra aparte una comisión SIN FACTURA sobre lo
-- comprado (5,94 % sobre la mercadería sin IVA). Va al costo de cada producto,
-- en su propio campo y no en el flete: el flete se supone facturado (su IVA
-- vuelve) y tiene su propio número; la comisión va entera al costo.
--
--   producto_proveedores.comision          % sobre la mercadería sin IVA (0–100)
--   producto_proveedor_costos.comision*    antes/después en el historial de
--                                          costos; nulos = esa fila no la tocó
--                                          (como el bulto y el precio final).
-- ===========================================================================
ALTER TABLE "producto_proveedores" ADD COLUMN IF NOT EXISTS "comision" double precision NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "producto_proveedores" ADD CONSTRAINT "ck_producto_proveedores_comision" CHECK ("comision" >= 0 AND "comision" <= 100);
--> statement-breakpoint
ALTER TABLE "producto_proveedor_costos" ADD COLUMN IF NOT EXISTS "comision_anterior" double precision;
--> statement-breakpoint
ALTER TABLE "producto_proveedor_costos" ADD COLUMN IF NOT EXISTS "comision" double precision;
