-- ===========================================================================
-- 0133 · CASH FLOW: LA CAJA CENTRAL DE EFECTIVO DEL DUEÑO (4/10/2026)
-- ===========================================================================
-- Pedido del dueño: una sección en Gerencia con TODO el efectivo físico que le
-- llega (los sobres de cada cierre de caja de los locales) y el que saca
-- (pagos a proveedores, gastos, retiros). Las cajas y los sobres de hoy NO se
-- tocan: acá se agrega el CONTROL encima (cuánto contó el dueño, la
-- diferencia con su motivo) y un libro de movimientos cuya suma es el saldo.
--
--   cashflow_caja        UNA sola fila: desde qué día arranca y con cuánto.
--   cashflow_conceptos   Los motivos de ingreso/egreso que configura el dueño.
--                        clase 'gasto' (crea el gasto en Gastos) o 'movimiento'
--                        (retiro, depósito: la plata se mueve, no se gasta).
--   cashflow_sobres      El control de cada sobre: enviado vs contado. Un
--                        control VIGENTE por sobre; deshacerlo lo anula con motivo.
--   cashflow_movimientos El libro: cada ingreso/egreso con su origen. Nunca se
--                        borra: se anula con motivo y queda a la vista.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "cashflow_caja" (
  "id" serial PRIMARY KEY,
  "fecha_inicio" date NOT NULL,
  "saldo_inicial" double precision NOT NULL DEFAULT 0,
  "abierta_en" timestamp with time zone NOT NULL DEFAULT now(),
  "abierta_por" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "observaciones" text NOT NULL DEFAULT ''
);
-- Una sola caja central (decisión del dueño): el índice no deja una segunda fila.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cashflow_caja_unica" ON "cashflow_caja" ((true));

CREATE TABLE IF NOT EXISTS "cashflow_conceptos" (
  "id" serial PRIMARY KEY,
  "nombre" text NOT NULL,
  "tipo" text NOT NULL CHECK ("tipo" IN ('ingreso', 'egreso')),
  "clase" text NOT NULL DEFAULT 'movimiento' CHECK ("clase" IN ('gasto', 'movimiento')),
  "gasto_categoria_id" integer REFERENCES "gasto_categorias"("id") ON DELETE SET NULL,
  "activo" boolean NOT NULL DEFAULT true,
  "orden" integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cashflow_concepto_nombre" ON "cashflow_conceptos" (lower("nombre"));

CREATE TABLE IF NOT EXISTS "cashflow_sobres" (
  "id" serial PRIMARY KEY,
  "caja_sesion_id" integer NOT NULL REFERENCES "caja_sesiones"("id") ON DELETE RESTRICT,
  "enviado" double precision NOT NULL,
  "contado" double precision NOT NULL,
  "diferencia" double precision NOT NULL,
  "motivo" text NOT NULL DEFAULT '',
  "controlado_en" timestamp with time zone NOT NULL DEFAULT now(),
  "controlado_por" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "anulado_en" timestamp with time zone,
  "anulado_por" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "anulado_motivo" text NOT NULL DEFAULT ''
);
-- Un control vigente por sobre: el candado vive en la base, no en la aplicación.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cashflow_sobre_vigente" ON "cashflow_sobres" ("caja_sesion_id") WHERE "anulado_en" IS NULL;

CREATE TABLE IF NOT EXISTS "cashflow_movimientos" (
  "id" serial PRIMARY KEY,
  "fecha" timestamp with time zone NOT NULL DEFAULT now(),
  "tipo" text NOT NULL CHECK ("tipo" IN ('ingreso', 'egreso')),
  "origen" text NOT NULL CHECK ("origen" IN ('saldo_inicial', 'sobre', 'concepto', 'pago_proveedor', 'gasto', 'conteo')),
  "importe" double precision NOT NULL CHECK ("importe" >= 0),
  "concepto_id" integer REFERENCES "cashflow_conceptos"("id") ON DELETE RESTRICT,
  "sobre_id" integer REFERENCES "cashflow_sobres"("id") ON DELETE RESTRICT,
  "pago_id" integer REFERENCES "proveedor_pagos"("id") ON DELETE RESTRICT,
  "gasto_id" integer REFERENCES "gastos"("id") ON DELETE RESTRICT,
  "detalle" text NOT NULL DEFAULT '',
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "anulado_en" timestamp with time zone,
  "anulado_por" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "anulado_motivo" text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS "ix_cashflow_mov_fecha" ON "cashflow_movimientos" ("fecha");
-- Un movimiento vigente por sobre controlado y uno solo de saldo inicial.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cashflow_mov_sobre" ON "cashflow_movimientos" ("sobre_id") WHERE "sobre_id" IS NOT NULL AND "anulado_en" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cashflow_mov_saldo_inicial" ON "cashflow_movimientos" (("origen")) WHERE "origen" = 'saldo_inicial' AND "anulado_en" IS NULL;

-- Tres conceptos para arrancar; el dueño agrega los suyos desde la pantalla.
INSERT INTO "cashflow_conceptos" ("nombre", "tipo", "clase", "orden") VALUES
  ('Retiro del dueño', 'egreso', 'movimiento', 10),
  ('Depósito en el banco', 'egreso', 'movimiento', 20),
  ('Ingreso de efectivo', 'ingreso', 'movimiento', 30)
ON CONFLICT DO NOTHING;
