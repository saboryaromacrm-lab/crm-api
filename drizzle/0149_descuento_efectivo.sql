-- ===========================================================================
-- 0149 · UN DESCUENTO CON DOS PORCENTAJES: GENERAL Y PAGANDO EN EFECTIVO (8/10/2026)
-- ===========================================================================
-- Pedido del dueño: al crear un descuento, poner a la vez el % para cualquier
-- forma de pago y otro (mayor) para efectivo. El de efectivo es un descuento
-- más, «solo con Efectivo», enlazado al general por `efectivo_de_id`: así lo
-- validan las mismas reglas que ya existen (pago íntegro con ese medio, una por
-- lista, vencimiento, sucursal) y la caja puede pasar de uno al otro al cobrar.
-- Se crea, edita y borra desde el general (descuentos.module en ventas).
-- ===========================================================================
ALTER TABLE "descuentos" ADD COLUMN "efectivo_de_id" integer REFERENCES "descuentos"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_descuentos_efectivo_de" ON "descuentos" ("efectivo_de_id") WHERE "efectivo_de_id" IS NOT NULL;
