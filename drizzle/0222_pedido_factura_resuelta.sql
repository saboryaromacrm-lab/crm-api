-- ===========================================================================
-- 0222 · MERCADERÍA RECIBIDA SIN SU FACTURA (7/11/2026, pedido del dueño)
-- ===========================================================================
-- «Avisá a admin y superadmin cuando llega mercadería de un proveedor —tomalo
-- de la tarjeta de pedidos— y no se cargó su factura, así sabemos qué facturas
-- faltan cargar.» El aviso se calcula (tarjeta en «Recibido» sin comprobante
-- del proveedor desde que se pidió); esto guarda solo cuando administración
-- lo da por resuelto a mano (la tarjeta se movió por error, la factura se cargó
-- mucho antes…), con quién y cuándo, para que deje de avisar.
-- ===========================================================================
ALTER TABLE "pedidos_proveedor" ADD COLUMN IF NOT EXISTS "factura_resuelta_en" timestamptz;
ALTER TABLE "pedidos_proveedor" ADD COLUMN IF NOT EXISTS "factura_resuelta_por" integer REFERENCES "usuarios"("id") ON DELETE SET NULL;
