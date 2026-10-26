-- 0203 · EL DISPLAY DENTRO DEL BULTO (26/10/2026, pedido del dueño: «compro un bulto de barritas,
-- adentro vienen displays y cada display trae sus barritas»). Optativo, solo para los enteros.
-- El costo sigue siendo del BULTO y el unitario sale de `cantidad`: el display no cambia la cuenta
-- del precio. `por_display` = unidades que trae UN display (lo estable: la caja puede traer más o
-- menos displays); los displays por bulto se derivan (cantidad ÷ por_display) y valen si dan justo.
ALTER TABLE producto_proveedores ADD COLUMN IF NOT EXISTS por_display double precision;
-- El renglón de compra cargado POR DISPLAY: con cuántas unidades por display (como `por_bulto`, 0161).
ALTER TABLE comprobante_items ADD COLUMN IF NOT EXISTS por_display double precision;
