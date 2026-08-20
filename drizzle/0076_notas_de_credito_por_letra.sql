-- NOTAS DE CRÉDITO POR LETRA (0076)
-- ============================================================================
-- ARCA no tiene "nota de crédito" a secas: tiene una por letra, con su propio
-- código y su propia numeración correlativa —3 (A), 8 (B), 13 (C)— y la letra
-- tiene que ser la MISMA que la del comprobante que ajusta. Con un solo valor
-- genérico no se puede saber cuál emitir.
--
-- Se agregan también las notas de débito por letra: recrear el enum es la
-- parte cara, y hacerlo dos veces sería peor.
--
-- POR QUÉ SE RECREA EL TIPO Y NO SE USA `ALTER TYPE ... ADD VALUE`:
-- las migraciones de este proyecto corren TODAS dentro de una sola
-- transacción, y Postgres no deja usar un valor de enum recién agregado en la
-- misma transacción que lo agregó. La migración pasaría, y la primera vez que
-- alguien intentara guardar el valor nuevo fallaría. Ya nos pasó con el enum
-- de transferencias.
--
-- Los valores genéricos `nota_credito` y `nota_debito` se van: no hay una sola
-- fila que los use (verificado antes de escribir esto) y dejarlos sería
-- ofrecer un tipo que no se puede emitir.

ALTER TABLE "ventas" ALTER COLUMN "tipo" DROP DEFAULT;

ALTER TYPE "tipo_venta" RENAME TO "tipo_venta_old";

CREATE TYPE "tipo_venta" AS ENUM (
  'ticket',
  'factura_a', 'factura_b', 'factura_c',
  'nota_credito_a', 'nota_credito_b', 'nota_credito_c',
  'nota_debito_a', 'nota_debito_b', 'nota_debito_c'
);

ALTER TABLE "ventas"
  ALTER COLUMN "tipo" TYPE "tipo_venta" USING "tipo"::text::"tipo_venta";

ALTER TABLE "ventas" ALTER COLUMN "tipo" SET DEFAULT 'ticket';

DROP TYPE "tipo_venta_old";

-- La nota de crédito apunta a la venta que ajusta. La columna ya existía
-- (`ref_venta_id`) pero sin índice, y el detalle de una venta necesita
-- preguntar "¿esta venta tiene notas de crédito?" cada vez que se abre.
CREATE INDEX IF NOT EXISTS "ix_ventas_ref_venta" ON "ventas" ("ref_venta_id")
  WHERE "ref_venta_id" IS NOT NULL;
