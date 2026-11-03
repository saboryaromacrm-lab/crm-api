-- 0214 · LOS DÍAS DE CIERRE DE CAJA (3/11/2026, pedido del dueño: «un local martes y jueves me rinde
-- el dinero de los días anteriores, porque yo voy a buscarlo durante el día»). Reemplaza el «cada N
-- días» de la 0212, que no sirve para días salteados: de martes a jueves hay 2 días y de jueves al
-- martes, 5.
--
-- · sucursales.dias_cierre: los días de la semana en que se cierra la caja (1 = lunes … 7 = domingo).
--   Los siete = todos los días, como siempre. Para el ejemplo del dueño: lunes y miércoles, y él
--   pasa a buscar el sobre el martes y el jueves.
-- · caja_sesiones.cerrar_hasta: el último día para cerrar ESE turno, fijado al abrir (el próximo día
--   de cierre desde la apertura). Vacío = local de todos los días. Cambiar los días con la caja
--   abierta rige desde la próxima apertura.
--
-- Los turnos de la 0212 con plazo de varios días conservan su último día. Un local que tuviera
-- «cada N días» pasa a todos los días: hay que elegirle los días de nuevo.
-- cierre_cada_dias y plazo_dias quedan sin uso (el contenedor viejo los lee mientras corre el
-- deploy): se borran en una migración posterior.
ALTER TABLE "sucursales" ADD COLUMN IF NOT EXISTS "dias_cierre" integer[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}';
DO $$ BEGIN
  ALTER TABLE "sucursales" ADD CONSTRAINT "ck_sucursal_dias_cierre"
    CHECK (cardinality("dias_cierre") BETWEEN 1 AND 7 AND "dias_cierre" <@ '{1,2,3,4,5,6,7}'::integer[]);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "caja_sesiones" ADD COLUMN IF NOT EXISTS "cerrar_hasta" date;
UPDATE "caja_sesiones"
   SET "cerrar_hasta" = ("apertura" AT TIME ZONE 'America/Argentina/Buenos_Aires')::date + "plazo_dias" - 1
 WHERE "plazo_dias" > 1 AND "cerrar_hasta" IS NULL;
