-- ===========================================================================
-- 0106 · ANULAR UN COMPROBANTE DE COMPRA (26/9/2026, QA de Compras)
-- ===========================================================================
-- Una factura cargada no se podia anular ni editar: un error de carga dejaba
-- para siempre el stock sumado, la deuda, el costo cambiado y las cuotas.
-- La anulacion deshace todo eso en una transaccion y deja el rastro: quien,
-- cuando y por que. El comprobante no se borra: queda "anulado", con su papel.
-- ===========================================================================

ALTER TABLE "comprobantes" ADD COLUMN IF NOT EXISTS "anulado_en" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "comprobantes" ADD COLUMN IF NOT EXISTS "anulado_por" integer REFERENCES "usuarios"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "comprobantes" ADD COLUMN IF NOT EXISTS "motivo_anulacion" text NOT NULL DEFAULT '';
