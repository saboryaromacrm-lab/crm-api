-- ===========================================================================
-- 0218 · AJUSTES DE MARKUP CON «DESHACER» (4/11/2026, pedido del dueño)
-- ===========================================================================
-- «Quiero ajustar markups en alguna lista de precios a productos fraccionados
-- y a determinadas marcas y proveedores.» Cada ajuste masivo de Listas de
-- precios queda guardado con el markup de antes y el de después de cada fila
-- de `producto_listas`, quién lo hizo y cuándo, para poder DESHACERLO entero.
--
-- `filas`: [{ "id": producto_listas.id, "antes": 40, "despues": 45 }]. El
-- deshacer solo vuelve las filas que siguen con el markup que dejó el ajuste
-- (una que alguien cambió después no se pisa).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS "ajustes_markup" (
  "id" serial PRIMARY KEY,
  "creado_en" timestamptz NOT NULL DEFAULT now(),
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "descripcion" text NOT NULL DEFAULT '',
  "filas" jsonb NOT NULL,
  "deshecho_en" timestamptz,
  "deshecho_por" integer REFERENCES "usuarios"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "ix_ajustes_markup_creado" ON "ajustes_markup" ("creado_en" DESC);
