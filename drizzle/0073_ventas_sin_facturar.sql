-- ARCA CAÍDO ≠ VENTA CAÍDA (0073)
-- ============================================================================
-- Si el cajero pide factura y ARCA no contesta, la venta se confirma igual
-- como ticket provisorio (el cliente está parado enfrente) y queda PENDIENTE
-- de emitir el comprobante fiscal. La pestaña "Sin facturar" del listado y el
-- botón "Facturar ahora" viven de estas dos columnas.

ALTER TABLE "ventas" ADD COLUMN "facturar_pendiente" boolean DEFAULT false NOT NULL;
ALTER TABLE "ventas" ADD COLUMN "facturar_motivo" text DEFAULT '' NOT NULL;

-- Parcial: la pestaña pregunta "¿cuáles quedaron?" todo el tiempo, y la
-- respuesta normal es "ninguna" — el índice solo guarda las excepciones.
CREATE INDEX "ix_ventas_facturar_pendiente" ON "ventas" ("id") WHERE "facturar_pendiente";
