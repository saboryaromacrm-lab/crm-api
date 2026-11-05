-- ===========================================================================
-- 0220 · CUÁNDO SE ASENTÓ CADA PAGO Y CADA FACTURA DEL MES (5/11/2026, pedido del dueño)
-- ===========================================================================
-- «En el estado de cuenta del proveedor, fecha de la factura y fecha de
-- asentamiento.» Facturas, liquidaciones y gastos ya guardan `fecha_carga` y
-- los ajustes `creado_en`; los pagos y las facturas del mes solo tenían la
-- fecha del documento. Los que ya existen quedan en NULL (no se sabe cuándo
-- se cargaron: la pantalla muestra «—»); los nuevos los llena la base sola.
-- ===========================================================================
ALTER TABLE "proveedor_pagos" ADD COLUMN IF NOT EXISTS "creado_en" timestamptz;
ALTER TABLE "proveedor_pagos" ALTER COLUMN "creado_en" SET DEFAULT now();
ALTER TABLE "facturaciones_mes_facturas" ADD COLUMN IF NOT EXISTS "creado_en" timestamptz;
ALTER TABLE "facturaciones_mes_facturas" ALTER COLUMN "creado_en" SET DEFAULT now();
