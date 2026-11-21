-- AVISO DE CUENTA DISPONIBLE COMPLETA (0238, 20/11/2026, pedido del dueño:
-- «cuando se completa el pago a un proveedor en Cuentas disponibles, que me
-- salga un banner de aviso al admin y superadmin»).
-- completa_en: cuándo quedó cubierta (lo pone el servidor con el pago que la
-- cierra; vuelve a NULL si se reabre). Las ya cubiertas antes de esto quedan
-- en NULL a propósito: el aviso es de acá en adelante.
ALTER TABLE "cuentas_disponibles" ADD COLUMN IF NOT EXISTS "completa_en" timestamptz;

-- Quién ya lo vio («Entendido»): cada admin el suyo.
CREATE TABLE IF NOT EXISTS "cuenta_disponible_avisos" (
  "cuenta_id" integer NOT NULL REFERENCES "cuentas_disponibles"("id") ON DELETE CASCADE,
  "usuario_id" integer NOT NULL REFERENCES "usuarios"("id") ON DELETE CASCADE,
  "visto_en" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("cuenta_id", "usuario_id")
);
