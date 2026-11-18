-- VENTAS › CONCILIACIÓN MP (18/11/2026): lo que Mercado Pago dice que entró a
-- la cuenta, y con qué cobro del ERP se ató (ver src/mercadopago/conciliacion.ts).
--   mp_movimientos       un pago de Mercado Pago que entró (se baja solo cada 5 min)
--   mp_conciliaciones    un atado: auto, manual, «no es venta» (sin_venta) o «no entró a MP» (sin_mp)
--   mp_conciliacion_erp  qué renglones de pago (de ventas o de recibos) forman parte de cada atado
CREATE TABLE IF NOT EXISTS "mp_conciliaciones" (
  "id" serial PRIMARY KEY,
  "tipo" text NOT NULL CHECK ("tipo" IN ('auto', 'manual', 'sin_venta', 'sin_mp')),
  "motivo" text NOT NULL DEFAULT '',
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "creado_en" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "mp_movimientos" (
  "id" text PRIMARY KEY,
  "fecha" timestamptz NOT NULL,
  "estado" text NOT NULL,
  "familia" text NOT NULL,
  "tipo" text NOT NULL DEFAULT '',
  "metodo" text NOT NULL DEFAULT '',
  "operacion" text NOT NULL DEFAULT '',
  "cuotas" integer NOT NULL DEFAULT 1,
  "bruto" double precision NOT NULL DEFAULT 0,
  "comision" double precision NOT NULL DEFAULT 0,
  "neto" double precision NOT NULL DEFAULT 0,
  "devuelto" double precision NOT NULL DEFAULT 0,
  "liberacion" timestamptz,
  "pos_id" text NOT NULL DEFAULT '',
  "store_id" text NOT NULL DEFAULT '',
  "sucursal_id" integer REFERENCES "sucursales"("id") ON DELETE SET NULL,
  "pagador" text NOT NULL DEFAULT '',
  "referencia" text NOT NULL DEFAULT '',
  "actualizado_mp" timestamptz NOT NULL,
  "traido_en" timestamptz NOT NULL DEFAULT now(),
  "conciliacion_id" integer REFERENCES "mp_conciliaciones"("id") ON DELETE SET NULL,
  "a_mano" boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS "ix_mp_movimientos_fecha" ON "mp_movimientos" ("fecha");
CREATE INDEX IF NOT EXISTS "ix_mp_movimientos_actualizado" ON "mp_movimientos" ("actualizado_mp");
CREATE INDEX IF NOT EXISTS "ix_mp_movimientos_conciliacion" ON "mp_movimientos" ("conciliacion_id");

CREATE TABLE IF NOT EXISTS "mp_conciliacion_erp" (
  "id" serial PRIMARY KEY,
  "conciliacion_id" integer NOT NULL REFERENCES "mp_conciliaciones"("id") ON DELETE CASCADE,
  "venta_pago_id" integer UNIQUE REFERENCES "venta_pagos"("id") ON DELETE CASCADE,
  "cobranza_pago_id" integer UNIQUE REFERENCES "cobranza_pagos"("id") ON DELETE CASCADE,
  CHECK (("venta_pago_id" IS NULL) <> ("cobranza_pago_id" IS NULL))
);
CREATE INDEX IF NOT EXISTS "ix_mp_conciliacion_erp_conciliacion" ON "mp_conciliacion_erp" ("conciliacion_id");
