-- "¿Qué notas ajustan a esta factura?" se pregunta una vez por imputación (para
-- saber el saldo real antes de aceptar un pago) y otra por cada apertura de la
-- bandeja de pagos. Sin este índice cada una era un scan de `comprobantes`
-- entera, y justo en el camino de pagar.
--
-- Parcial: la enorme mayoría de los comprobantes no referencia a nadie, así que
-- el índice se queda solo con las notas.
CREATE INDEX IF NOT EXISTS "ix_comprobantes_ref"
  ON "comprobantes" ("ref_comprobante_id")
  WHERE "ref_comprobante_id" IS NOT NULL;
