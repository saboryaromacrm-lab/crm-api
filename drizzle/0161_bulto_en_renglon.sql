-- ===========================================================================
-- 0161 · EL BULTO DE CADA RENGLÓN DE COMPRA (12/10/2026)
-- ===========================================================================
-- Pedido del dueño: el comprobante guardado se veía en unidades (56 u. a
-- $2.876,45) y la factura dice bultos (4 × 14 u. a $40.270,25). El renglón
-- guarda ahora el tamaño del bulto CON EL QUE SE CARGÓ (congelado: si el
-- formato cambia mañana, esta compra ya dijo cómo vino). NULL = por unidad o
-- sin dato.
--
-- Los ya cargados se completan con el formato de ese proveedor (el que fija el
-- precio, o el más viejo), solo si las unidades dan bultos ENTEROS: si no,
-- quedan sin dato y se ven en unidades como hasta ahora.
-- ===========================================================================
ALTER TABLE "comprobante_items" ADD COLUMN IF NOT EXISTS "por_bulto" double precision;
--> statement-breakpoint
UPDATE "comprobante_items" ci
   SET "por_bulto" = sub.bulto
  FROM (
    SELECT ci2.id, ci2.cantidad,
           (SELECT pp.cantidad FROM "producto_proveedores" pp
             WHERE pp.producto_id = ci2.producto_id AND pp.proveedor_id = c.proveedor_id
             ORDER BY pp.usar_para_precio DESC, pp.id LIMIT 1) AS bulto
      FROM "comprobante_items" ci2
      JOIN "comprobantes" c ON c.id = ci2.comprobante_id
     WHERE ci2.presentacion_id IS NULL AND ci2.por_bulto IS NULL
  ) sub
 WHERE ci.id = sub.id AND sub.bulto > 1 AND sub.cantidad > 0
   AND abs(sub.cantidad / sub.bulto - round(sub.cantidad / sub.bulto)) < 0.000001;
