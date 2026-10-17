-- ===========================================================================
-- 0177 · CUENTAS DISPONIBLES: «PUEDE PASARSE DEL MONTO» (17/10/2026)
-- ===========================================================================
-- Pedido del dueño: en algunas cuentas no importa pasarse del importe a
-- cubrir. Con el tilde, la cuenta acepta un pago aunque supere lo que falta;
-- ese pago la cierra (queda cubierta) y lo de más queda a favor en la cuenta
-- corriente del proveedor (el espejo en `proveedor_pagos` es por el total).
-- Sin el tilde, todo sigue igual: nunca de más. Por cuenta, apagado.
-- ===========================================================================
ALTER TABLE cuentas_disponibles ADD COLUMN puede_pasarse boolean NOT NULL DEFAULT false;
