-- LO QUE SE LE PIDIÓ AL PROVEEDOR (19/11/2026, pedido del dueño: «que me muestre
-- lo que pedí en el pedido anterior»). Cada orden de pedido anotada en
-- Proveedores › Pedidos deja sus renglones (producto, cantidad y en qué se pidió:
-- bolsas, bultos, u.), así la próxima orden muestra al lado de cada producto
-- cuánto se pidió la vez anterior. Solo para mirar: no toca stock ni deuda.
CREATE TABLE IF NOT EXISTS "pedidos_proveedor_enviados" (
  "id" serial PRIMARY KEY,
  "proveedor_id" integer NOT NULL REFERENCES "proveedores"("id") ON DELETE CASCADE,
  "pedido_id" integer REFERENCES "pedidos_proveedor"("id") ON DELETE SET NULL,
  "fecha" timestamp with time zone NOT NULL DEFAULT now(),
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "renglones" jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS "ix_pedidos_proveedor_enviados_prov" ON "pedidos_proveedor_enviados" ("proveedor_id", "id");
