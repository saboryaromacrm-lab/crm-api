-- CUENTAS DISPONIBLES — la transferencia tercerizada (20/9/2026, pedido del dueño).
--
-- Se le debe a un proveedor y, en vez de pagarle de la cuenta propia, se le da
-- a los clientes el alias del proveedor: el cliente transfiere directo allá.
-- Cada transferencia es DOS cosas a la vez —un cobro de la venta y un pago al
-- proveedor— y nacen en la misma transacción, o no nace ninguna.
--
-- Lo que trae:
--   · el medio de pago `transferencia_proveedor` (distinto de `transferencia`
--     a propósito: esa plata nunca entra al banco propio y no puede contarse
--     como si hubiera entrado);
--   · el mínimo de transferencia por proveedor ("menos de $50.000 no");
--   · el titular en las cuentas bancarias del proveedor;
--   · las dos tablas: la cuenta (el balde) y sus pagos (cada transferencia).
--
-- Declarar el valor nuevo del enum es seguro acá: esta migración no lo USA (la
-- restricción de Postgres es sobre usarlo en la misma transacción).
ALTER TYPE "medio_pago" ADD VALUE IF NOT EXISTS 'transferencia_proveedor';--> statement-breakpoint

ALTER TABLE "proveedores" ADD COLUMN IF NOT EXISTS "minimo_transferencia" double precision NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "proveedor_cuentas" ADD COLUMN IF NOT EXISTS "titular" text NOT NULL DEFAULT '';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "cuentas_disponibles" (
  "id" serial PRIMARY KEY NOT NULL,
  "proveedor_id" integer NOT NULL REFERENCES "proveedores"("id") ON DELETE RESTRICT,
  "cuenta_id" integer REFERENCES "proveedor_cuentas"("id") ON DELETE SET NULL,
  "titular" text NOT NULL DEFAULT '',
  "cbu_alias" text NOT NULL DEFAULT '',
  "importe" double precision NOT NULL DEFAULT 0,
  "fecha" timestamp with time zone NOT NULL DEFAULT now(),
  "prioritaria" boolean NOT NULL DEFAULT false,
  "enviado" boolean NOT NULL DEFAULT false,
  "corte" boolean NOT NULL DEFAULT false,
  "corte_en" timestamp with time zone,
  "observaciones" text NOT NULL DEFAULT '',
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "creado_en" timestamp with time zone NOT NULL DEFAULT now(),
  -- Una cuenta con importe cero o negativo no tiene nada que cubrir.
  CONSTRAINT "ck_cuentas_disp_importe" CHECK ("importe" > 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_cuentas_disp_proveedor" ON "cuentas_disponibles" ("proveedor_id", "corte");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_cuentas_disp_fecha" ON "cuentas_disponibles" ("fecha");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "cuenta_disponible_pagos" (
  "id" serial PRIMARY KEY NOT NULL,
  "cuenta_id" integer NOT NULL REFERENCES "cuentas_disponibles"("id") ON DELETE RESTRICT,
  "importe" double precision NOT NULL DEFAULT 0,
  "fecha" timestamp with time zone NOT NULL DEFAULT now(),
  "venta_pago_id" integer REFERENCES "venta_pagos"("id") ON DELETE RESTRICT,
  "cobranza_pago_id" integer REFERENCES "cobranza_pagos"("id") ON DELETE RESTRICT,
  "proveedor_pago_id" integer NOT NULL REFERENCES "proveedor_pagos"("id") ON DELETE RESTRICT,
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "observaciones" text NOT NULL DEFAULT '',
  "anulado_en" timestamp with time zone,
  -- Nace de UN cobro: el renglón de una venta o el de un recibo, nunca los dos
  -- ni ninguno. La base lo garantiza, no el servicio.
  CONSTRAINT "ck_cta_disp_pagos_origen" CHECK (
    ("venta_pago_id" IS NOT NULL)::int + ("cobranza_pago_id" IS NOT NULL)::int = 1
  ),
  CONSTRAINT "ck_cta_disp_pagos_importe" CHECK ("importe" > 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_cta_disp_pagos_cuenta" ON "cuenta_disponible_pagos" ("cuenta_id", "anulado_en");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_cta_disp_pagos_venta_pago" ON "cuenta_disponible_pagos" ("venta_pago_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_cta_disp_pagos_cobranza_pago" ON "cuenta_disponible_pagos" ("cobranza_pago_id");--> statement-breakpoint
-- Un pago al proveedor es espejo de UNA transferencia, nunca de dos.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cta_disp_pagos_prov_pago" ON "cuenta_disponible_pagos" ("proveedor_pago_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_cta_disp_pagos_fecha" ON "cuenta_disponible_pagos" ("fecha");--> statement-breakpoint

-- ── Llaves ──────────────────────────────────────────────────────────────────
-- La sección nueva del módulo Proveedores arranca en admin, como sus hermanas
-- (0068). Superadmin ya tiene '*'.
UPDATE "roles" SET "permisos" = "permisos" || '["proveedores.cuentas"]'::jsonb
WHERE "clave" = 'admin' AND NOT ("permisos" ? 'proveedores.cuentas');--> statement-breakpoint

-- ── El medio, habilitado de entrada ─────────────────────────────────────────
-- La configuración de Ventas guarda la lista de medios habilitados: sin esto,
-- el medio nuevo existiría pero no aparecería en la caja hasta que alguien
-- entre a tildarlo. Solo se agrega si la lista ya está guardada y no lo tiene.
UPDATE "configuracion"
SET "valor" = jsonb_set("valor", '{mediosPago}', ("valor"->'mediosPago') || '["transferencia_proveedor"]'::jsonb)
WHERE "clave" = 'ventas'
  AND jsonb_typeof("valor"->'mediosPago') = 'array'
  AND NOT ("valor"->'mediosPago' ? 'transferencia_proveedor');
