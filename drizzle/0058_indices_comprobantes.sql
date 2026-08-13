-- ============================================================================
-- LOS TRES ÍNDICES QUE FALTABAN EN EL CIRCUITO DE COMPRAS
-- ============================================================================
-- Salieron de la pasada del depurador sobre Compras. Los tres están en el
-- camino que se recorre cada vez que alguien abre Facturación o le paga a un
-- proveedor, y los tres son la excepción en un esquema donde el resto de las
-- tablas hijas sí tienen el suyo (`venta_items`, `cobranza_pagos`,
-- `presupuesto_items`).
--
-- 1 y 2 · LAS DOS TABLAS HIJAS DEL COMPROBANTE no declaraban NINGÚN índice, y
--         las dos se consultan por `comprobante_id` con un `inArray` en cada
--         listado y en cada detalle. Sin índice, cada apertura de la pantalla
--         es un scan completo de las dos tablas.
--
-- 3 · POR `proveedor_id` NO HABÍA NINGÚN ÍNDICE USABLE, aunque parezca que sí.
--     El único que lo lleva como primera columna es `uq_comprobantes_numero`,
--     que es PARCIAL (`where numero is not null`): un `where proveedor_id = X`
--     no implica ese predicado, así que Postgres no puede usarlo. Y por
--     proveedor filtran el listado, la cuenta corriente, las facturas que una
--     nota puede ajustar y las dos consultas de la bandeja de pago — o sea,
--     todo el circuito de pagarle a alguien.
--
--     Va con `estado` de segunda porque casi todas esas consultas descartan las
--     anuladas, así que el índice contesta las dos condiciones de una.
CREATE INDEX IF NOT EXISTS "ix_comprobante_items_comprobante"
  ON "comprobante_items" ("comprobante_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "ix_comprobante_percepciones_comprobante"
  ON "comprobante_percepciones" ("comprobante_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "ix_comprobantes_proveedor"
  ON "comprobantes" ("proveedor_id", "estado");
