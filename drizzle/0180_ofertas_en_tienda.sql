-- ===========================================================================
-- 0180 · MÉTRICAS DE LAS OFERTAS EN LA TIENDA ONLINE (18/10/2026)
-- ===========================================================================
-- Pedido del dueño: «medir bien si las ofertas son realmente buenas en la
-- tienda, cómo son recibidas». Para eso cada renglón de un pedido web guarda
-- QUÉ oferta lo cotizó (antes solo el nombre, que puede repetirse), y cada
-- evento de la telemetría (producto mirado, agregado al carrito) dice con qué
-- oferta estaba publicado el producto en ese momento (lo pone el servidor
-- desde el catálogo armado). Los renglones viejos se enganchan por nombre
-- cuando ese nombre es de una sola oferta.
-- ===========================================================================
ALTER TABLE presupuesto_items ADD COLUMN oferta_id integer REFERENCES ofertas(id) ON DELETE SET NULL;
CREATE INDEX ix_presupuesto_items_oferta ON presupuesto_items (oferta_id) WHERE oferta_id IS NOT NULL;

UPDATE presupuesto_items i SET oferta_id = o.id
FROM ofertas o
WHERE i.oferta_id IS NULL AND i.oferta_nombre <> '' AND i.oferta_nombre = o.nombre
  AND (SELECT count(*) FROM ofertas x WHERE x.nombre = o.nombre) = 1;

ALTER TABLE web_eventos ADD COLUMN oferta_id integer;
CREATE INDEX ix_web_eventos_oferta ON web_eventos (oferta_id) WHERE oferta_id IS NOT NULL;
