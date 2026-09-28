-- ===========================================================================
-- 0108 · EL BULTO ENTRA AL HISTORIAL DE COSTOS (26/9/2026)
-- ===========================================================================
-- La factura cambiaba el tamaño del bulto del formato de compra (kg o
-- unidades) con un UPDATE directo, sin dejar rastro. Un error de tipeo (bulto
-- 1 en vez de 10) multiplicaba el costo por unidad y la gondola al instante, y
-- anular la factura no lo deshacia: el lote solo sabia de costo, descuento y
-- flete. Nulo = esa fila no toco el bulto (las viejas, y los cambios sin bulto).
-- ===========================================================================

ALTER TABLE "producto_proveedor_costos" ADD COLUMN IF NOT EXISTS "cantidad_anterior" double precision;
--> statement-breakpoint
ALTER TABLE "producto_proveedor_costos" ADD COLUMN IF NOT EXISTS "cantidad" double precision;
--> statement-breakpoint
-- Y el "precio final" del bulto (formatos en modo final): la factura lo
-- actualiza desde el 26/9/2026 y el lote lo tiene que poder deshacer igual.
ALTER TABLE "producto_proveedor_costos" ADD COLUMN IF NOT EXISTS "costo_final_anterior" double precision;
--> statement-breakpoint
ALTER TABLE "producto_proveedor_costos" ADD COLUMN IF NOT EXISTS "costo_final" double precision;
