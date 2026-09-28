-- ===========================================================================
-- 0115 · LA NOTA DE CRÉDITO DE UN GASTO DESCUENTA DE UN GASTO PUNTUAL (28/9/2026)
-- ===========================================================================
-- Con la 0114 la NC de un gasto ya resta en los totales y en el saldo del
-- proveedor, pero no se podía decir CONTRA QUÉ gasto va: el plomero manda una
-- NC de $200 por la factura de $1.000 y el gasto seguía mostrando $1.000 a
-- pagar. `ref_gasto_id` es ese "contra qué": el saldo del gasto referenciado
-- baja por la NC (igual que la NC de compras baja el saldo de su factura).
-- Opcional: la NC sin referencia sigue siendo un crédito general del proveedor.
-- ===========================================================================

ALTER TABLE "gastos" ADD COLUMN IF NOT EXISTS "ref_gasto_id" integer REFERENCES "gastos"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gastos_ref_gasto_idx" ON "gastos" ("ref_gasto_id");
