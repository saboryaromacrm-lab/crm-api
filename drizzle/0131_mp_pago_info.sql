-- ===========================================================================
-- 0131 · CON QUÉ PAGÓ EL CLIENTE POR EL QR (3/10/2026)
-- ===========================================================================
-- Pedido del dueño: ver en cada cobro con el QR de Mercado Pago si el cliente
-- pagó con dinero en cuenta, débito o crédito (y en cuántas cuotas), cuánto
-- descontó Mercado Pago y cuánto quedó. Se le pregunta a Mercado Pago al
-- cerrar el cobro (y, para los viejos, de a poco en segundo plano) y se guarda
-- acá. NULL = todavía no se consultó. Nadie cambia de comportamiento.
ALTER TABLE "mp_cobros" ADD COLUMN IF NOT EXISTS "pago_info" jsonb;
