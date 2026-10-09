-- ===========================================================================
-- 0150 · QUÉ SUCURSALES VENDEN MAYORISTA (8/10/2026)
-- ===========================================================================
-- Pedido del dueño: no todas las sucursales trabajan la venta mayorista. Con
-- el interruptor apagado, esa sucursal cobra todo a precio minorista: la caja
-- no ofrece el aviso, el bulto ni las listas mayoristas, y el servidor rechaza
-- un renglón a lista mayorista ahí (ventas.module). Arrancan todas en «sí»:
-- nada cambia hasta que el dueño lo apague en Gerencia › Sucursales.
-- ===========================================================================
ALTER TABLE "sucursales" ADD COLUMN "vende_mayorista" boolean NOT NULL DEFAULT true;
