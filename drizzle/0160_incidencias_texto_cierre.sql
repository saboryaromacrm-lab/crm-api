-- ===========================================================================
-- 0160 · EL TEXTO DE LAS VENTAS SIN STOCK CERRADAS EN BLOQUE (12/10/2026)
-- ===========================================================================
-- Las cerradas en bloque decían «anterior al control de stock de este
-- producto» aunque ese producto NUNCA se hubiera controlado en la sucursal, y
-- el dueño lo leyó como un control que no hizo. Se reescribe solo ese tramo
-- del motivo, con el caso real de cada una al momento del cierre:
--   · hubo un control o un ajuste antes de cerrarla → «la venta fue antes del
--     último control»;
--   · no hubo ninguno → «nunca se controló».
-- Se mira la historia (controles aplicados, ajustes a mano y ajustes de
-- ventas sin stock), no `stock_controlado`, que guarda solo el último.
-- No toca stock ni estados: solo el texto.
-- ===========================================================================
UPDATE "incidencias" i
   SET "motivo" = replace(i."motivo",
     'anterior al control de stock de este producto (no se tocó el stock).',
     CASE WHEN EXISTS (
            SELECT 1 FROM "conteo_items" ci JOIN "conteos" c ON c.id = ci.conteo_id
             WHERE c.estado = 'aplicado' AND c.sucursal_id = i.sucursal_id AND ci.producto_id = i.producto_id
               AND COALESCE(ci.presentacion_id, 0) = COALESCE(i.presentacion_id, 0)
               AND ci.contado IS NOT NULL AND c.aplicado_en <= i.fecha_resolucion)
          OR EXISTS (
            SELECT 1 FROM "movimientos" m
             WHERE m.tipo = 'ajuste' AND m.sucursal_id = i.sucursal_id AND m.producto_id = i.producto_id
               AND COALESCE(m.presentacion_id, 0) = COALESCE(i.presentacion_id, 0) AND m.fecha <= i.fecha_resolucion
               AND ((m.signo <> 0 AND m.descripcion LIKE 'Ajuste %'
                     AND m.ref_conteo_id IS NULL AND m.ref_incidencia_id IS NULL AND m.ref_transferencia_id IS NULL)
                 OR EXISTS (SELECT 1 FROM "incidencias" x WHERE x.id = m.ref_incidencia_id AND x.tipo = 'venta_sin_stock')))
       THEN 'la venta fue antes del último control de stock de este producto (no se tocó el stock).'
       ELSE 'el stock de este producto en ' || COALESCE((SELECT s.nombre FROM "sucursales" s WHERE s.id = i.sucursal_id), 'esta sucursal')
         || ' nunca se controló, así que el sistema no tenía el número real (no se tocó el stock).'
     END)
 WHERE i.resolucion = 'anterior_control'
   AND i.motivo LIKE '%anterior al control de stock de este producto (no se tocó el stock).%';
