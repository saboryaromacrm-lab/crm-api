-- ===========================================================================
-- 0195 · LINKS MEDIBLES DE LA TIENDA (23/10/2026)
-- ===========================================================================
-- Pedido del dueño: «crear un link para compartir y medir el alcance de ESE
-- link». Cada link tiene un código corto (tiendaonline…/l/<código>) que lleva
-- a una página de la tienda en un modo (minorista o mayorista). La visita la
-- cuenta el navegador (la `llegada` de la sesión guarda `link_id`): las vistas
-- previas de WhatsApp o Instagram no ejecutan nada y no inflan el número.
-- Lo que hizo cada visitante (páginas, carrito, pedido) sale de su sesión.
-- ===========================================================================
CREATE TABLE web_links (
	id serial PRIMARY KEY,
	codigo text NOT NULL UNIQUE,
	nombre text NOT NULL,
	modo text NOT NULL CHECK (modo IN ('mayorista', 'minorista')),
	destino text NOT NULL DEFAULT '/',
	canal text NOT NULL DEFAULT '',
	activo boolean NOT NULL DEFAULT true,
	creado_en timestamp with time zone NOT NULL DEFAULT now(),
	usuario_id integer REFERENCES usuarios(id) ON DELETE SET NULL
);
--> statement-breakpoint
ALTER TABLE web_eventos ADD COLUMN link_id integer REFERENCES web_links(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX ix_web_eventos_link ON web_eventos (link_id) WHERE link_id IS NOT NULL;
--> statement-breakpoint
-- Lo que hizo cada sesión que entró por un link: se busca por la sesión.
CREATE INDEX ix_web_eventos_sesion ON web_eventos (sesion);
