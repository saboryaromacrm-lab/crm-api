-- 0215 · OTRA CUENTA, ESCRITA A MANO (3/11/2026, pedido del dueño: «permitime colocar una cuenta
-- manual, por ejemplo desde la cuenta de mi hermano, y que quede asentado»). Una transferencia que
-- no salió de ninguna de Mis cuentas dice de dónde salió con un texto libre, sin crear una cuenta.
-- Es una cosa o la otra: o una cuenta de Mis cuentas, o la escrita a mano.
ALTER TABLE proveedor_pagos ADD COLUMN cuenta_a_mano text;
--> statement-breakpoint
ALTER TABLE proveedor_pagos ADD CONSTRAINT ck_proveedor_pagos_cuenta_a_mano
  CHECK (cuenta_a_mano IS NULL OR (cuenta_propia_id IS NULL AND char_length(cuenta_a_mano) BETWEEN 2 AND 80));
--> statement-breakpoint
ALTER TABLE pago_formas ADD COLUMN cuenta_a_mano text;
--> statement-breakpoint
ALTER TABLE pago_formas ADD CONSTRAINT ck_pago_formas_cuenta_a_mano
  CHECK (cuenta_a_mano IS NULL OR (cuenta_propia_id IS NULL AND char_length(cuenta_a_mano) BETWEEN 2 AND 80));
