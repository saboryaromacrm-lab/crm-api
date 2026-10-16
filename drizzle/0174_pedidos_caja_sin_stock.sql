-- ===========================================================================
-- 0174 · SIN STOCK EN UN RENGLÓN DEL PEDIDO DE LA CAJA (16/10/2026)
-- ===========================================================================
-- Pedido del dueño: fraccionado marca un producto del pedido como «no hay
-- stock» (no se preparó). La caja lo ve en el momento; «Listo» asienta solo
-- el resto. Se puede desmarcar mientras el pedido siga abierto.
-- ===========================================================================
ALTER TABLE "fraccion_pedido_items" ADD COLUMN IF NOT EXISTS "sin_stock_en" timestamptz;
