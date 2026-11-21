-- 21/11/2026: el rubro de gastos de cada proveedor. «Cargar gasto» lo elige
-- solo al elegir el proveedor (como la letra que factura, 0067); si no tiene,
-- se elige y se puede dejar fijado desde el mismo formulario.
ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS rubro_gasto_id integer REFERENCES gasto_categorias(id) ON DELETE SET NULL;
