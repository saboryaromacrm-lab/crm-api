-- MERCADERÍA SIN FACTURA (0072)
-- ============================================================================
-- El producto comprado en liquidación (total o parcial) no puede trasladar al
-- cliente un IVA que nunca se pagó. El % parte el costo en dos: el REAL (valúa
-- stock y pérdidas) y la BASE DEL PRECIO, con la parte sin factura despojada
-- del IVA que el negocio absorbe al vender. Ver costosFormato() en pricing.ts.

-- En el formato de compra: el dato que manda.
ALTER TABLE "producto_proveedores" ADD COLUMN "porc_sin_factura" double precision DEFAULT 0 NOT NULL;

-- En el proveedor: el default que precarga los formatos nuevos.
ALTER TABLE "proveedores" ADD COLUMN "porc_sin_factura" double precision DEFAULT 0 NOT NULL;

-- El costo CONGELADO al vender: sin él no hay margen medible (el costo de hoy
-- no es el de la venta de marzo). NULL = renglón anterior a esta migración,
-- "sin dato" — que no es lo mismo que "costó cero".
ALTER TABLE "venta_items" ADD COLUMN "costo_unitario" double precision;
ALTER TABLE "venta_items" ADD COLUMN "iva_absorbido_unitario" double precision;
ALTER TABLE "venta_items" ADD COLUMN "porc_sin_factura" double precision;
