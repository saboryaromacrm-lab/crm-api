-- ===========================================================================
-- 0104 · EL CAJERO COBRA CUENTAS CORRIENTES (25/9/2026, decision del dueno)
-- ===========================================================================
-- El cajero podia VENDER a cuenta corriente pero no COBRARLA: la cobranza pide
-- la seccion `ventas.cobranzas` y el rol no la tenia. El cliente que volvia a
-- pagar al mostrador no tenia como hacerlo.
--
-- La cobranza del cajero queda con los mismos candados de la venta: la
-- sucursal sale de su sesion, el efectivo entra a SU turno abierto, ve solo
-- los recibos de su sucursal y anular exige motivo y turno sin cerrar.
-- ===========================================================================

UPDATE "roles" SET "permisos" = "permisos" || '["ventas.cobranzas"]'::jsonb
WHERE "clave" = 'cajero' AND NOT ("permisos" ? 'ventas.cobranzas');
