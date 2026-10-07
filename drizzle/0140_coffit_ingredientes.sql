-- ===========================================================================
-- 0140 · COFFIT: INGREDIENTES CON COSTO CONVERTIDO (6/10/2026, pedido del dueño)
-- ===========================================================================
-- Los productos que Coffit usa como ingrediente, elegidos a mano, con lo que
-- trae cada envase (200 g, 2 kg, 1 L) y en qué unidad se quiere el costo
-- (kg, g, 100 g, L, ml, 100 ml o unidad). El costo NO se guarda: se calcula
-- cada vez del último comprobante con precio real (factura con IVA, remito
-- sin IVA), así se actualiza solo con cada factura nueva.
CREATE TABLE IF NOT EXISTS "coffit_ingredientes" (
  "id" serial PRIMARY KEY,
  "producto_id" integer NOT NULL REFERENCES "productos"("id") ON DELETE CASCADE,
  "contenido" double precision,
  "contenido_unidad" text NOT NULL DEFAULT 'g' CHECK ("contenido_unidad" IN ('g', 'kg', 'ml', 'l')),
  "unidad_costo" text NOT NULL DEFAULT 'kg' CHECK ("unidad_costo" IN ('kg', 'g', '100g', 'l', 'ml', '100ml', 'u')),
  "nota" text NOT NULL DEFAULT '',
  "creado_en" timestamp with time zone NOT NULL DEFAULT now(),
  "actualizado_en" timestamp with time zone NOT NULL DEFAULT now(),
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_coffit_ingrediente_producto" ON "coffit_ingredientes" ("producto_id");
