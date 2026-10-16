-- ===========================================================================
-- 0171 · CANCELAR UN PEDIDO DE LA CAJA A FRACCIONADO (16/10/2026)
-- ===========================================================================
-- Pedido del dueño: el cajero cancela el pedido entero o un renglón mientras
-- no esté cerrado. Nada se borra: el renglón queda con `cancelado_en` y el
-- pedido sin renglones vivos pasa a `cancelado` (hecho_en/hecho_por = quién y
-- cuándo). «Listo» registra solo los renglones vivos.
-- ===========================================================================
ALTER TABLE "fraccion_pedidos" DROP CONSTRAINT IF EXISTS "fraccion_pedidos_estado_check";
--> statement-breakpoint
ALTER TABLE "fraccion_pedidos" ADD CONSTRAINT "fraccion_pedidos_estado_check" CHECK ("estado" IN ('pendiente', 'armando', 'hecho', 'rechazado', 'cancelado'));
--> statement-breakpoint
ALTER TABLE "fraccion_pedido_items" ADD COLUMN IF NOT EXISTS "cancelado_en" timestamptz;
