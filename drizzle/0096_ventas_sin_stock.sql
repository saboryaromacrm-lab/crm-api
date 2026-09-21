-- VENTAS SIN STOCK — vender igual, pero que quede el rastro (21/9/2026, pedido del dueño).
--
-- La caja deja de frenarse cuando el sistema dice que no hay: se vende, y cada
-- renglón que se fue a negativo deja una INCIDENCIA en Almacén con todo lo que
-- hace falta para investigar (qué producto, en qué sucursal, cuánto decía el
-- sistema, cuánto se vendió, la diferencia, el comprobante, el cajero y la hora).
--
-- No se llama "error de stock" a propósito: el sistema no se equivocó, vendió lo
-- que se le pidió. Lo que la incidencia dice es que **el inventario tenía menos
-- de lo que había en la góndola**, y que alguien tiene que ir a contar.
--
-- Las tres columnas van sobre `incidencias` y no en una tabla nueva: comparten
-- el circuito (estados pendiente → revisión → resuelta), la pantalla y el
-- contador rojo del menú. Una tabla aparte habría que duplicarle las tres cosas.
ALTER TABLE "incidencias" ADD COLUMN IF NOT EXISTS "venta_id" integer REFERENCES "ventas"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "incidencias" ADD COLUMN IF NOT EXISTS "disponible_antes" double precision NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "incidencias" ADD COLUMN IF NOT EXISTS "vendido" double precision NOT NULL DEFAULT 0;--> statement-breakpoint

-- Anular una venta tiene que encontrar y cerrar las suyas.
CREATE INDEX IF NOT EXISTS "ix_incidencias_venta" ON "incidencias" ("venta_id");--> statement-breakpoint
-- El listado trae SIEMPRE todas las abiertas y solo las últimas resueltas: sin
-- este índice, acotar costaría recorrer la tabla entera — justo lo que acotar
-- vino a evitar. Hasta hoy `incidencias` viajaba ENTERA en la foto del
-- inventario, que es la llamada que abre Almacén y Compras: con esto usándose
-- todos los días, esa tabla dejaba de tener techo y la foto se hacía más pesada
-- cada mes.
CREATE INDEX IF NOT EXISTS "ix_incidencias_estado" ON "incidencias" ("estado", "id");--> statement-breakpoint

-- ── El interruptor, prendido ────────────────────────────────────────────────
-- Decisión del dueño (21/9): vender sin stock EN TODAS las sucursales y para
-- TODOS los roles. Hasta ahora el interruptor existía y estaba apagado, y con
-- él apagado la caja se frenaba con el cliente enfrente. Se prende acá para que
-- el sistema quede andando como se pidió, sin un paso manual que se olvide.
--
-- Sigue siendo un interruptor: se apaga desde Ventas › Configuración cuando se
-- quiera. Lo que cambió es que ahora dejarlo prendido NO es dejar el inventario
-- a la deriva — cada negativo queda anotado y hay que cerrarlo.
UPDATE "configuracion"
SET "valor" = jsonb_set("valor", '{permitirStockNegativo}', 'true'::jsonb)
WHERE "clave" = 'ventas'
  AND coalesce(("valor"->>'permitirStockNegativo')::boolean, false) = false;
