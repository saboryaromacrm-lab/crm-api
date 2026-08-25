-- CUÁNDO NACIÓ EL PRODUCTO — la fecha que separa NUEVO de REINGRESO.
--
-- El chip NUEVO de las novedades del pedido marcaba "este local nunca lo
-- tuvo": una definición relativa al local, que para una sucursal sin historia
-- gritaba NUEVO sobre el catálogo entero. El dueño la corrigió (25/8/2026):
-- nuevo es el producto que SE CREÓ hace poco y entró a stock; el que ya
-- existía y volvió a entrar al depósito es un REINGRESO, lo haya tenido ese
-- local o no.
--
-- Para eso hace falta saber cuándo nació cada producto, y esa fecha no
-- existía. Desde ahora la pone el default en cada alta.
--
-- LOS EXISTENTES QUEDAN TODOS CON FECHA BIEN VIEJA (1/1/2026) a propósito, y
-- la fecha NO es el corte histórico de las novedades (1/8): tiene que quedar
-- FUERA de la ventana de 30 días del chip — con el 1/8 el catálogo entero
-- contaba como "creado hace poco" y el estreno gritaba NUEVO sobre todo
-- (probado: pasó en la primera corrida). Sus altas reales no están
-- registradas en ningún lado — vinieron del importador del sistema viejo — y
-- adivinar con el id o el historial de precios marcaría NUEVO de más. Un chip
-- que grita de más se deja de mirar en una semana; uno conservador tarda un
-- mes más en lucirse pero no miente nunca.
--
-- Idempotente de verdad: la columna nace SIN default (queda NULL en los
-- existentes), el backfill llena solo los NULL, y el default entra recién
-- después. Re-correrla no encuentra NULL y no pisa ningún alta real.

ALTER TABLE productos ADD COLUMN IF NOT EXISTS creado_en timestamptz;

UPDATE productos
   SET creado_en = timestamptz '2026-01-01 00:00:00-03'
 WHERE creado_en IS NULL;

ALTER TABLE productos ALTER COLUMN creado_en SET DEFAULT now();
ALTER TABLE productos ALTER COLUMN creado_en SET NOT NULL;
