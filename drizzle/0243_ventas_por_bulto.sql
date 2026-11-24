-- La venta por bulto cerrado que una factura pasó al bulto nuevo (24/11/2026): para deshacerla al anular.
ALTER TABLE comprobantes ADD COLUMN IF NOT EXISTS ventas_por_bulto jsonb NOT NULL DEFAULT '[]'::jsonb;
