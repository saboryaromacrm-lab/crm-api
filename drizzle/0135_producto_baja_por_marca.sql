-- ===========================================================================
-- 0135 · INHABILITAR UNA MARCA INHABILITA SUS PRODUCTOS (4/10/2026)
-- ===========================================================================
-- Pedido del dueño: en Catálogos › Marcas, inhabilitar una marca deja todos
-- sus productos fuera: los que tienen stock pasan a «discontinuado» (no se
-- compran más, se venden hasta agotar) y los que no tienen, a «archivado».
-- Esta marca recuerda CUÁLES cambió la marca, para que al habilitarla de nuevo
-- vuelvan a «activo» solo esos (no los que ya estaban dados de baja antes).
ALTER TABLE "productos" ADD COLUMN IF NOT EXISTS "baja_por_marca" boolean NOT NULL DEFAULT false;
