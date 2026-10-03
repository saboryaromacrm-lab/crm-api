-- ===========================================================================
-- 0130 · LOS BILLETES DEL ENVÍO, APARTE (3/10/2026)
-- ===========================================================================
-- Pedido del dueño: el papel del cierre tiene que decir «Dejar en caja $X» y,
-- aparte, el ENVÍO con su contador de billetes, para controlar el sobre contra
-- esa lista (hoy lista todo el cajón y el fondo que queda se mezcla).
-- `billetes` sigue siendo el conteo de TODO el cajón; esta columna es la parte
-- que va en el sobre ({ "20000": 3, … }). Lo que queda en la caja es la resta.
-- NULL en los turnos cerrados antes de esto: nadie cambia de comportamiento.
ALTER TABLE "caja_sesiones" ADD COLUMN IF NOT EXISTS "billetes_envio" jsonb;
