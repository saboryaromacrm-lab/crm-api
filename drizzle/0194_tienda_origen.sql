-- ===========================================================================
-- 0194 · TIENDA ONLINE: DE DÓNDE LLEGAN Y «EMPEZAR DE 0» (22/10/2026)
-- ===========================================================================
-- Pedido del dueño: en Tienda online › Métricas faltaba desde dónde llegan los
-- visitantes, y un botón para limpiar las métricas de una tienda (mayorista o
-- minorista) y que empiecen de 0.
--
--  · Cada sesión manda UNA vez un evento `llegada` con la página de entrada;
--    el servidor clasifica el canal (`origen`: buscadores, instagram, whatsapp,
--    campaña paga, directo…) y guarda el detalle (`origen_detalle`: el sitio o
--    la campaña). Sin URL completa ni datos personales.
--  · `web_metricas_reinicios`: cada «Empezar de 0» queda registrado (quién,
--    cuándo, cuántos eventos se borraron). Las métricas de ese modo cuentan
--    solo desde el último; los pedidos y clientes NO se borran (son ventas y
--    fichas), solo dejan de contar en las métricas.
-- ===========================================================================
ALTER TABLE web_eventos ADD COLUMN origen text;
--> statement-breakpoint
ALTER TABLE web_eventos ADD COLUMN origen_detalle text;
--> statement-breakpoint
CREATE INDEX ix_web_eventos_llegada ON web_eventos (modo, fecha) WHERE tipo = 'llegada';
--> statement-breakpoint
CREATE TABLE web_metricas_reinicios (
	id serial PRIMARY KEY,
	modo text NOT NULL CHECK (modo IN ('mayorista', 'minorista')),
	fecha timestamp with time zone NOT NULL DEFAULT now(),
	usuario_id integer REFERENCES usuarios(id) ON DELETE SET NULL,
	eventos_borrados integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX ix_web_metricas_reinicios_modo ON web_metricas_reinicios (modo, fecha DESC);
