-- ===========================================================================
-- 0175 · EFECTIVO POR TRANSFERENCIA (16/10/2026)
-- ===========================================================================
-- Pedido del dueño: el proveedor cobra por transferencia, no hay plata en el
-- banco pero sí efectivo; se le da el efectivo a otra persona y ELLA le
-- transfiere al proveedor. El pago queda por transferencia (lo que recibió el
-- proveedor) y `cambio_por` dice quién hizo el cambio: la plata sale como
-- efectivo (del cajón del turno o del Cash Flow).
-- ===========================================================================
ALTER TABLE "proveedor_pagos" ADD COLUMN IF NOT EXISTS "cambio_por" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_proveedor_pagos_cambio" ON "proveedor_pagos" ("fecha") WHERE "cambio_por" IS NOT NULL;
