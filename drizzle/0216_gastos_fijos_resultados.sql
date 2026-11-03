-- ===========================================================================
-- 0216 · GASTOS FIJOS PARA EL ESTADO DE RESULTADOS (3/11/2026, pedido del dueño)
-- ===========================================================================
-- «Quiero cargar mis gastos fijos —alquileres, sueldos y demás— y que te sirvan
-- para el estado de resultados, por sucursal y configurable.» Dos cosas que
-- faltaban:
--
--   · UN GASTO FIJO CUENTA AUNQUE NO SE HAYA GENERADO. Hasta hoy, el alquiler de
--     un mes en que nadie apretó «Generar» no aparecía y la ganancia salía de
--     más. Ahora el estado de resultados pone el ESTIMADO de la plantilla en los
--     meses en que corre (`desde` / `hasta`) y no tiene gasto cargado; el gasto
--     real lo reemplaza solo.
--       desde  el primer mes en que corre (día 1). Las que ya existen arrancan
--              en el mes de su primer gasto generado, o en el mes actual.
--       hasta  el último mes que cuenta (día 1); null = sigue. Dar de baja una
--              plantilla la corta desde el mes en que se da de baja (queda en el
--              anterior). Las ya dadas de baja, en el mes de su último gasto o,
--              sin gastos, en el anterior a `desde`: «nunca corrió», no estima.
--
--   · REPARTIR UN GASTO ENTRE LOCALES POR PORCENTAJE (`reparto`): un alquiler
--     o un sueldo compartido, 50 % Express 1 y 50 % Express 2. Lista
--     [{ "sucursalId": n, "pct": n }] que suma 100. Manda sobre el local:
--     un gasto con reparto no tiene local. Va en la plantilla, en el gasto que
--     genera (copiado: cambiar la plantilla no reescribe la historia) y en el
--     empleado.
-- ===========================================================================
ALTER TABLE "gastos_recurrentes" ADD COLUMN "desde" date;
--> statement-breakpoint
ALTER TABLE "gastos_recurrentes" ADD COLUMN "hasta" date;
--> statement-breakpoint
ALTER TABLE "gastos_recurrentes" ADD COLUMN "reparto" jsonb;
--> statement-breakpoint
UPDATE "gastos_recurrentes" r SET "desde" = coalesce(
  (SELECT min(date_trunc('month', coalesce(g.periodo, (g.fecha AT TIME ZONE 'America/Argentina/Buenos_Aires')::date))::date)
     FROM "gastos" g WHERE g.recurrente_id = r.id AND g.estado <> 'anulado'),
  date_trunc('month', (now() AT TIME ZONE 'America/Argentina/Buenos_Aires'))::date
);
--> statement-breakpoint
UPDATE "gastos_recurrentes" r SET "hasta" = coalesce(
  (SELECT max(date_trunc('month', coalesce(g.periodo, (g.fecha AT TIME ZONE 'America/Argentina/Buenos_Aires')::date))::date)
     FROM "gastos" g WHERE g.recurrente_id = r.id AND g.estado <> 'anulado'),
  (date_trunc('month', (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')) - interval '1 month')::date
) WHERE NOT r.activo;
--> statement-breakpoint
UPDATE "gastos_recurrentes" SET "hasta" = ("desde" - interval '1 month')::date WHERE "hasta" < ("desde" - interval '1 month')::date;
--> statement-breakpoint
ALTER TABLE "gastos_recurrentes" ALTER COLUMN "desde" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "gastos_recurrentes" ALTER COLUMN "desde" SET DEFAULT date_trunc('month', (now() AT TIME ZONE 'America/Argentina/Buenos_Aires'))::date;
--> statement-breakpoint
ALTER TABLE "gastos_recurrentes" ADD CONSTRAINT "ck_gastos_recurrentes_vigencia" CHECK (
  extract(day FROM "desde") = 1 AND ("hasta" IS NULL OR (extract(day FROM "hasta") = 1 AND "hasta" >= ("desde" - interval '1 month')::date))
);
--> statement-breakpoint
ALTER TABLE "gastos_recurrentes" ADD CONSTRAINT "ck_gastos_recurrentes_reparto" CHECK ("reparto" IS NULL OR jsonb_typeof("reparto") = 'array');
--> statement-breakpoint
ALTER TABLE "gastos" ADD COLUMN "reparto" jsonb;
--> statement-breakpoint
ALTER TABLE "gastos" ADD CONSTRAINT "ck_gastos_reparto" CHECK ("reparto" IS NULL OR (jsonb_typeof("reparto") = 'array' AND "sucursal_id" IS NULL));
--> statement-breakpoint
ALTER TABLE "empleados" ADD COLUMN "reparto" jsonb;
--> statement-breakpoint
ALTER TABLE "empleados" ADD CONSTRAINT "ck_empleados_reparto" CHECK ("reparto" IS NULL OR (jsonb_typeof("reparto") = 'array' AND "sucursal_id" IS NULL));
--> statement-breakpoint
ALTER TABLE "gastos_recurrentes" ADD CONSTRAINT "ck_gastos_recurrentes_reparto_local" CHECK ("reparto" IS NULL OR "sucursal_id" IS NULL);
