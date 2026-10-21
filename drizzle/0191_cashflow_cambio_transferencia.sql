-- ===========================================================================
-- 0191 · CASH FLOW: SACAR PLATA COMO EFECTIVO POR TRANSFERENCIA (21/10/2026)
-- ===========================================================================
-- Pedido del dueño: además del pago a proveedor (0175), cualquier salida de
-- «Sacar plata» puede ser un CAMBIO: le das el efectivo a alguien y esa persona
-- transfiere (a tu cuenta, a un proveedor o para pagar un gasto). La plata sale
-- de la caja como efectivo; queda anotado quién hizo la transferencia y a qué
-- cuenta fue.
--
--   cashflow_movimientos.cambio_por     quién hizo la transferencia (a quién se
--                                       le dio el efectivo). NULL = salió en efectivo.
--   cashflow_movimientos.cambio_cuenta  a qué cuenta transfirió (en un pago a
--                                       proveedor es la del proveedor: queda NULL).
-- ===========================================================================
ALTER TABLE "cashflow_movimientos" ADD COLUMN IF NOT EXISTS "cambio_por" text;
--> statement-breakpoint
ALTER TABLE "cashflow_movimientos" ADD COLUMN IF NOT EXISTS "cambio_cuenta" text;
--> statement-breakpoint
-- Los pagos a proveedor por efectivo por transferencia ya hechos (0175) quedan marcados igual.
UPDATE "cashflow_movimientos" m SET "cambio_por" = pp."cambio_por"
  FROM "proveedor_pagos" pp
  WHERE pp."id" = m."pago_id" AND pp."cambio_por" IS NOT NULL AND m."cambio_por" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_cashflow_mov_cambio" ON "cashflow_movimientos" ("fecha") WHERE "cambio_por" IS NOT NULL;
--> statement-breakpoint
-- El concepto para el caso más común: el efectivo pasa a tu cuenta por la transferencia de otro.
INSERT INTO "cashflow_conceptos" ("nombre", "tipo", "clase", "orden") VALUES
  ('Cambio a mi cuenta (efectivo por transferencia)', 'egreso', 'movimiento', 25)
ON CONFLICT DO NOTHING;
