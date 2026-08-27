-- Uso exclusivo de Cafeteria (Coffit): el producto que la distribuidora
-- compra y guarda SOLO para mandarle a la cafeteria. No se vende en el
-- mostrador (el POS lo bloquea y la venta lo revalida); sale unicamente
-- por el envio de Almacen > Cafeteria. Destildar la marca lo vuelve
-- vendible — por eso es un campo de la ficha y no una etiqueta blanda.
ALTER TABLE productos ADD COLUMN IF NOT EXISTS solo_cafeteria boolean NOT NULL DEFAULT false;
