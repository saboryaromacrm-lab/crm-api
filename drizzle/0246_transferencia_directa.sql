-- La transferencia que un cliente le hizo DIRECTO a un proveedor, sin cuenta disponible (25/11/2026).
-- Se carga desde Ventas › Conciliación MP o el detalle de la venta: el renglón «Transferencia» pasa a
-- «Transf. a proveedor» y el pago al proveedor queda atado a ese renglón (muere con la venta).
ALTER TABLE proveedor_pagos ADD COLUMN IF NOT EXISTS venta_pago_id integer REFERENCES venta_pagos(id) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_proveedor_pagos_venta_pago ON proveedor_pagos (venta_pago_id) WHERE venta_pago_id IS NOT NULL AND estado = 'activo';
