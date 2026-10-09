-- ===========================================================================
-- 0152 · GERENCIA › RESULTADOS — el estado de resultados (9/10/2026)
-- ===========================================================================
-- Pedido del dueño: el estado de resultados completo, TODO EN NETO (el IVA va
-- aparte, como un resultado propio), por mes y por sucursal, solo superadmin.
-- Lo que necesita y no existía:
--
--   · RUBROS: cómo entra cada rubro de gastos en el resultado (`resultado`) y,
--     cuando un gasto no es de un local, si se reparte entre los locales por lo
--     que vende cada uno o queda en «Administración» (`reparte`).
--   · GASTOS: el mes al que corresponde (`periodo`, devengado). Vacío = el mes
--     de su fecha, como hasta hoy.
--   · EMPLEADOS y sus SUELDOS con «vigente desde» (el costo del mes lleva las
--     cargas del empleador y 1/12 del aguinaldo).
--   · BIENES DE USO para las amortizaciones (opcionales).
--   · TASAS con «vigente desde»: Ingresos Brutos, tasa municipal por local (con
--     mínimo mensual) y comisión de tarjetas.
--   · OBJETIVOS por mes, ESCALA DE GANANCIAS por año y la CONFIGURACIÓN.
--
-- Los gastos fijos que se repiten pasan a ser solo del superadmin: la llave
-- `gastos.fijos` sale de los roles (la nueva no está en el catálogo).
-- ===========================================================================
ALTER TABLE "gasto_categorias" ADD COLUMN "resultado" text NOT NULL DEFAULT 'normal';
--> statement-breakpoint
ALTER TABLE "gasto_categorias" ADD CONSTRAINT "ck_gasto_cat_resultado" CHECK (
  "resultado" IN ('normal','sueldos','iibb','municipalidad','comisiones','financiero','ganancias','fuera')
);
--> statement-breakpoint
ALTER TABLE "gasto_categorias" ADD COLUMN "reparte" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
UPDATE "gasto_categorias" SET "resultado" = 'sueldos' WHERE "nombre" = 'Sueldos y cargas sociales';
--> statement-breakpoint
INSERT INTO "gasto_categorias" ("nombre", "tipo", "descripcion", "orden", "resultado") VALUES
  ('Ingresos Brutos', 'variable', 'El pago de la declaración de Ingresos Brutos. Reemplaza al estimado del mes en Resultados.', 41, 'iibb'),
  ('Tasa municipal (Seguridad e Higiene)', 'variable', 'El pago de la tasa municipal de cada local. Reemplaza al estimado del mes en Resultados.', 42, 'municipalidad'),
  ('Comisiones de tarjetas (posnet)', 'variable', 'Lo que descuenta el posnet al liquidar. Reemplaza al estimado del mes en Resultados.', 43, 'comisiones'),
  ('Impuesto a las Ganancias', 'fijo', 'Anticipos y saldo de Ganancias: en Resultados manda el estimado del año, no el pago.', 44, 'ganancias')
