-- ===========================================================================
-- 0172 · LO CANCELADO QUE YA ESTABA ARMADO (16/10/2026)
-- ===========================================================================
-- Pedido del dueño: fraccionado pudo haberlo armado antes de que la caja lo
-- cancelara. Un pedido cancelado mientras se armaba queda en el aviso hasta
-- que fraccionado decide: asienta lo que armó (entra al stock, sin venta) o
-- «no armé nada». `cancelacion_resuelta_en` = cuándo decidió.
-- ===========================================================================
ALTER TABLE "fraccion_pedidos" ADD COLUMN IF NOT EXISTS "cancelacion_resuelta_en" timestamptz;
