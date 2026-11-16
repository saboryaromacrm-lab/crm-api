-- ===========================================================================
-- 0227 · EL AVISO DE UNA ANOTACIÓN: HASTA CUÁNDO, E IMPORTANTE (16/11/2026, pedido del dueño)
-- ===========================================================================
-- «Que instantáneamente ya le muestre el banner con posibilidad de marcarle
-- hasta cuándo, y con la posibilidad de marcar también como importante y que
-- sea un banner más llamativo, más de rojo y advertencia.»
--
--   · aviso_hasta: el último día (de Argentina) en que sale el aviso. Con
--     fecha, el aviso sale TODOS LOS DÍAS hasta esa fecha: «Entendido» lo
--     oculta solo por hoy (queda asentado en visto_en). Sin fecha, como hasta
--     ahora: sale hasta que la persona toca «Listo».
--   · importante: el aviso sale en rojo, primero.
-- ===========================================================================
ALTER TABLE "anotaciones" ADD COLUMN IF NOT EXISTS "aviso_hasta" date;
--> statement-breakpoint
ALTER TABLE "anotaciones" ADD COLUMN IF NOT EXISTS "importante" boolean DEFAULT false NOT NULL;
