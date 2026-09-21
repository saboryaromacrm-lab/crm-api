-- ===========================================================================
-- 0099 · EL COSTO DE LO QUE LA CAFETERÍA ELABORA, EN LA FICHA
-- ===========================================================================
-- Hasta ahora el costo se tipeaba renglón por renglón en cada envío. Funciona,
-- pero obliga a recordarlo de memoria todas las mañanas y —peor— no deja ver
-- NUNCA desde cuándo ese número es el mismo. Con inflación, un costo que nadie
-- tocó en cuatro meses no es un costo: es una rentabilidad inventada, y miente
-- en silencio porque la pantalla lo muestra igual de seguro que uno de ayer.
--
-- Acá el costo pasa a vivir en el producto, y el envío lo PROPONE. Sigue
-- pudiéndose pisar renglón por renglón —una tanda puede salir más cara— pero
-- ese cambio es del envío y no de la ficha: el reloj de "hace cuánto" mide la
-- decisión deliberada de la cafetería, no un ajuste de un día.
--
-- `costo_cafeteria_actualizado` se mueve SOLO cuando el número cambia de verdad (lo
-- decide la API, igual que `precio_historial` con los precios). Guardar sin
-- tocar nada no puede poner el reloj en cero: si lo hiciera, el aviso de
-- "costo viejo" se apagaría solo con abrir y cerrar la pantalla, que es
-- exactamente lo contrario de para lo que sirve.
--
-- Nula al nacer = NUNCA se declaró, que no es lo mismo que "cuesta cero". La
-- pantalla los muestra distinto a propósito.
-- ===========================================================================

ALTER TABLE "productos"
  ADD COLUMN IF NOT EXISTS "costo_cafeteria" double precision NOT NULL DEFAULT 0;

ALTER TABLE "productos"
  ADD COLUMN IF NOT EXISTS "costo_cafeteria_actualizado" timestamp with time zone;
