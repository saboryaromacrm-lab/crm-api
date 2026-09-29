-- ===========================================================================
-- 0119 · QUÉ ES DE COFFIT SE DECIDE EN LA FACTURA, RENGLÓN POR RENGLÓN (29/9/2026)
-- ===========================================================================
-- Pedido del dueño: al cargar una factura de compra poder decir «toda esta
-- factura es de Coffit» o tildar renglones sueltos, además de la marca de la
-- ficha («uso exclusivo de Coffit», que sigue mandando y no se puede destildar).
--
-- Un artículo COMPARTIDO (leche, azúcar) comprado para Coffit ya le cargó el
-- costo al café en la factura. Cuando después viaja en un envío, ese envío no
-- se lo puede volver a cobrar: la parte del envío que sale de lo ya pagado por
-- Coffit se guarda en `cantidad_exclusiva` (en la unidad del renglón). Hasta
-- hoy la marca era todo o nada (`exclusivo`), así que los envíos viejos quedan
-- igual: exclusivo = todo el renglón, no exclusivo = nada.
-- ===========================================================================

ALTER TABLE "envio_cafeteria_items" ADD COLUMN IF NOT EXISTS "cantidad_exclusiva" double precision NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE "envio_cafeteria_items" SET "cantidad_exclusiva" = "cantidad" WHERE "exclusivo" AND "cantidad_exclusiva" = 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_comprobante_items_cafe" ON "comprobante_items" ("producto_id") WHERE "para_cafeteria";
