-- ===========================================================================
-- 0159 · STOCK CONTROLADO (12/10/2026)
-- ===========================================================================
-- Pedido del dueño: empezó a vender con el stock real y las ventas sin stock
-- de antes lo confunden. Una venta sin stock SOLO dice algo si el stock de
-- ese producto era confiable cuando se vendió: si nunca se contó, el negativo
-- es del número cargado, no de la góndola.
--
-- Esta tabla guarda, por sucursal y por forma (producto + presentación), la
-- ÚLTIMA vez que su stock quedó en lo real:
--
--   · un control de stock aplicado (cada renglón contado, haya o no diferencia);
--   · un ajuste a mano;
--   · el ajuste con el que se resolvió una venta sin stock (se contó la góndola).
--
-- Con ella:
--   · una venta sin stock de algo que nunca se controló NO crea incidencia;
--   · al controlar/ajustar, las ventas sin stock abiertas de esa forma se
--     cierran solas (el stock ya se puso en lo real después de la venta);
--   · las abiertas anteriores al último control se pueden cerrar en bloque.
--
-- Es un dato derivado (no es historia): se borra con su producto, presentación
-- o sucursal.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS "stock_controlado" (
  "sucursal_id" integer NOT NULL REFERENCES "sucursales"("id") ON DELETE CASCADE,
  "producto_id" integer NOT NULL REFERENCES "productos"("id") ON DELETE CASCADE,
  "presentacion_id" integer REFERENCES "presentaciones"("id") ON DELETE CASCADE,
  "fecha" timestamp with time zone NOT NULL DEFAULT now(),
  "origen" text NOT NULL DEFAULT ''
);
--> statement-breakpoint
-- COALESCE porque dos NULL no chocan en un UNIQUE: la madre es UNA fila.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_stock_controlado" ON "stock_controlado" ("sucursal_id", "producto_id", (COALESCE("presentacion_id", 0)));
--> statement-breakpoint
-- Lo que ya pasó cuenta: controles aplicados, ajustes a mano y ajustes de
-- ventas sin stock. Por forma, el más reciente.
INSERT INTO "stock_controlado" ("sucursal_id", "producto_id", "presentacion_id", "fecha", "origen")
SELECT DISTINCT ON (x.sucursal_id, x.producto_id, COALESCE(x.presentacion_id, 0))
       x.sucursal_id, x.producto_id, x.presentacion_id, x.fecha, x.origen
  FROM (
    SELECT c.sucursal_id, ci.producto_id, ci.presentacion_id, c.aplicado_en AS fecha,
           'el control de stock «' || COALESCE(NULLIF(c.nombre, ''), '#' || c.id) || '»' AS origen
      FROM "conteo_items" ci
      JOIN "conteos" c ON c.id = ci.conteo_id
     WHERE c.estado = 'aplicado' AND c.aplicado_en IS NOT NULL AND ci.contado IS NOT NULL
    UNION ALL
    SELECT m.sucursal_id, m.producto_id, m.presentacion_id, m.fecha, 'un ajuste a mano'
      FROM "movimientos" m
     WHERE m.tipo = 'ajuste' AND m.signo <> 0 AND m.descripcion LIKE 'Ajuste %'
       AND m.ref_conteo_id IS NULL AND m.ref_incidencia_id IS NULL AND m.ref_transferencia_id IS NULL
    UNION ALL
    SELECT m.sucursal_id, m.producto_id, m.presentacion_id, m.fecha, 'el ajuste de ' || i.codigo
      FROM "movimientos" m
      JOIN "incidencias" i ON i.id = m.ref_incidencia_id
     WHERE m.tipo = 'ajuste' AND i.tipo = 'venta_sin_stock'
  ) x
 WHERE x.sucursal_id IS NOT NULL AND x.producto_id IS NOT NULL
 ORDER BY x.sucursal_id, x.producto_id, COALESCE(x.presentacion_id, 0), x.fecha DESC
ON CONFLICT DO NOTHING;
