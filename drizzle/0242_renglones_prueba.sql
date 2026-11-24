-- Los renglones de prueba de una factura (24/11/2026): suman al total, no son productos.
ALTER TABLE comprobantes ADD COLUMN IF NOT EXISTS renglones_prueba jsonb NOT NULL DEFAULT '[]'::jsonb;
