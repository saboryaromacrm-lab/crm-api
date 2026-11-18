-- EL ARQUEO DEL DÍA (18/11/2026): los días que no son de cierre de un local con
-- días de cierre, la caja no se cierra: se cuenta el cajón y se firma. El conteo
-- queda en caja_controles con esta marca (lo lee la Planilla del día del Cash Flow).
ALTER TABLE "caja_controles" ADD COLUMN IF NOT EXISTS "arqueo_dia" boolean NOT NULL DEFAULT false;
