-- ===========================================================================
-- 0151 · PAGO PROPIO A UNA CUENTA DISPONIBLE (9/10/2026)
-- ===========================================================================
-- Pedido del dueño: además de las transferencias de clientes (que nacen en el
-- cobro de una venta o de un recibo), Sabor y Aroma puede transferir desde su
-- propia cuenta a la cuenta disponible del proveedor, sin pasar por la caja.
-- Ese pago no tiene renglón de cobro: se marca `propio`, y el CHECK pasa a ser
-- «exactamente uno de los tres orígenes». Igual que los otros, lleva su espejo
-- en la cuenta corriente del proveedor (proveedor_pagos).
-- ===========================================================================
ALTER TABLE "cuenta_disponible_pagos" ADD COLUMN "propio" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "cuenta_disponible_pagos" DROP CONSTRAINT "ck_cta_disp_pagos_origen";
--> statement-breakpoint
ALTER TABLE "cuenta_disponible_pagos" ADD CONSTRAINT "ck_cta_disp_pagos_origen" CHECK (
  ("venta_pago_id" IS NOT NULL)::int + ("cobranza_pago_id" IS NOT NULL)::int + ("propio")::int = 1
);
