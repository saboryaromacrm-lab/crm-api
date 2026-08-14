-- 0064 · EL DESCUENTO PROPIO DEL RENGLÓN, aparte del que se cobró
--
-- El 0063 dejó el renglón guardando el descuento COMBINADO (`descuento`) y de
-- quién vino cuando ganó un nombrado (`descuento_id` + `descuento_nombre`). Le
-- falta el tercero: cuánto traía el renglón POR SU CUENTA — el descuento del
-- cliente, o el que el vendedor puso a mano.
--
-- POR QUÉ NO ES REDUNDANTE. Cuando no hay descuento con nombre los dos números
-- son iguales, y ahí parece de más. El problema aparece al REABRIR un borrador,
-- que en esta caja pasa todo el día (hay varios tickets abiertos a la vez):
--
--   · El renglón vuelve al POS con `descuento = 25` y su `descuento_id`. Sin
--     este campo, el POS no tiene forma de saber que 25 no lo escribió nadie:
--     lo trata como manual y el autoguardado siguiente se lo manda al servidor
--     como tal. El servidor lo rebota contra `descuentoMaxVendedor` (10%) ANTES
--     de llegar a aplicar el nombrado, y el ticket queda sin poder guardarse
--     con un error sobre un número que el cajero nunca tipeó. Es el mismo bug
--     que ya pasó una vez acá con las ofertas y el descuento del cliente.
--
--   · Y quitar el descuento en pantalla dejaría el renglón en 0 en vez de
--     volver al 10% que ese cliente tiene por contrato: le cobraríamos de más
--     sin que nadie lo note.
--
-- El arrastre se completa con el valor que ya existía: hasta hoy no había
-- descuentos con nombre, así que en todo renglón viejo el que se cobró ERA el
-- propio. La condición sobre `descuento_id` deja intactos los que sí tengan
-- nombrado, si alguno se cargó probando.

ALTER TABLE "venta_items" ADD COLUMN IF NOT EXISTS "descuento_base" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "venta_items" SET "descuento_base" = "descuento" WHERE "descuento_id" IS NULL;
