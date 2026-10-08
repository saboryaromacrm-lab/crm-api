-- ===========================================================================
-- 0142 · ALMACÉN › PRODUCTOS SIN MOVIMIENTO: dos índices (7/10/2026)
-- ===========================================================================
-- La pantalla pregunta, por cada producto con stock en cada local, «cuándo se
-- vendió por última vez ACÁ» y «cuándo entró o salió por un pase». Con el
-- índice que había (producto, fecha) cada pregunta recorría los movimientos
-- del producto en TODOS los locales: medido con 2 años simulados (400 mil
-- movimientos, 11 mil renglones de stock), 4 segundos. Con estos dos, cada
-- pregunta es UNA lectura del índice.
--
-- Solo agregan índices: ninguna fila cambia. El de pases es parcial (solo
-- los pases con signo), así que ocupa muy poco.
-- ===========================================================================
CREATE INDEX IF NOT EXISTS "ix_mov_prod_suc_fecha" ON "movimientos" ("producto_id", "sucursal_id", "fecha" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_mov_pases" ON "movimientos" ("producto_id", "sucursal_id", "fecha" DESC) WHERE "tipo" = 'transferencia' AND "signo" <> 0;
