-- ===========================================================================
-- 0168 · CUENTAS DISPONIBLES: SOLO PARA VENTAS DESDE UN TOTAL (15/10/2026)
-- ===========================================================================
-- Pedido del dueño: una cuenta que se ofrezca en la caja solo en ventas (o
-- recibos) desde cierto total, p. ej. $50.000. 0 = sin piso (como hasta hoy).
-- ===========================================================================
ALTER TABLE "cuentas_disponibles" ADD COLUMN IF NOT EXISTS "venta_minima" double precision NOT NULL DEFAULT 0;
