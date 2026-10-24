-- 0197 · DESCUENTOS POR DÍA DE LA SEMANA (24/10/2026, pedido del dueño: «un descuento
-- solo los miércoles»). La misma máscara que las ofertas, lunes → domingo; vacía =
-- todos los días, así los descuentos de hoy siguen valiendo como siempre.
ALTER TABLE descuentos ADD COLUMN IF NOT EXISTS dias text NOT NULL DEFAULT '';
