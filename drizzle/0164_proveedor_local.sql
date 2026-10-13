-- ===========================================================================
-- 0164 · PROVEEDOR LOCAL (13/10/2026)
-- ===========================================================================
-- Pedido del dueño: marcar en la ficha a los proveedores de la misma localidad
-- que el negocio, para filtrar por ellos (Proveedores, Pedidos, Productos,
-- Existencias, Bajos en stock). Es solo una marca: no cambia costos, cuentas
-- ni stock. Todos arrancan sin marcar.
-- ===========================================================================
ALTER TABLE "proveedores" ADD COLUMN IF NOT EXISTS "es_local" boolean NOT NULL DEFAULT false;
