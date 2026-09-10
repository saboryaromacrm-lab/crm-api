CREATE INDEX IF NOT EXISTS "ix_mov_prod_fecha" ON "movimientos" USING btree ("producto_id","fecha" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_mov_suc_tipo_fecha" ON "movimientos" USING btree ("sucursal_id","tipo","fecha" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_stock_suc_prod" ON "stock" USING btree ("sucursal_id","producto_id");