-- ===========================================================================
-- 0181 · RECORDATORIOS DEL PROVEEDOR EN LA ORDEN DE PEDIDO (19/10/2026)
-- ===========================================================================
-- Una nota por proveedor, siempre a la vista cuando se le arma el pedido
-- («mínimo 3 bultos», «no manda los martes»), con quién y cuándo la cambió.
ALTER TABLE proveedores ADD COLUMN nota_pedido text NOT NULL DEFAULT '';
ALTER TABLE proveedores ADD COLUMN nota_pedido_en timestamp with time zone;
ALTER TABLE proveedores ADD COLUMN nota_pedido_por integer REFERENCES usuarios(id) ON DELETE SET NULL;
