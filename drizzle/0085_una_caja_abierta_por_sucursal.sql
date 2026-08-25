-- UNA SOLA CAJA ABIERTA POR SUCURSAL (25/8/2026).
--
-- El chequeo de "ya hay un turno abierto" era un select suelto fuera de
-- transaccion: con un doble clic en Abrir caja entraban DOS turnos abiertos en
-- la misma sucursal, y desde ahi cada venta/cobranza elegia uno u otro segun
-- el orden de lectura -- dos arqueos que no cierran nunca.
--
-- El candado va EN LA BASE (indice unico parcial sobre las abiertas): ninguna
-- carrera de la aplicacion puede ganarle a un unique. El codigo atrapa el
-- choque y contesta el mismo mensaje amable del chequeo previo.
--
-- Si una base ya tuviera el dano hecho (dos abiertas en la misma sucursal), el
-- CREATE fallaria: primero se cierra la mas vieja de cada par con arqueo en
-- cero y una observacion que cuenta por que.
UPDATE caja_sesiones c SET
  estado = 'cerrada',
  cierre = now(),
  observaciones = trim(observaciones || ' ' ||
    '[Cerrada automaticamente el 25/8/2026: habia dos turnos abiertos en la misma sucursal y quedo el mas nuevo.]')
WHERE c.estado = 'abierta'
  AND EXISTS (
    SELECT 1 FROM caja_sesiones otra
    WHERE otra.sucursal_id = c.sucursal_id
      AND otra.estado = 'abierta'
      AND otra.id > c.id
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_caja_abierta_por_sucursal"
  ON "caja_sesiones" ("sucursal_id")
  WHERE "estado" = 'abierta';
