-- ===========================================================================
-- 0165 · EL ÚLTIMO PEDIDO DE CADA PROVEEDOR (13/10/2026)
-- ===========================================================================
-- Pedido del dueño: en la orden de pedido (Almacén › Existencias), ver lo que
-- se le pidió la vez anterior a ese proveedor. Se guarda el mensaje tal cual se
-- copió o se mandó por WhatsApp, UNA fila por proveedor: cada pedido pisa al
-- anterior. No toca stock, deuda ni la pizarra de Proveedores › Pedidos.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS "ultimo_pedido_proveedor" (
  "proveedor_id" integer PRIMARY KEY REFERENCES "proveedores"("id") ON DELETE CASCADE,
  "texto" text NOT NULL,
  "fecha" timestamp with time zone NOT NULL DEFAULT now(),
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL
);
