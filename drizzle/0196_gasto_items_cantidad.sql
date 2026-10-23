-- ===========================================================================
-- 0196 · CANTIDAD EN LOS RENGLONES DEL GASTO (23/10/2026)
-- ===========================================================================
-- Pedido del dueño: «compro descartables y quiero ver cuánto me sale por
-- unidad una bandeja». La cantidad es OPCIONAL (NULL = el renglón no se
-- cuenta por unidades, como la luz). El monto sigue siendo el del renglón tal
-- como figura en el papel: el precio por unidad se calcula (monto / cantidad),
-- no se guarda, así nunca puede contradecir al monto.
-- ===========================================================================
ALTER TABLE gasto_items ADD COLUMN cantidad double precision
	CHECK (cantidad IS NULL OR cantidad > 0);
