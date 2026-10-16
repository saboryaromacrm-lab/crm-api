-- ===========================================================================
-- 0173 · TIENDA MINORISTA (16/10/2026)
-- ===========================================================================
-- Pedido del dueño: la misma tienda con dos modos, Minorista y Mayorista.
--   · Cada orden web dice de qué modo vino (`modo_tienda`); las anteriores
--     eran todas mayoristas.
--   · El comprador minorista no se registra ni se aprueba: su TELÉFONO es la
--     clave. Se guardan nombre, apellido y dirección para que la próxima vez
--     ponga el teléfono y ya tenga todo cargado.
-- ===========================================================================
ALTER TABLE "presupuestos" ADD COLUMN IF NOT EXISTS "modo_tienda" text;
--> statement-breakpoint
ALTER TABLE "presupuestos" DROP CONSTRAINT IF EXISTS "presupuestos_modo_tienda_check";
--> statement-breakpoint
ALTER TABLE "presupuestos" ADD CONSTRAINT "presupuestos_modo_tienda_check" CHECK ("modo_tienda" IS NULL OR "modo_tienda" IN ('mayorista', 'minorista'));
--> statement-breakpoint
UPDATE "presupuestos" SET "modo_tienda" = 'mayorista' WHERE "origen" = 'web' AND "modo_tienda" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tienda_compradores" (
  "id" serial PRIMARY KEY,
  "telefono" text NOT NULL UNIQUE,
  "nombre" text NOT NULL DEFAULT '',
  "apellido" text NOT NULL DEFAULT '',
  "direccion" text NOT NULL DEFAULT '',
  "localidad" text NOT NULL DEFAULT '',
  "referencia" text NOT NULL DEFAULT '',
  "pedidos" integer NOT NULL DEFAULT 0,
  "creado_en" timestamptz NOT NULL DEFAULT now(),
  "actualizado_en" timestamptz NOT NULL DEFAULT now()
);
