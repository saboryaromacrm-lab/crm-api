-- DIFERENCIAS DE ENTREGA (26/11/2026, pedido del dueño: «cuando me llega un pedido y me mandan productos de más
-- o de menos, que lo pueda hacer desde la misma factura y que quede registrado… que todo concuerde»).
-- El stock sigue a lo que LLEGÓ, la cuenta del proveedor a lo que dice EL PAPEL y la diferencia queda
-- pendiente con el proveedor hasta que se resuelve: lo que faltó llega después, viene en una nota de crédito
-- o se da por perdido; lo que vino de más se factura después, se devuelve o queda sin cargo.
--
-- comprobante_items.no_entra: lo facturado en ese renglón que NO entra al stock con este papel (lo que faltó,
-- o lo que ya había entrado antes como «de más» y este papel recién cobra). Entra cantidad − no_entra.
ALTER TABLE comprobante_items ADD COLUMN IF NOT EXISTS no_entra double precision NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS entrega_diferencias (
  id serial PRIMARY KEY,
  comprobante_id integer NOT NULL REFERENCES comprobantes(id) ON DELETE RESTRICT,
  proveedor_id integer NOT NULL REFERENCES proveedores(id) ON DELETE RESTRICT,
  sucursal_id integer NOT NULL REFERENCES sucursales(id) ON DELETE RESTRICT,
  producto_id integer NOT NULL REFERENCES productos(id) ON DELETE RESTRICT,
  presentacion_id integer REFERENCES presentaciones(id) ON DELETE SET NULL,
  tipo text NOT NULL CHECK (tipo IN ('faltante', 'sobrante')),
  cantidad double precision NOT NULL CHECK (cantidad > 0),
  costo_unitario double precision NOT NULL DEFAULT 0,
  estado text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'resuelta', 'anulada')),
  usuario_id integer REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ix_entrega_diferencias_estado ON entrega_diferencias (estado, proveedor_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ix_entrega_diferencias_comprobante ON entrega_diferencias (comprobante_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS entrega_diferencia_resoluciones (
  id serial PRIMARY KEY,
  diferencia_id integer NOT NULL REFERENCES entrega_diferencias(id) ON DELETE CASCADE,
  como text NOT NULL CHECK (como IN ('llego', 'nota_credito', 'perdido', 'facturado', 'devuelto', 'sin_cargo')),
  cantidad double precision NOT NULL CHECK (cantidad > 0),
  comprobante_id integer REFERENCES comprobantes(id) ON DELETE RESTRICT,
  nota text NOT NULL DEFAULT '',
  usuario_id integer REFERENCES usuarios(id) ON DELETE SET NULL,
  fecha timestamptz NOT NULL DEFAULT now(),
  anulado_en timestamptz,
  anulado_por integer REFERENCES usuarios(id) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ix_entrega_resoluciones_diferencia ON entrega_diferencia_resoluciones (diferencia_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ix_entrega_resoluciones_comprobante ON entrega_diferencia_resoluciones (comprobante_id) WHERE comprobante_id IS NOT NULL;
