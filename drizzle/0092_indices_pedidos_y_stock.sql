-- Índices para lo que se consulta en cada autoguardado del pedido y en cada
-- operación de stock (ver los comentarios en schema.ts):
--   · transferencia_items / transferencia_hist por pedido: el borrador se
--     guarda entero cada vez que el cajero deja de tipear, y sin índice eso
--     era recorrer los renglones de todos los pedidos de la historia.
--   · stock por producto: la foto del producto que vuelve en cada operación.
--   · presentaciones por producto: los paquetes al fraccionar y al cotizar.
-- Solo índices: no cambia ningún dato.
CREATE INDEX IF NOT EXISTS "ix_presentaciones_producto" ON "presentaciones" USING btree ("producto_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_stock_prod" ON "stock" USING btree ("producto_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_transferencia_hist_transferencia" ON "transferencia_hist" USING btree ("transferencia_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_transferencia_items_transferencia" ON "transferencia_items" USING btree ("transferencia_id");