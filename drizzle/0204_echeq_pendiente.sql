-- 0204 · EL ECHEQ AUTOMÁTICO NACE «PENDIENTE DE CONFIRMAR» (27/10/2026, pedido del dueño: «muchas
-- veces difiere o no lo creo al echeq, y me da como mercadería pagada en el sistema»).
-- El que nace con la factura del proveedor que cobra con echeq ya no figura como emitido: espera
-- que el dueño lo confirme con sus datos reales (número, banco, fecha, importe) o diga que no lo
-- hizo, y entonces la deuda vuelve a Cuentas corrientes. Mientras está pendiente no se cobra ni
-- cuenta como plata que se va a debitar.
--
-- El tipo se REARMA en vez de `ALTER TYPE … ADD VALUE`: drizzle corre todas las migraciones en una
-- sola transacción, y en el PostgreSQL 16 del servidor un valor agregado así no se puede usar hasta
-- confirmarla (ver 0046). El UPDATE de abajo lo usa; con un tipo creado en la misma transacción no
-- hay ese límite.
CREATE TYPE estado_echeq_nuevo AS ENUM ('pendiente', 'emitido', 'entregado', 'cobrado', 'anulado');
--> statement-breakpoint
ALTER TABLE proveedor_echeqs ALTER COLUMN estado DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE proveedor_echeqs ALTER COLUMN estado TYPE estado_echeq_nuevo USING estado::text::estado_echeq_nuevo;
--> statement-breakpoint
ALTER TABLE proveedor_echeqs ALTER COLUMN estado SET DEFAULT 'emitido';
--> statement-breakpoint
DROP TYPE estado_echeq;
--> statement-breakpoint
ALTER TYPE estado_echeq_nuevo RENAME TO estado_echeq;
--> statement-breakpoint
-- Los automáticos que nadie completó todavía: el número «PEND-…» es la marca de que el papel real
-- no se cargó. Pasan a pendientes para revisarlos uno por uno.
UPDATE proveedor_echeqs SET estado = 'pendiente'
WHERE estado = 'emitido' AND numero LIKE 'PEND-%' AND compromiso_id IS NOT NULL;
