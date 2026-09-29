-- ===========================================================================
-- 0120 · LA CUENTA CORRIENTE ENTRE SABOR Y AROMA Y COFFIT (29/9/2026)
-- ===========================================================================
-- Pedido del dueño después de la conciliación entre los dos negocios: hasta
-- hoy el saldo era solo del período elegido, no arrastraba y no había dónde
-- anotar un pago. Ahora:
--   · los movimientos de la cuenta salen SOLOS de los documentos (compras para
--     Coffit, envíos, entradas, diferencias al recibir, gastos de Coffit al
--     neto) — no se copian a ninguna tabla: se calculan, así no se desfasan;
--   · lo que no sale de un documento (saldo inicial, pagos, compensaciones,
--     ajustes, el stock que pasa a Coffit al marcar un artículo exclusivo) va
--     en `coffit_movimientos`;
--   · el cierre mensual congela el saldo en `coffit_cierres`. Después, lo que
--     llegue con fecha de un mes cerrado (la factura que llega tarde) entra a
--     la cuenta el día que se carga: `cuenta_fecha`. Vacía = cuenta en su fecha.
-- ===========================================================================

ALTER TABLE "comprobantes" ADD COLUMN IF NOT EXISTS "cuenta_fecha" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "gastos" ADD COLUMN IF NOT EXISTS "cuenta_fecha" timestamp with time zone;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "coffit_movimientos" (
  "id" serial PRIMARY KEY,
  "fecha" timestamp with time zone NOT NULL DEFAULT now(),
  "tipo" text NOT NULL,
  "a_favor" text NOT NULL,
  "importe" double precision NOT NULL,
  "descripcion" text NOT NULL DEFAULT '',
  "medio" text NOT NULL DEFAULT '',
  "referencia" text NOT NULL DEFAULT '',
  "producto_id" integer REFERENCES "productos"("id") ON DELETE SET NULL,
  "cantidad" double precision,
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "creado_en" timestamp with time zone NOT NULL DEFAULT now(),
  "anulado" boolean NOT NULL DEFAULT false,
  "motivo_anulacion" text NOT NULL DEFAULT '',
  "anulado_por" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "anulado_en" timestamp with time zone,
  CONSTRAINT "ck_coffit_mov_tipo" CHECK ("tipo" IN ('saldo_inicial', 'pago', 'compensacion', 'ajuste', 'marca_exclusivo')),
  CONSTRAINT "ck_coffit_mov_a_favor" CHECK ("a_favor" IN ('sya', 'coffit')),
  CONSTRAINT "ck_coffit_mov_importe" CHECK ("importe" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_coffit_mov_fecha" ON "coffit_movimientos" ("fecha");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "coffit_cierres" (
  "id" serial PRIMARY KEY,
  "desde" date,
  "hasta" date NOT NULL,
  "saldo_anterior" double precision NOT NULL DEFAULT 0,
  "totales" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "saldo_final" double precision NOT NULL DEFAULT 0,
  "detalle" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "observaciones" text NOT NULL DEFAULT '',
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "creado_en" timestamp with time zone NOT NULL DEFAULT now(),
  "anulado" boolean NOT NULL DEFAULT false,
  "motivo_anulacion" text NOT NULL DEFAULT '',
  "anulado_por" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "anulado_en" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_coffit_cierre_hasta" ON "coffit_cierres" ("hasta") WHERE NOT "anulado";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_envios_cafe_recibido" ON "envios_cafeteria" ("recibido_en");
