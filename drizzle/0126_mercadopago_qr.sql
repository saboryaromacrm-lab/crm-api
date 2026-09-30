-- ===========================================================================
-- 0126 · COBRO CON QR DE MERCADO PAGO (30/9/2026)
-- ===========================================================================
-- Pedido del dueño: cobrar con el QR de Mercado Pago desde la caja; el cobro
-- queda pendiente y, cuando el pago impacta, la venta se cierra sola.
--
-- Modelo «QR fijo por caja» (API de Orders, modo estático): cada computadora
-- que cobra tiene su caja en Mercado Pago con su QR impreso; el ERP le manda
-- el monto a ESA caja y el cliente, al escanear, ve el monto en su celular.
--
--   mp_sucursales  la sucursal dada de alta en Mercado Pago («store»).
--   mp_cajas       la caja de Mercado Pago de cada equipo («pos»), con su QR.
--   mp_cobros      cada cobro por QR: esperando → pagado | cancelado |
--                  vencido | error (se cobró pero la venta no pudo cerrarse:
--                  queda a la vista para resolver, la plata no se pierde).
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "mp_sucursales" (
  "sucursal_id" integer PRIMARY KEY REFERENCES "sucursales"("id") ON DELETE CASCADE,
  "mp_store_id" text NOT NULL,
  "external_id" text NOT NULL,
  "creada_en" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "mp_cajas" (
  "id" serial PRIMARY KEY,
  "sucursal_id" integer NOT NULL REFERENCES "sucursales"("id") ON DELETE CASCADE,
  "terminal_id" integer REFERENCES "terminales"("id") ON DELETE SET NULL,
  "nombre" text NOT NULL,
  "mp_pos_id" text NOT NULL DEFAULT '',
  "external_pos_id" text NOT NULL,
  "qr_imagen" text NOT NULL DEFAULT '',
  "qr_pdf" text NOT NULL DEFAULT '',
  "activa" boolean NOT NULL DEFAULT true,
  "creada_en" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_mp_cajas_external" ON "mp_cajas" ("external_pos_id");
--> statement-breakpoint
-- Un equipo, una caja (activa).
CREATE UNIQUE INDEX IF NOT EXISTS "uq_mp_cajas_terminal" ON "mp_cajas" ("terminal_id") WHERE "activa" AND "terminal_id" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "mp_cobros" (
  "id" serial PRIMARY KEY,
  "venta_id" integer NOT NULL REFERENCES "ventas"("id") ON DELETE CASCADE,
  "caja_id" integer NOT NULL REFERENCES "mp_cajas"("id"),
  "sucursal_id" integer NOT NULL,
  "order_id" text,
  "estado" text NOT NULL DEFAULT 'esperando',
  "monto" double precision NOT NULL,
  -- Cómo se cierra la venta cuando entra el pago (tipo, pagos, factura a CUIT…).
  "confirmar" jsonb NOT NULL,
  "payment_id" text NOT NULL DEFAULT '',
  "detalle" text NOT NULL DEFAULT '',
  "usuario_id" integer,
  "creado_en" timestamp with time zone NOT NULL DEFAULT now(),
  "actualizado_en" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ck_mp_cobros_estado" CHECK ("estado" IN ('esperando', 'procesando', 'pagado', 'cancelado', 'vencido', 'error'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_mp_cobros_order" ON "mp_cobros" ("order_id") WHERE "order_id" IS NOT NULL;
--> statement-breakpoint
-- Un solo cobro vivo por venta y por caja: dos cobros no pueden competir por el mismo QR.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_mp_cobros_venta_vivo" ON "mp_cobros" ("venta_id") WHERE "estado" IN ('esperando', 'procesando');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_mp_cobros_caja_vivo" ON "mp_cobros" ("caja_id") WHERE "estado" IN ('esperando', 'procesando');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_mp_cobros_sucursal_estado" ON "mp_cobros" ("sucursal_id", "estado");
