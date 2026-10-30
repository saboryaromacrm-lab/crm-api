-- 0208 · UN DESCUENTO CON VARIOS MEDIOS DE PAGO (30/10/2026, pedido del dueño: «que se puedan
-- seleccionar varios métodos de pago» en «Solo con»). `medios_pago` es la lista separada por comas,
-- igual que en los cupones ('' = cualquier forma de pago). La regla no cambia: al contado y TODO el
-- pago con medios de esa lista (se puede repartir entre ellos).
-- `medio_pago` queda SIN USO: no se borra acá porque Dokploy migra antes de cambiar el contenedor y
-- el código viejo la sigue leyendo un rato. Borrarla en una migración posterior.
ALTER TABLE descuentos ADD COLUMN medios_pago text NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE descuentos SET medios_pago = medio_pago::text WHERE medio_pago IS NOT NULL;
