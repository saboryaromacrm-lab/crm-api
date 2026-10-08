-- ===========================================================================
-- 0148 · LO QUE ELABORA COFFIT: MARCA PROPIA Y PRECIO DE SABOR Y AROMA (8/10/2026)
-- ===========================================================================
-- Pedido del dueño: Coffit manda sus productos a costo y el precio lo pone
-- Sabor y Aroma (fijo, viendo el markup que da, o por markup sobre el costo
-- de Coffit). Para verlos aparte de lo propio en Métricas, Rentabilidad y
-- Sin movimiento, todos llevan la marca «Coffit».
-- Acá: la marca (si no existe) y los productos de Coffit que ya están cargados.
-- Los nuevos la reciben al darse de alta (cafeteria.module).
-- ===========================================================================
INSERT INTO "marcas" ("nombre")
SELECT 'Coffit' WHERE NOT EXISTS (SELECT 1 FROM "marcas" WHERE lower("nombre") = 'coffit');
--> statement-breakpoint
UPDATE "productos"
   SET "marca_id" = (SELECT "id" FROM "marcas" WHERE lower("nombre") = 'coffit' ORDER BY "id" LIMIT 1)
 WHERE "origen_cafeteria" = true;
