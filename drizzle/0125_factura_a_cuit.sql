-- ===========================================================================
-- 0125 · FACTURA A UN CUIT DESDE LA CAJA (30/9/2026)
-- ===========================================================================
-- Pedido del dueño: vendiendo a «Consumidor Final», facturar directo a un CUIT
-- (se busca en el padrón de ARCA) sin salir de la ventana de cobro, y después
-- preguntar si se lo agrega como cliente.
--
-- `ventas.receptor`: los datos del comprador CONGELADOS al emitir. La venta
-- sigue siendo de «Consumidor Final» (si no se lo agrega como cliente), pero
-- la factura, su reimpresión, el QR, la nota de crédito y el reintento de una
-- caída usan estos datos. `null` en todas las ventas de siempre.
--
-- `padron_cuit`: las consultas a ARCA guardadas unos días (mismo CUIT = sin
-- volver a preguntar).
-- ===========================================================================

ALTER TABLE "ventas" ADD COLUMN IF NOT EXISTS "receptor" jsonb;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "padron_cuit" (
  "cuit" text PRIMARY KEY,
  "datos" jsonb NOT NULL,
  "consultado_en" timestamp with time zone NOT NULL DEFAULT now()
);
