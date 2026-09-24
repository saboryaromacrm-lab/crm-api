-- ===========================================================================
-- 0103 · STOCK DE PRACTICA: 200 kg a cada granel (24/9/2026, pedido del dueno)
-- ===========================================================================
-- Para que el equipo practique fraccionar en produccion antes de arrancar de
-- verdad. NO es mercaderia real: no tiene factura ni costo, y por eso cada
-- movimiento queda marcado con el motivo 'PRACTICA 0103' — se puede encontrar
-- y sacar entero. La salida prevista es la "Limpieza de fin de practica"
-- (Sistema > Respaldos, superadmin), que vacia stock y movimientos.
--
-- Decisiones del dueno:
--   · 200 kg de granel suelto DISPONIBLE, en la distribuidora (Deposito
--     Central), que es donde se fracciona.
--   · COMPLETA HASTA 200, no suma: el que tiene 50 recibe 150; el que ya
--     tiene 200 o mas no se toca.
--   · Solo productos a granel ACTIVOS: un archivado con stock es un estado
--     imposible, y un discontinuado no se vuelve a comprar.
--
-- Sin unicidad en `stock` (ver liberarReservas): se suma sobre la fila
-- disponible que ya existe (la de menor id) y solo se inserta si no hay
-- ninguna — nunca una fila hermana, que el resto del sistema no veria.
-- El trigger de `stock` (0094) avisa solo a las pantallas abiertas.
-- ===========================================================================

CREATE TEMP TABLE "practica_0103" ON COMMIT DROP AS
SELECT p.id AS producto_id,
       d.id AS sucursal_id,
       round((200 - COALESCE(s.hay, 0))::numeric, 3)::double precision AS kg
FROM "productos" p
CROSS JOIN (SELECT id FROM "sucursales" WHERE tipo = 'distribuidora' ORDER BY id LIMIT 1) d
LEFT JOIN LATERAL (
  SELECT SUM(cantidad) AS hay FROM "stock"
  WHERE producto_id = p.id AND sucursal_id = d.id AND presentacion_id IS NULL AND estado = 'disponible'
) s ON true
WHERE p.tipo = 'granel' AND p.estado = 'activo' AND COALESCE(s.hay, 0) < 200 - 0.0005;
--> statement-breakpoint

UPDATE "stock" st SET cantidad = st.cantidad + f.kg
FROM "practica_0103" f
WHERE st.id = (
  SELECT min(x.id) FROM "stock" x
  WHERE x.producto_id = f.producto_id AND x.sucursal_id = f.sucursal_id
    AND x.presentacion_id IS NULL AND x.estado = 'disponible'
);
--> statement-breakpoint

INSERT INTO "stock" (producto_id, sucursal_id, presentacion_id, estado, cantidad)
SELECT f.producto_id, f.sucursal_id, NULL, 'disponible', f.kg
FROM "practica_0103" f
WHERE NOT EXISTS (
  SELECT 1 FROM "stock" x
  WHERE x.producto_id = f.producto_id AND x.sucursal_id = f.sucursal_id
    AND x.presentacion_id IS NULL AND x.estado = 'disponible'
);
--> statement-breakpoint

INSERT INTO "movimientos" (tipo, producto_id, sucursal_id, signo, cantidad, unidad, estado_hacia, motivo, descripcion)
SELECT 'ajuste', f.producto_id, f.sucursal_id, 1, f.kg, 'kg', 'disponible',
       'PRACTICA 0103',
       'Stock de practica (sin factura ni costo): completa el granel a 200 kg (+' || f.kg || ' kg)'
FROM "practica_0103" f;
