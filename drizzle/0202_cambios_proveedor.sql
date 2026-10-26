-- 0202 · CAMBIOS DE MERCADERÍA CON EL PROVEEDOR (26/10/2026, pedido del dueño: «el proveedor me
-- reconoce vencidos: se los entrego y después me repone, a veces otro producto o sabor, o en otro
-- envío»). Lo mandado sale del stock (tipo `cambio_proveedor`, no es pérdida) y queda lo que te
-- debe a costo; lo que repone entra y lo descuenta. Se completa cuando lo repuesto alcanza lo mandado.
-- Un envío por error se anula (sin nada repuesto): queda quién y cuándo.
ALTER TYPE tipo_movimiento ADD VALUE IF NOT EXISTS 'cambio_proveedor';
CREATE TABLE IF NOT EXISTS proveedor_reposiciones (
  id serial PRIMARY KEY,
  proveedor_id integer NOT NULL REFERENCES proveedores(id) ON DELETE RESTRICT,
  sucursal_id integer NOT NULL REFERENCES sucursales(id) ON DELETE RESTRICT,
  estado text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'completo', 'anulado')),
  nota text NOT NULL DEFAULT '',
  usuario_id integer REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en timestamptz NOT NULL DEFAULT now(),
  completado_en timestamptz,
  anulado_en timestamptz,
  anulado_por integer REFERENCES usuarios(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS ix_reposiciones_estado ON proveedor_reposiciones (estado, proveedor_id);
CREATE TABLE IF NOT EXISTS proveedor_reposicion_items (
  id serial PRIMARY KEY,
  reposicion_id integer NOT NULL REFERENCES proveedor_reposiciones(id) ON DELETE CASCADE,
  sentido text NOT NULL CHECK (sentido IN ('envio', 'recepcion')),
  producto_id integer NOT NULL REFERENCES productos(id) ON DELETE RESTRICT,
  presentacion_id integer REFERENCES presentaciones(id) ON DELETE SET NULL,
  cantidad double precision NOT NULL CHECK (cantidad > 0),
  costo_unitario double precision NOT NULL DEFAULT 0,
  fecha timestamptz NOT NULL DEFAULT now(),
  usuario_id integer REFERENCES usuarios(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS ix_reposicion_items_reposicion ON proveedor_reposicion_items (reposicion_id);