ON CONFLICT ("nombre") DO UPDATE SET "resultado" = EXCLUDED."resultado";
--> statement-breakpoint
ALTER TABLE "gastos" ADD COLUMN "periodo" date;
--> statement-breakpoint
ALTER TABLE "gastos" ADD CONSTRAINT "ck_gastos_periodo" CHECK ("periodo" IS NULL OR extract(day from "periodo") = 1);
--> statement-breakpoint
CREATE INDEX "ix_gastos_periodo" ON "gastos" ("periodo") WHERE "periodo" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "empleados" (
  "id" serial PRIMARY KEY,
  "nombre" text NOT NULL,
  "cuil" text NOT NULL DEFAULT '',
  "sucursal_id" integer REFERENCES "sucursales"("id") ON DELETE SET NULL,
  "alta" date NOT NULL,
  "baja" date,
  "observaciones" text NOT NULL DEFAULT '',
  "creado_en" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ck_empleados_baja" CHECK ("baja" IS NULL OR "baja" >= "alta")
);
--> statement-breakpoint
CREATE TABLE "empleado_sueldos" (
  "id" serial PRIMARY KEY,
  "empleado_id" integer NOT NULL REFERENCES "empleados"("id") ON DELETE CASCADE,
  "desde" date NOT NULL,
  "bruto" double precision NOT NULL,
  "cargas" double precision NOT NULL DEFAULT 0,
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "creado_en" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ck_empleado_sueldos_desde" CHECK (extract(day from "desde") = 1),
  CONSTRAINT "ck_empleado_sueldos_importes" CHECK ("bruto" >= 0 AND "cargas" >= 0 AND "cargas" <= 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_empleado_sueldos_desde" ON "empleado_sueldos" ("empleado_id", "desde");
--> statement-breakpoint
CREATE TABLE "bienes_uso" (
  "id" serial PRIMARY KEY,
  "nombre" text NOT NULL,
  "sucursal_id" integer REFERENCES "sucursales"("id") ON DELETE SET NULL,
  "valor" double precision NOT NULL,
  "alta" date NOT NULL,
  "vida_meses" integer NOT NULL,
  "baja" date,
  "observaciones" text NOT NULL DEFAULT '',
  "creado_en" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ck_bienes_uso" CHECK ("valor" > 0 AND "vida_meses" BETWEEN 1 AND 600 AND extract(day from "alta") = 1
    AND ("baja" IS NULL OR "baja" >= "alta"))
);
--> statement-breakpoint
CREATE TABLE "resultados_tasas" (
  "id" serial PRIMARY KEY,
  "concepto" text NOT NULL,
  "sucursal_id" integer REFERENCES "sucursales"("id") ON DELETE CASCADE,
  "medio" text,
  "porcentaje" double precision NOT NULL,
  "minimo" double precision NOT NULL DEFAULT 0,
  "desde" date NOT NULL,
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "creado_en" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ck_resultados_tasas" CHECK (
    "concepto" IN ('iibb','municipalidad','tarjeta')
    AND "porcentaje" >= 0 AND "porcentaje" <= 30 AND "minimo" >= 0
    AND extract(day from "desde") = 1
    AND ("medio" IS NULL OR ("concepto" = 'tarjeta' AND "medio" IN ('tarjeta_debito','tarjeta_credito')))
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_resultados_tasas" ON "resultados_tasas" ("concepto", coalesce("sucursal_id", 0), coalesce("medio", ''), "desde");
--> statement-breakpoint
INSERT INTO "resultados_tasas" ("concepto", "sucursal_id", "medio", "porcentaje", "desde") VALUES
  ('iibb', NULL, NULL, 3, '2026-01-01'),
  ('tarjeta', NULL, NULL, 4, '2026-01-01');
--> statement-breakpoint
INSERT INTO "resultados_tasas" ("concepto", "sucursal_id", "porcentaje", "desde")
  SELECT 'municipalidad', "id", 0.5, '2026-01-01' FROM "sucursales" WHERE "activa";
--> statement-breakpoint
CREATE TABLE "resultados_objetivos" (
  "id" serial PRIMARY KEY,
  "mes" date NOT NULL,
  "sucursal_id" integer REFERENCES "sucursales"("id") ON DELETE CASCADE,
  "venta_neta" double precision,
  "resultado" double precision,
  CONSTRAINT "ck_resultados_objetivos_mes" CHECK (extract(day from "mes") = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_resultados_objetivos" ON "resultados_objetivos" ("mes", coalesce("sucursal_id", 0));
--> statement-breakpoint
CREATE TABLE "ganancias_escalas" (
  "anio" integer PRIMARY KEY,
  "tramos" jsonb NOT NULL,
  "deducciones" jsonb NOT NULL,
  "actualizado_en" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Escala del artículo 94 y deducciones del artículo 30, PERÍODO ANUAL 2026 (tablas de ARCA).
INSERT INTO "ganancias_escalas" ("anio", "tramos", "deducciones") VALUES (2026,
  '[{"desde":0,"fijo":0,"pct":5},
    {"desde":2336953.69,"fijo":116847.68,"pct":9},
    {"desde":4673907.36,"fijo":327173.52,"pct":12},
    {"desde":7010861.05,"fijo":607607.96,"pct":15},
    {"desde":10516291.59,"fijo":1133422.54,"pct":19},
    {"desde":21032583.18,"fijo":3131517.94,"pct":23},
    {"desde":31548874.77,"fijo":5550265.01,"pct":27},
    {"desde":47323312.16,"fijo":9809363.10,"pct":31},
    {"desde":70984968.25,"fijo":17144476.49,"pct":35}]',
  '{"gni":6019671.36,"especial":21068849.78,"cargasFamilia":0,"otras":0}');
--> statement-breakpoint
CREATE TABLE "resultados_config" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "valor" jsonb NOT NULL DEFAULT '{}',
  "actualizado_en" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ck_resultados_config_uno" CHECK ("id" = 1)
);
--> statement-breakpoint
INSERT INTO "resultados_config" ("id", "valor") VALUES (1, '{"amortizaciones":false,"gananciasBase":"facturado"}');
--> statement-breakpoint
UPDATE "roles" SET "permisos" = "permisos" - 'gastos.fijos' WHERE "permisos" ? 'gastos.fijos';
