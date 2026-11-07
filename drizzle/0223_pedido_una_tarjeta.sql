-- ===========================================================================
-- 0223 · UNA SOLA TARJETA ABIERTA POR PROVEEDOR EN PEDIDOS (7/11/2026)
-- ===========================================================================
-- «Se están mezclando mucho los pedidos, quedan muchos repetidos: queda el que
-- creás con la orden de pedido y el de Solicitado.» La orden de pedido creaba
-- su tarjeta en «Pedido» aunque el proveedor ya tuviera la suya en
-- «Solicitado»; desde ahora usa esa (la API, `pedidos.module.ts`).
--
-- Acá: las repetidas que ya hay se juntan en una — se queda la más avanzada
-- (Pedido, después Solicitado, después Para retomar; entre iguales, la más
-- vieja), con las notas de todas, la fecha de alta más vieja y, si está en
-- Pedido, el primer día que se pidió — y el índice impide que vuelva a pasar.
-- Lo recibido es historial y no cuenta.
-- ===========================================================================
-- El orden (estado, id) no cambia con el UPDATE: el DELETE vuelve a elegir la misma.
WITH a AS (
  SELECT "id", "proveedor_id", "notas", "fecha_alta", "fecha_pedido",
         row_number() OVER (PARTITION BY "proveedor_id"
           ORDER BY CASE "estado" WHEN 'pedido' THEN 0 WHEN 'solicitado' THEN 1 ELSE 2 END, "id") AS "n",
         count(*) OVER (PARTITION BY "proveedor_id") AS "cuantas"
    FROM "pedidos_proveedor" WHERE "estado" <> 'recibido'
), j AS (
  SELECT "proveedor_id",
         coalesce(string_agg(nullif(trim("notas"), ''), E'\n\n' ORDER BY "id"), '') AS "notas",
         min("fecha_alta") AS "fecha_alta",
         min("fecha_pedido") AS "fecha_pedido"
    FROM a WHERE "cuantas" > 1 GROUP BY "proveedor_id"
)
UPDATE "pedidos_proveedor" p
   SET "notas" = j."notas",
       "fecha_alta" = j."fecha_alta",
       "fecha_pedido" = CASE WHEN p."estado" = 'pedido' THEN coalesce(j."fecha_pedido", p."fecha_pedido") ELSE p."fecha_pedido" END
  FROM j, a
 WHERE a."proveedor_id" = j."proveedor_id" AND a."n" = 1 AND p."id" = a."id";
--> statement-breakpoint
WITH a AS (
  SELECT "id",
         row_number() OVER (PARTITION BY "proveedor_id"
           ORDER BY CASE "estado" WHEN 'pedido' THEN 0 WHEN 'solicitado' THEN 1 ELSE 2 END, "id") AS "n"
    FROM "pedidos_proveedor" WHERE "estado" <> 'recibido'
)
DELETE FROM "pedidos_proveedor" p USING a WHERE p."id" = a."id" AND a."n" > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_pedidos_proveedor_abierta" ON "pedidos_proveedor" ("proveedor_id") WHERE "estado" <> 'recibido';
