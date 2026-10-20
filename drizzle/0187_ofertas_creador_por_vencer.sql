-- ===========================================================================
-- 0187 · OFERTAS: QUIÉN LA CREÓ Y «POR VENCIMIENTO» (20/10/2026)
-- ===========================================================================
-- Pedido del dueño en Ventas › Ofertas: una columna con quién creó cada oferta
-- y un filtro para ver las armadas para rematar mercadería por vencer.
--
--   · creado_por / creado_en: desde ahora. Las anteriores quedan en NULL: no
--     se registraba y no hay de dónde sacarlo (la pantalla dice «Sin dato»).
--   · por_vencer: se marca sola al armarla desde Almacén › Vencimientos (y al
--     atarla a un registro) y se puede tildar a mano. Las que ya están atadas
--     a un registro de vencimiento quedan marcadas acá.

ALTER TABLE ofertas
  ADD COLUMN por_vencer boolean NOT NULL DEFAULT false,
  ADD COLUMN creado_por integer REFERENCES usuarios(id) ON DELETE SET NULL,
  ADD COLUMN creado_en timestamp with time zone;
--> statement-breakpoint
ALTER TABLE ofertas ALTER COLUMN creado_en SET DEFAULT now();
--> statement-breakpoint
UPDATE ofertas o SET por_vencer = true
WHERE EXISTS (SELECT 1 FROM vencimientos v WHERE v.oferta_id = o.id);
