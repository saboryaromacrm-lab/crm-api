-- GERENCIA › STOCK VALORIZADO · LA FOTO DE CADA NOCHE (17/11/2026): el stock
-- valorizado de cada día que cerró, como quedó (ver src/metricas/fotos.ts).
-- `detalle`: [[producto_id, sucursal_id, cantidad base, plata], …]; se guarda
-- del último día de cada mes y de los últimos 62 días.
CREATE TABLE IF NOT EXISTS "stock_fotos" (
  "dia" date PRIMARY KEY,
  "hecha_en" timestamptz NOT NULL DEFAULT now(),
  "valor" numeric(16, 2) NOT NULL DEFAULT 0,
  "valor_coffit" numeric(16, 2) NOT NULL DEFAULT 0,
  "valor_parado" numeric(16, 2) NOT NULL DEFAULT 0,
  "articulos" integer NOT NULL DEFAULT 0,
  "por_sucursal" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "detalle" jsonb
);
