-- FORMATO DE VENTA: el markup y las condiciones bajan de la lista al producto.
--
-- Antes la lista llevaba el markup y `producto_listas` guardaba solo las
-- excepciones. El negocio no funciona así: la misma lista "Mayorista 1" va al
-- 30% en un producto y al 50% en otro. Ahora la fila producto × lista ES el
-- formato de venta, y la lista queda como pura identidad.
--
-- La migración MATERIALIZA la herencia antes de borrar nada: lo que hoy se
-- deduce de la lista se escribe en cada producto, para que ningún precio
-- cambie al aplicar esto.

-- Nuevos orígenes: por qué un renglón terminó con la lista que tiene.
ALTER TYPE "public"."origen_lista" ADD VALUE IF NOT EXISTS 'marca';--> statement-breakpoint
ALTER TYPE "public"."origen_lista" ADD VALUE IF NOT EXISTS 'monto';--> statement-breakpoint

ALTER TABLE "producto_listas" ADD COLUMN IF NOT EXISTS "unidades_minimas" double precision;--> statement-breakpoint

-- 1) Las filas que ya existían (excepciones) absorben lo que heredaban.
UPDATE "producto_listas" pl SET
  "markup" = COALESCE(pl."markup", l."markup"),
  "unidades_minimas" = CASE
    WHEN COALESCE(pl."condicion_tipo", l."condicion_tipo") = 'unidades_producto'
      THEN COALESCE(pl."condicion_valor", l."condicion_valor")
    ELSE 0 END
FROM "listas_venta" l WHERE l."id" = pl."lista_id";--> statement-breakpoint

-- 2) Lo que participaba por herencia (`disponible_por_defecto`) y no tenía fila,
--    ahora la necesita: sin fila, el producto deja de venderse en esa lista.
INSERT INTO "producto_listas" ("producto_id", "lista_id", "markup", "unidades_minimas")
SELECT p."id", l."id", l."markup",
       CASE WHEN l."condicion_tipo" = 'unidades_producto' THEN l."condicion_valor" ELSE 0 END
FROM "productos" p CROSS JOIN "listas_venta" l
WHERE l."disponible_por_defecto" = true
  AND NOT EXISTS (
    SELECT 1 FROM "producto_listas" x
    WHERE x."producto_id" = p."id" AND x."lista_id" = l."id"
  );--> statement-breakpoint

-- 3) Las excepciones que decían "acá no se vende" ya no se representan con una
--    bandera: se representan con la ausencia de la fila.
DELETE FROM "producto_listas" WHERE "disponible" = false;--> statement-breakpoint

-- 4) La condición por marca era global disfrazada de condición de lista. Se
--    promueve a su propia tabla, tomando las marcas que de hecho la usaban.
CREATE TABLE IF NOT EXISTS "reglas_marca" (
  "id" serial PRIMARY KEY NOT NULL,
  "marca" text NOT NULL,
  "unidades_minimas" double precision DEFAULT 0 NOT NULL,
  "modalidad_id" integer NOT NULL REFERENCES "modalidades_venta"("id") ON DELETE cascade,
  "activa" boolean DEFAULT true NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_regla_marca" ON "reglas_marca" ("marca","modalidad_id");--> statement-breakpoint

INSERT INTO "reglas_marca" ("marca", "unidades_minimas", "modalidad_id")
SELECT p."marca", MIN(l."condicion_valor"), l."modalidad_id"
FROM "producto_listas" pl
JOIN "listas_venta" l ON l."id" = pl."lista_id"
JOIN "productos" p ON p."id" = pl."producto_id"
WHERE l."condicion_tipo" = 'unidades_marca' AND COALESCE(p."marca", '') <> ''
GROUP BY p."marca", l."modalidad_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- 5) Recién ahora se puede tirar lo viejo: ya no queda información solo en la lista.
UPDATE "producto_listas" SET "markup" = 0 WHERE "markup" IS NULL;--> statement-breakpoint
UPDATE "producto_listas" SET "unidades_minimas" = 0 WHERE "unidades_minimas" IS NULL;--> statement-breakpoint
ALTER TABLE "producto_listas" ALTER COLUMN "markup" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "producto_listas" ALTER COLUMN "markup" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "producto_listas" ALTER COLUMN "unidades_minimas" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "producto_listas" ALTER COLUMN "unidades_minimas" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "producto_listas" DROP COLUMN IF EXISTS "condicion_tipo";--> statement-breakpoint
ALTER TABLE "producto_listas" DROP COLUMN IF EXISTS "condicion_valor";--> statement-breakpoint
ALTER TABLE "producto_listas" DROP COLUMN IF EXISTS "disponible";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_producto_listas_producto" ON "producto_listas" ("producto_id");--> statement-breakpoint

ALTER TABLE "listas_venta" DROP COLUMN IF EXISTS "markup";--> statement-breakpoint
ALTER TABLE "listas_venta" DROP COLUMN IF EXISTS "condicion_tipo";--> statement-breakpoint
ALTER TABLE "listas_venta" DROP COLUMN IF EXISTS "condicion_valor";--> statement-breakpoint
ALTER TABLE "listas_venta" DROP COLUMN IF EXISTS "disponible_por_defecto";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."condicion_lista";
