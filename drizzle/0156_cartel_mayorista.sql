-- ===========================================================================
-- 0156 · EL TÍTULO DEL CARTEL DE BIENVENIDA (10/10/2026)
-- ===========================================================================
-- Pedido del dueño: el cartel de la tienda abre con «Ahorrá hasta 30% en tu
-- compra comprando por mayor» (y debajo, destacada, la compra mínima). El
-- título es editable en el ERP (Tienda online › Configuración del sitio): se
-- cambia SOLO si todavía tiene el texto original; uno ya personalizado no se toca.
-- ===========================================================================
UPDATE "configuracion"
SET "valor" = jsonb_set("valor", '{popupTitulo}', '"Ahorrá hasta 30% en tu compra comprando por mayor"')
WHERE "clave" = 'web' AND "valor"->>'popupTitulo' = 'Sabor y Aroma mayorista, ahora online';
