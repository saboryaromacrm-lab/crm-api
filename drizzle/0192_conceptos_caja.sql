-- ===========================================================================
-- 0192 · CONCEPTOS EN LA CAJA DE LOS LOCALES (21/10/2026)
-- ===========================================================================
-- Pedido del dueño: los ingresos y egresos de la caja de un local llevan
-- SIEMPRE un concepto (más una descripción), y la lista es LA MISMA del Cash
-- Flow. Antes el motivo se escribía a mano y no se podía sumar por concepto.
--
--   cashflow_conceptos.en_cashflow   se ofrece en el Cash Flow (la caja central)
--   cashflow_conceptos.en_caja       se ofrece en la caja de los locales
--                                    (al menos uno de los dos)
--   cashflow_conceptos.pide_detalle  la descripción es obligatoria («Otro egreso»)
--   caja_movimientos.concepto_id     el concepto del ingreso/egreso del turno.
--                                    NULL = cargado a mano antes de este cambio,
--                                    o nacido de otro circuito (pago a proveedor,
--                                    devolución), que no lleva concepto.
-- ===========================================================================
ALTER TABLE "cashflow_conceptos" ADD COLUMN IF NOT EXISTS "en_cashflow" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "cashflow_conceptos" ADD COLUMN IF NOT EXISTS "en_caja" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "cashflow_conceptos" ADD COLUMN IF NOT EXISTS "pide_detalle" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- El cambio por transferencia (0191) es del Cash Flow: en la caja de un local no se ofrece.
UPDATE "cashflow_conceptos" SET "en_caja" = false
  WHERE lower("nombre") LIKE '%efectivo por transferencia%';
--> statement-breakpoint
ALTER TABLE "cashflow_conceptos" DROP CONSTRAINT IF EXISTS "ck_cashflow_concepto_donde";
--> statement-breakpoint
ALTER TABLE "cashflow_conceptos" ADD CONSTRAINT "ck_cashflow_concepto_donde" CHECK ("en_cashflow" OR "en_caja");
--> statement-breakpoint
ALTER TABLE "caja_movimientos" ADD COLUMN IF NOT EXISTS "concepto_id" integer REFERENCES "cashflow_conceptos"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_caja_mov_concepto" ON "caja_movimientos" ("concepto_id") WHERE "concepto_id" IS NOT NULL;
--> statement-breakpoint
-- Para que la caja nunca quede trabada por falta de un concepto: el genérico, con descripción obligatoria.
INSERT INTO "cashflow_conceptos" ("nombre", "tipo", "clase", "orden", "pide_detalle") VALUES
  ('Otro egreso', 'egreso', 'movimiento', 900, true),
  ('Otro ingreso', 'ingreso', 'movimiento', 900, true)
ON CONFLICT DO NOTHING;
