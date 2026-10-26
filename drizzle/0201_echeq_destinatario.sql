-- 0201 · ECHEQ A UN NO PROVEEDOR (26/10/2026, pedido del dueño: «hacer un echeq a no proveedor,
-- poniendo el nombre a mano»). El echeq va a un proveedor (como siempre) o a quien diga
-- `destinatario`; uno de los dos, nunca ninguno. Al debitarse, el de un no proveedor solo pasa a
-- cobrado: no hay cuenta corriente donde imputarlo.
ALTER TABLE proveedor_echeqs ALTER COLUMN proveedor_id DROP NOT NULL;
ALTER TABLE proveedor_echeqs ADD COLUMN IF NOT EXISTS destinatario text NOT NULL DEFAULT '';
ALTER TABLE proveedor_echeqs ADD CONSTRAINT ck_echeq_a_quien CHECK (proveedor_id IS NOT NULL OR destinatario <> '');
