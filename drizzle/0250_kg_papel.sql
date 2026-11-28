-- LOS KG DEL PAPEL EN EL RENGLÓN AL PESO (28/11/2026, pedido del dueño). La horma de Danbo
-- se da de alta por unidad («Horma 3.5k») pero La Serenísima la cobra en kilos y cada horma
-- pesa distinto (14,97 kg en 4 hormas = 3,74 kg c/u). Coffit costea el queso por kilo: con
-- los 3,5 kg del nombre el kilo le daba 7 % más caro. Ahora el renglón guarda los kg reales.
ALTER TABLE comprobante_items ADD COLUMN IF NOT EXISTS kg_papel double precision;
