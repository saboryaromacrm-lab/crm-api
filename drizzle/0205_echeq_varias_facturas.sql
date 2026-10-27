-- 0205 · UN ECHEQ CUBRE UNA O VARIAS FACTURAS (27/10/2026, pedido del dueño: «muchas veces un
-- mismo echeq cubre dos facturas o más», y la factura llega días después del echeq).
-- El vínculo se da vuelta: antes cada echeq apuntaba a UN compromiso (`compromiso_id`); ahora cada
-- compromiso dice de qué echeq es (`echeq_id`), así un echeq tiene un compromiso por factura que
-- cubre. Y `es_echeq` deja de ser un dato aparte: un compromiso es de echeq si tiene su echeq. Dos
-- datos que dicen lo mismo terminan contradiciéndose.
ALTER TABLE proveedor_compromisos ADD COLUMN echeq_id integer REFERENCES proveedor_echeqs(id) ON DELETE SET NULL;
--> statement-breakpoint
-- El echeq vivo (o cobrado) de cada compromiso que era de echeq. El que no tiene ninguno quedaba en
-- el limbo —fuera de Cuentas corrientes y sin echeq en la cartera—: pasa a deuda común.
UPDATE proveedor_compromisos k SET echeq_id = e.id
FROM (
  SELECT DISTINCT ON (compromiso_id) id, compromiso_id FROM proveedor_echeqs
  WHERE compromiso_id IS NOT NULL AND estado <> 'anulado'
  ORDER BY compromiso_id, id DESC
) e
WHERE e.compromiso_id = k.id AND k.es_echeq;
--> statement-breakpoint
CREATE INDEX ix_compromisos_echeq ON proveedor_compromisos (echeq_id);
--> statement-breakpoint
ALTER TABLE proveedor_echeqs DROP COLUMN compromiso_id;
--> statement-breakpoint
ALTER TABLE proveedor_compromisos DROP COLUMN es_echeq;
