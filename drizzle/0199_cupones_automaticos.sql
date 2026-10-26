-- 0199 · DESCUENTOS AUTOMÁTICOS DE LA TIENDA (25/10/2026, pedido del dueño: «5 % pagando en
-- efectivo en toda la tienda, bien incentivado en el checkout»). Es un cupón que no pide
-- código: el checkout lo aplica solo cuando se cumplen sus condiciones (el medio de pago,
-- casi siempre). Así hereda todo lo del cupón (0190): queda en el pedido y en la venta,
-- la caja exige el medio al cobrar y Métricas, Resultados y la pantalla de cupones lo miden.
ALTER TABLE cupones ADD COLUMN IF NOT EXISTS automatico boolean NOT NULL DEFAULT false;
