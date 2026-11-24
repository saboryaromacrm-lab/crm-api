-- Los fletes de mercadería (24/11/2026): el transporte que trae mercadería de otros proveedores.
-- La regla vive en la ficha del transporte; cada renglón de su factura dice de quién trajo
-- (y de qué factura o remito) o que fue otra cosa.
ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS trae_mercaderia boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE gasto_items ADD COLUMN IF NOT EXISTS flete_origen text CHECK (flete_origen IN ('proveedor', 'otro'));
--> statement-breakpoint
ALTER TABLE gasto_items ADD COLUMN IF NOT EXISTS flete_proveedor_id integer REFERENCES proveedores(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE gasto_items ADD COLUMN IF NOT EXISTS flete_comprobante_id integer REFERENCES comprobantes(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE gasto_items ADD COLUMN IF NOT EXISTS flete_referencia text NOT NULL DEFAULT '';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ix_gasto_items_flete_proveedor ON gasto_items (flete_proveedor_id) WHERE flete_origen = 'proveedor';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ix_gasto_items_flete_comprobante ON gasto_items (flete_comprobante_id) WHERE flete_comprobante_id IS NOT NULL;
