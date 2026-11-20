-- 0236 · EL CAMBIO: DEVUELVE Y SE LLEVA OTRA COSA (19/11/2026, pedido del dueño con una NC real de
-- Express 3: el cliente devolvió un aceite y se llevó otras cosas por casi lo mismo; la cajera cobró
-- la diferencia y anotó el resto como QR, que nunca entró a Mercado Pago).
--
-- Al emitir la nota de crédito de una venta al contado se elige cómo se devuelve: efectivo del cajón,
-- por el mismo medio (anotado), o CAMBIO. El cambio deja la nota como crédito para la venta que se
-- arma en ese momento, en el mismo local: esa venta la usa como medio de pago «nota_credito» (atado
-- a la nota por `nc_venta_id`). Si se lleva menos, el sobrante se devuelve en el acto, en efectivo
-- (`cambio_efectivo`, con su egreso del turno) o por el mismo medio (`cambio_medio`). Lo que le queda
-- a un cambio no se guarda: es el total menos lo usado por ventas vivas menos lo devuelto.
-- Nada usa el valor nuevo del enum en esta misma migración (ver 0204).
ALTER TYPE "medio_pago" ADD VALUE IF NOT EXISTS 'nota_credito';
ALTER TABLE "ventas" ADD COLUMN IF NOT EXISTS "cambio" boolean NOT NULL DEFAULT false;
ALTER TABLE "ventas" ADD COLUMN IF NOT EXISTS "cambio_efectivo" double precision NOT NULL DEFAULT 0;
ALTER TABLE "ventas" ADD COLUMN IF NOT EXISTS "cambio_medio" double precision NOT NULL DEFAULT 0;
ALTER TABLE "venta_pagos" ADD COLUMN IF NOT EXISTS "nc_venta_id" integer REFERENCES "ventas"("id") ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS "ix_venta_pagos_nc" ON "venta_pagos" ("nc_venta_id") WHERE "nc_venta_id" IS NOT NULL;
