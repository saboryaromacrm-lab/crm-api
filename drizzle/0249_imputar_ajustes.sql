-- AJUSTES AL DEBE QUE SE PAGAN (27/11/2026, pedido del dueño). En 3 ARROYOS cargó la deuda del sistema
-- anterior como ajuste al debe (11/11), pagada con la cuenta disponible de octubre; pero la cuenta libre
-- solo sabía aplicar pagos a facturas, así que esos pagos fueron a la liquidación del 24/11 y la dejaron
-- «casi pagada». Desde ahora un ajuste al debe es deuda como una factura: en cuenta libre se paga por fecha.
ALTER TABLE proveedor_imputaciones ADD COLUMN IF NOT EXISTS ajuste_id integer REFERENCES proveedor_ajustes(id) ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ix_prov_imput_ajuste ON proveedor_imputaciones (ajuste_id);
--> statement-breakpoint
-- Cada aplicación sigue yendo a UN solo documento: ahora puede ser también un ajuste.
ALTER TABLE proveedor_imputaciones DROP CONSTRAINT IF EXISTS ck_prov_imput_un_documento;
--> statement-breakpoint
ALTER TABLE proveedor_imputaciones ADD CONSTRAINT ck_prov_imput_un_documento
  CHECK ((gasto_id IS NOT NULL)::int + (comprobante_id IS NOT NULL)::int + (ajuste_id IS NOT NULL)::int = 1);
--> statement-breakpoint
-- Lo ya aplicado se reacomoda SOLO en 3 ARROYOS (lo pidió así): los pagos de la liquidación X 0001-00000002
-- pasan a su ajuste. Únicamente si cierra exacto (lo aplicado = el ajuste, y el ajuste sin pagos todavía);
-- si no, no toca nada. El saldo del proveedor no cambia: cambia qué documento figura pagado.
DO $$
DECLARE
  v_prov integer; v_liq integer; v_aj integer; v_aj_imp double precision; v_aj_fecha timestamptz;
  v_aplicado double precision;
BEGIN
  SELECT id INTO v_prov FROM proveedores WHERE upper(trim(nombre)) = '3 ARROYOS';
  IF v_prov IS NULL THEN RETURN; END IF;

  SELECT id INTO v_liq FROM comprobantes
   WHERE proveedor_id = v_prov AND tipo = 'liquidacion' AND estado = 'confirmado'
     AND letra = 'X' AND punto_venta = '0001' AND numero = 2;
  SELECT id, importe, fecha INTO v_aj, v_aj_imp, v_aj_fecha FROM proveedor_ajustes
   WHERE proveedor_id = v_prov AND importe > 0 AND motivo ILIKE '%pago anterior sistema%';
  IF v_liq IS NULL OR v_aj IS NULL THEN RETURN; END IF;
  IF (SELECT count(*) FROM proveedor_ajustes WHERE proveedor_id = v_prov AND importe > 0 AND motivo ILIKE '%pago anterior sistema%') <> 1 THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM proveedor_imputaciones WHERE ajuste_id = v_aj) THEN RETURN; END IF;

  SELECT coalesce(sum(i.importe), 0) INTO v_aplicado
    FROM proveedor_imputaciones i JOIN proveedor_pagos p ON p.id = i.pago_id
   WHERE i.comprobante_id = v_liq AND p.estado = 'activo';
  IF abs(v_aplicado - v_aj_imp) > 0.01 THEN RETURN; END IF;

  UPDATE proveedor_imputaciones i SET comprobante_id = NULL, ajuste_id = v_aj
    FROM proveedor_pagos p
   WHERE p.id = i.pago_id AND i.comprobante_id = v_liq AND p.estado = 'activo';

  UPDATE comprobantes SET
    pagado = (SELECT coalesce(sum(i.importe), 0) FROM proveedor_imputaciones i JOIN proveedor_pagos p ON p.id = i.pago_id
               WHERE i.comprobante_id = v_liq AND p.estado = 'activo'),
    observaciones = concat_ws(E'\n', nullif(observaciones, ''),
      '27/11/2026: los pagos de la cuenta disponible de octubre ($'
      || translate(to_char(v_aj_imp, 'FM999,999,990.00'), ',.', '.,') || ') '
      || 'se pasaron al ajuste del ' || to_char(v_aj_fecha AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY')
      || ' (deuda del sistema anterior), que es lo que pagaban. Antes el sistema los había aplicado a esta liquidación.')
   WHERE id = v_liq;
END $$;
