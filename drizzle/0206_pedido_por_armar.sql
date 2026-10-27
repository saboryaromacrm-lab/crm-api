-- 0206 · EL PEDIDO SE FRACCIONA AL CARGAR LO ARMADO (28/10/2026, pedido del dueño: «primero
-- cargar lo armado y después confirmar»). Confirmar un pedido ya no fracciona: los paquetes que
-- faltan armar quedan reservados como GRANEL y se fraccionan al cargar lo armado, por lo que se
-- armó de verdad. Antes, si al armar faltaba algo, quedaba un fraccionado que nunca pasó.
-- `por_armar`: cuántos paquetes del renglón siguen reservados como granel.
ALTER TABLE presupuesto_items ADD COLUMN por_armar integer NOT NULL DEFAULT 0;
