-- 0061 · EL PRECIO QUE SE HONRA PORQUE SE COTIZÓ
--
-- Sexta razón por la que un renglón puede tener la lista que tiene: la casa se
-- lo prometió por escrito en un presupuesto. Hasta acá esas cinco razones eran
-- base / cliente / auto / manual / marca / monto, así que un pedido mayorista
-- cerrado en el POS solo podía entrar como 'manual' — o sea, indistinguible de
-- alguien regalando precio a mano, que es exactamente lo que esta columna
-- existe para poder auditar.
--
-- SE REARMA EL ENUM en vez de usar `ALTER TYPE ... ADD VALUE`: el runner de
-- migraciones corre todo en UNA transacción, y Postgres no deja usar un valor
-- de enum recién agregado dentro de la misma transacción que lo agregó. Es la
-- trampa que ya se pagó con los estados del envío a Cafetería (0037) y con el
-- borrador del pedido (0055); el rodeo es el mismo: pasar la columna a texto,
-- tirar el tipo, crearlo de nuevo y volver.
ALTER TABLE "venta_items" ALTER COLUMN "lista_origen" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "venta_items" ALTER COLUMN "lista_origen" TYPE text;--> statement-breakpoint
DROP TYPE "origen_lista";--> statement-breakpoint
CREATE TYPE "origen_lista" AS ENUM ('base', 'cliente', 'auto', 'manual', 'marca', 'monto', 'presupuesto');--> statement-breakpoint
ALTER TABLE "venta_items" ALTER COLUMN "lista_origen" TYPE "origen_lista" USING "lista_origen"::"origen_lista";--> statement-breakpoint
ALTER TABLE "venta_items" ALTER COLUMN "lista_origen" SET DEFAULT 'base';--> statement-breakpoint
ALTER TABLE "venta_items" ALTER COLUMN "lista_origen" SET NOT NULL;
