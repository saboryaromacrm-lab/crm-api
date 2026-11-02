-- 0212 · CERRAR LA CAJA CADA N DÍAS (2/11/2026, pedido del dueño: «hay sucursales que no manejan mucho
-- efectivo y es al pedo todos los días»). Por sucursal, de 1 (todos los días, como siempre) a 7.
-- El turno guarda el plazo CON EL QUE ABRIÓ: cambiar la sucursal con la caja abierta rige desde la
-- próxima apertura y nunca corre el vencimiento de un turno en curso. Se cierra a más tardar el día
-- de la apertura + plazo − 1 (hora argentina); pasado ese día, una caja de varios días no vende.
ALTER TABLE "sucursales" ADD COLUMN IF NOT EXISTS "cierre_cada_dias" integer NOT NULL DEFAULT 1;
ALTER TABLE "caja_sesiones" ADD COLUMN IF NOT EXISTS "plazo_dias" integer NOT NULL DEFAULT 1;
DO $$ BEGIN
  ALTER TABLE "sucursales" ADD CONSTRAINT "ck_sucursal_cierre_cada_dias" CHECK ("cierre_cada_dias" BETWEEN 1 AND 7);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "caja_sesiones" ADD CONSTRAINT "ck_caja_plazo_dias" CHECK ("plazo_dias" BETWEEN 1 AND 7);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
