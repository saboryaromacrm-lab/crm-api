-- 0065 · LA OFERTA ELIGE SOBRE QUÉ LISTAS CORRE
--
-- Hasta acá la oferta tenía un sí/no: `solo_precio_base`. Servía para lo único
-- que se podía expresar —"que no se sume al precio ya negociado de un
-- mayorista"— y no para lo que el dueño pidió el 15/8/2026: una promo que corra
-- SOLO sobre una lista puntual. Con el sí/no, "20% en Mayorista 1" era
-- imposible: o corría en todas o corría solo en la de mostrador.
--
-- Ahora es una lista de ids, con el mismo molde que `sucursales` y `dias` en
-- esta misma tabla: CSV, y VACÍO = todas. Son conjuntos de tres o cuatro
-- elementos que se leen enteros con la oferta; una tabla aparte sería una junta
-- más en el camino más caliente del POS.
--
-- POR QUÉ MUERE `solo_precio_base` Y NO CONVIVE (decisión del dueño): dice lo
-- mismo con otro vocabulario. Dos perillas que se pisan obligan a explicar cuál
-- gana cada vez que alguien arma una oferta, y esa explicación no existe.
--
-- EL ARRASTRE ES EXACTO:
--   · La que estaba en `true` queda atada a la LISTA BASE, que es la que el
--     motor le da a un renglón sin ninguna condición cumplida — o sea el precio
--     de mostrador, que es lo que esa tilde quería decir. La lista base sale de
--     la configuración (`ventas.listaBaseId`), no de un número escrito acá.
--   · La que estaba en `false` corría en todas: queda con el CSV vacío.
--
-- Y si la configuración no tiene lista base cargada, la fila queda vacía (corre
-- en todas) en vez de quedar apuntando a una lista inventada: es preferible una
-- oferta que alcanza de más y se ve, a una que no alcanza a nada y desaparece
-- sin que nadie entienda por qué.

ALTER TABLE "ofertas" ADD COLUMN IF NOT EXISTS "listas" text DEFAULT '' NOT NULL;--> statement-breakpoint

UPDATE "ofertas" o
SET "listas" = c."base"
FROM (
  SELECT (valor->>'listaBaseId') AS "base"
  FROM "configuracion" WHERE clave = 'ventas'
) c
WHERE o."solo_precio_base" = true
  AND c."base" IS NOT NULL
  AND c."base" <> '0'
  AND EXISTS (SELECT 1 FROM "listas_venta" l WHERE l.id::text = c."base");--> statement-breakpoint

ALTER TABLE "ofertas" DROP COLUMN IF EXISTS "solo_precio_base";
