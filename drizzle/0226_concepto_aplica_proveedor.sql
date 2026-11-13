-- ===========================================================================
-- 0226 · EL CONCEPTO DICE SI SE APLICA A UN PROVEEDOR (13/11/2026, pedido del dueño)
-- ===========================================================================
-- Hasta acá solo un egreso que dijera «depósito» se podía pasar a la cuenta de
-- un proveedor: se reconocía por el NOMBRE (16/10/2026). El dueño carga ahora
-- un concepto de pago a proveedor (el que pasa a cobrar por el local, en
-- efectivo) y necesita lo mismo. Pasa a ser una marca del concepto, que se
-- tilda en Cash Flow › Configuración › Conceptos:
--
--   · en el Cash Flow, al sacar plata con ese concepto se ofrece aplicarla a un
--     proveedor (y después, en Movimientos, «Aplicar a proveedor»);
--   · en la caja de un local, se ofrece cargarla como pago a un proveedor.
--
-- Solo un EGRESO que es movimiento de plata (un gasto ya va a Gastos). Los que
-- hoy dicen «depósito» arrancan tildados: siguen funcionando igual que antes.
-- ===========================================================================
ALTER TABLE "cashflow_conceptos" ADD COLUMN IF NOT EXISTS "aplica_proveedor" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "cashflow_conceptos" SET "aplica_proveedor" = true
 WHERE "tipo" = 'egreso' AND "clase" = 'movimiento'
   AND translate(lower("nombre"), 'áéíóúü', 'aeiouu') LIKE '%deposito%';
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cashflow_conceptos" ADD CONSTRAINT "ck_cashflow_conceptos_aplica_proveedor"
    CHECK (NOT "aplica_proveedor" OR ("tipo" = 'egreso' AND "clase" = 'movimiento'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
