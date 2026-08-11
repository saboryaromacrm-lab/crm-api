-- ============================================================================
-- EL PEDIDO SE ARMA DURANTE EL DÍA: ESTADO `borrador`
-- ============================================================================
-- Cómo se usa de verdad: el cajero atiende, y entre cliente y cliente agrega
-- dos renglones al pedido. No lo arma de una sentada. Hasta acá el pedido
-- nacía ya `pendiente` —o sea, demanda visible para el origen— así que la
-- única forma de armarlo de a poco era dejar el modal abierto todo el día.
--
-- `borrador` es el pedido que TODAVÍA NO SE MANDÓ:
--   * no toca stock (igual que `pendiente`);
--   * NO le aparece al origen en su bandeja de envíos: nadie tiene que
--     preparar algo que el que pide sigue escribiendo;
--   * no lleva código: la serie TR se asigna al enviarlo, así el listado no
--     muestra un TR0012 que quizá nunca exista.
--
-- POR QUÉ SE RECONSTRUYE EL TIPO EN VEZ DE UN `ADD VALUE`
-- -------------------------------------------------------
-- `ALTER TYPE ... ADD VALUE` es una línea, pero el valor agregado NO se puede
-- usar hasta que la transacción que lo creó haga commit ("los nuevos valores
-- de enum deben estar comprometidos antes de que puedan usarse"). Y
-- `drizzle-kit migrate` corre TODAS las migraciones pendientes dentro de UNA
-- transacción: partirlo en dos archivos no cambia nada, el índice parcial de
-- la 0056 que nombra 'borrador' falla igual.
--
-- Recrear el tipo sí funciona, porque un enum CREADO en la transacción se
-- puede usar en esa misma transacción. Queda reproducible: una base nueva
-- corre todo de una y llega al mismo lugar.
--
-- Dos columnas usan el tipo: transferencias.estado y transferencia_hist.estado.
-- El USING pasa por texto, así que los valores existentes se conservan tal
-- cual; el orden nuevo pone 'borrador' primero para que siga el del circuito
-- (es lo que usan los ORDER BY por estado).
ALTER TYPE "estado_transferencia" RENAME TO "estado_transferencia_viejo";
--> statement-breakpoint
CREATE TYPE "estado_transferencia" AS ENUM (
  'borrador', 'pendiente', 'preparada', 'transito', 'recibida', 'cancelada'
);
--> statement-breakpoint
ALTER TABLE "transferencias" ALTER COLUMN "estado" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "transferencias"
  ALTER COLUMN "estado" TYPE "estado_transferencia"
  USING "estado"::text::"estado_transferencia";
--> statement-breakpoint
ALTER TABLE "transferencia_hist"
  ALTER COLUMN "estado" TYPE "estado_transferencia"
  USING "estado"::text::"estado_transferencia";
--> statement-breakpoint
ALTER TABLE "transferencias" ALTER COLUMN "estado" SET DEFAULT 'pendiente';
--> statement-breakpoint
DROP TYPE "estado_transferencia_viejo";
