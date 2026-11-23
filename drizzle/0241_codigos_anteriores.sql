-- 23/11/2026: los CÓDIGOS ANTERIORES de un producto. Cuando el fabricante le
-- cambia el código de barras, la mercadería vieja sigue en la góndola con el
-- código viejo: el producto lo conserva acá y la caja, el control de stock, los
-- pedidos y las búsquedas lo siguen encontrando. Cambiar el código en la ficha
-- guarda el anterior solo; desde la ficha se agregan o se sacan a mano.
-- El índice GIN es para el control de «este código ya lo usa otro producto».
ALTER TABLE productos ADD COLUMN IF NOT EXISTS codigos_anteriores text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS ix_productos_codigos_anteriores ON productos USING gin (codigos_anteriores);
