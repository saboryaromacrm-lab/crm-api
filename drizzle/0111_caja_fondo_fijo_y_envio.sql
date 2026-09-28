-- ===========================================================================
-- 0111 · FONDO FIJO DE CAJA Y CIERRE POR ENVIO (26/9/2026, pedido del dueño)
-- ===========================================================================
-- Cada sucursal tiene su FONDO FIJO de caja (ej. $50.000): la caja abre con
-- ese monto y al cerrar queda apartado para el turno siguiente. Lo carga el
-- superadmin; si no esta cargado, la primera apertura lo fija.
--
-- El cajero (todo el que no es admin ni superadmin) cierra A CIEGAS: cuenta el
-- cajon billete por billete, deja el fondo y ENVIA el resto. El turno guarda el
-- detalle de billetes, lo enviado y lo que quedo de fondo.
-- ===========================================================================

ALTER TABLE "sucursales" ADD COLUMN IF NOT EXISTS "fondo_caja" double precision;
--> statement-breakpoint
ALTER TABLE "caja_sesiones" ADD COLUMN IF NOT EXISTS "billetes" jsonb;
--> statement-breakpoint
ALTER TABLE "caja_sesiones" ADD COLUMN IF NOT EXISTS "envio_efectivo" double precision;
--> statement-breakpoint
ALTER TABLE "caja_sesiones" ADD COLUMN IF NOT EXISTS "fondo_queda" double precision;
