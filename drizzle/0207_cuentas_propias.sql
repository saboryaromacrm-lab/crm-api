-- 0207 · DE QUÉ CUENTA SALIÓ LA TRANSFERENCIA (28/10/2026, pedido del dueño: «tengo varias cuentas
-- digitales, quiero elegir desde dónde sale el dinero»). Las cuentas propias (Mercado Pago, un
-- banco…) se cargan en Gerencia › Cash Flow › Configuración › Mis cuentas. Todo pago por
-- transferencia dice de cuál salió: el pago de un solo medio en `proveedor_pagos`, cada parte de un
-- pago mixto en `pago_formas`. Una cuenta no se borra (tiene pagos detrás): se desactiva.
-- Los pagos de antes quedan sin cuenta («Sin indicar»).
CREATE TABLE cuentas_propias (
  id serial PRIMARY KEY,
  nombre text NOT NULL,
  detalle text NOT NULL DEFAULT '',
  activa boolean NOT NULL DEFAULT true
);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_cuentas_propias_nombre ON cuentas_propias (lower(nombre));
--> statement-breakpoint
ALTER TABLE proveedor_pagos ADD COLUMN cuenta_propia_id integer REFERENCES cuentas_propias(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE pago_formas ADD COLUMN cuenta_propia_id integer REFERENCES cuentas_propias(id) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX ix_proveedor_pagos_cuenta_propia ON proveedor_pagos (cuenta_propia_id) WHERE cuenta_propia_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX ix_pago_formas_cuenta_propia ON pago_formas (cuenta_propia_id) WHERE cuenta_propia_id IS NOT NULL;
