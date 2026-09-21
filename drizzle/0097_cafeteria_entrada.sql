-- EL CAMINO DE VUELTA DE LA CAFETERÍA (21/9/2026, pedido del dueño).
--
-- Hasta hoy la mercadería iba en una sola dirección: la distribuidora le
-- enviaba al café, a costo congelado. Ahora el café también manda **lo que
-- elabora** —medialunas, sándwiches, café molido— a una sucursal, para
-- venderse en el mostrador como cualquier otro producto.
--
-- NO ES UNA TABLA NUEVA, y eso es la decisión de fondo: el documento es el
-- MISMO en los dos sentidos (cabecera, renglones, remito, versión, anulación).
-- Lo único que cambia es de qué lado se mueve el stock y de dónde sale el
-- costo. Duplicar la tabla habría duplicado el remito, el editar, el anular, la
-- métrica y el sync — cinco lugares que después hay que acordarse de cambiar
-- juntos, y el quinto es el que se olvida.
ALTER TYPE "tipo_movimiento" ADD VALUE IF NOT EXISTS 'ingreso_cafeteria';--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "sentido_envio_cafe" AS ENUM ('salida', 'entrada');
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- `salida` por defecto: es exactamente lo que son todos los envíos que ya
-- existen, así que la historia queda bien clasificada sin tocar una fila.
ALTER TABLE "envios_cafeteria" ADD COLUMN IF NOT EXISTS "sentido" "sentido_envio_cafe" NOT NULL DEFAULT 'salida';--> statement-breakpoint

-- El costo de una ENTRADA lo declara la cafetería renglón por renglón: es la
-- única que lo sabe (la medialuna la hizo ella). `costo_unitario` ya existe en
-- el renglón y se reutiliza tal cual — lo que cambia es quién lo llena.

-- LA LISTA BLANCA de lo que una entrada puede traer. Sin esto, cualquiera
-- podría mandar harina "desde la cafetería" con un costo declarado a dedo, y
-- ese costo pisaría el costo real del proveedor en la rentabilidad.
ALTER TABLE "productos" ADD COLUMN IF NOT EXISTS "origen_cafeteria" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- El panel separa los dos sentidos y la métrica los suma por separado: las dos
-- consultas entran por acá.
CREATE INDEX IF NOT EXISTS "ix_envios_cafe_sentido" ON "envios_cafeteria" ("sentido", "estado", "fecha");--> statement-breakpoint

-- ── Llaves ──────────────────────────────────────────────────────────────────
-- El rol Cafetería carga SUS envíos (los de entrada) y no toca los que salen
-- de la distribuidora: por eso es una llave propia y no la de `almacen.cafeteria`.
UPDATE "roles" SET "permisos" = "permisos" || '["almacen.cafeteria-entradas"]'::jsonb
WHERE "clave" IN ('admin', 'cafeteria') AND NOT ("permisos" ? 'almacen.cafeteria-entradas');
