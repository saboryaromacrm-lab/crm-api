-- ===========================================================================
-- 0143 · SUCURSALES QUE SE DESACTIVAN (8/10/2026, pedido del dueño)
-- ===========================================================================
-- Un local que cerró no se puede BORRAR: tiene ventas, cajas, facturas y
-- movimientos con su nombre, y el historial no se pierde. Se DESACTIVA: deja
-- de aparecer en todo lo que ofrece elegir un local (el ingreso, el selector de
-- arriba, Almacén, Compras, Gastos, Métricas, Cash Flow…) y nadie puede operar
-- en él; el historial lo sigue nombrando. Se puede reactivar.
-- ===========================================================================
ALTER TABLE "sucursales" ADD COLUMN IF NOT EXISTS "activa" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "sucursales" ADD COLUMN IF NOT EXISTS "desactivada_en" timestamp with time zone;
