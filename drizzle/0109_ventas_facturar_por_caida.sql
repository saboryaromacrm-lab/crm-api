-- ===========================================================================
-- 0109 · POR QUE QUEDO SIN FACTURAR: ARCA CAIDO O RECHAZO (26/9/2026)
-- ===========================================================================
-- Una venta queda "pendiente de facturar" por dos causas muy distintas:
--   - ARCA no respondio (caido, sin red): se reintenta igual y sale;
--   - ARCA RECHAZO por un dato (factura A sin CUIT, receptor invalido): el
--     reintento va a fallar igual hasta corregir el dato.
-- El ticket impreso y la seccion "Caidas por ARCA" las tienen que distinguir:
-- decirle "servicio caido" al cliente de un rechazo seria mentirle.
-- true por defecto: las pendientes viejas son, en la practica, caidas.
-- ===========================================================================

ALTER TABLE "ventas" ADD COLUMN IF NOT EXISTS "facturar_por_caida" boolean NOT NULL DEFAULT true;
