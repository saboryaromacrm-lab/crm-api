-- ===========================================================================
-- 0139 · EL QR DE MERCADO PAGO TIENE SU PROPIO «EXIGE FACTURA» (5/10/2026)
-- ===========================================================================
-- Hasta hoy el QR de Mercado Pago compartía la regla con «QR / billetera»
-- (los dos se guardan como 'qr'). Desde ahora es su propio medio en la
-- configuración: 'qr_mp'. Para que NADA cambie al subir, donde «QR /
-- billetera» exigía factura, el QR de Mercado Pago sigue exigiéndola; el
-- dueño después lo destilda o lo deja, cada uno por separado.
UPDATE "configuracion"
SET "valor" = jsonb_set("valor", '{mediosFacturar}', ("valor"->'mediosFacturar') || '["qr_mp"]'::jsonb)
WHERE "clave" = 'ventas'
  AND jsonb_typeof("valor"->'mediosFacturar') = 'array'
  AND ("valor"->'mediosFacturar') ? 'qr'
  AND NOT (("valor"->'mediosFacturar') ? 'qr_mp');
