-- ===========================================================================
-- 0107 · EL MISMO COMPROBANTE, CON SU LETRA Y SIN LOS ANULADOS (26/9/2026)
-- ===========================================================================
-- El unico de la base era (proveedor, tipo, punto de venta, numero):
--   · sin la LETRA, una factura B chocaba con una A del mismo numero, que es
--     otro papel;
--   · con los ANULADOS adentro, una factura anulada por un error de carga no
--     se podia volver a cargar bien con su mismo numero (0106).
-- ===========================================================================

DROP INDEX IF EXISTS "uq_comprobantes_numero";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_comprobantes_numero"
  ON "comprobantes" ("proveedor_id", "tipo", "letra", "punto_venta", "numero")
  WHERE "numero" IS NOT NULL AND "estado" <> 'anulado';
