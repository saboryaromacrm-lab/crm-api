-- ===========================================================================
-- 0112 · COSTO DEL CAFÉ EN LA FICHA, DESDE SUS ENVÍOS (26/9/2026)
-- ===========================================================================
-- Desde esta versión la venta, el stock y las pérdidas toman el costo de lo
-- que elabora la cafetería de su FICHA (`productos.costo_cafeteria`), y ya no
-- salen en $0 por no tener proveedor.
--
-- Una ficha que NUNCA se declaró se llena con el costo del último envío vivo
-- de la cafetería (renglón suelto, sin presentación), con la FECHA DE ESE
-- ENVÍO: así "actualizado hace X" dice la verdad y no "hoy".
--
-- Las fichas ya declaradas NO se tocan. Las ventas ya hechas tampoco: su costo
-- quedó congelado cuando se vendieron.
-- ===========================================================================

UPDATE "productos" AS p
SET "costo_cafeteria" = u."costo_unitario",
    "costo_cafeteria_actualizado" = u."fecha"
FROM (
  SELECT DISTINCT ON (i."producto_id") i."producto_id", i."costo_unitario", e."fecha"
  FROM "envio_cafeteria_items" i
  JOIN "envios_cafeteria" e ON e."id" = i."envio_id"
  WHERE e."sentido" = 'entrada' AND e."estado" = 'enviado' AND i."presentacion_id" IS NULL
  ORDER BY i."producto_id", e."id" DESC, i."id" DESC
) AS u
WHERE p."id" = u."producto_id"
  AND p."origen_cafeteria" = true
  AND p."costo_cafeteria_actualizado" IS NULL;
