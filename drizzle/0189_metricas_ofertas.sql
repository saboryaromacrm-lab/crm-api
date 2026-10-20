-- ===========================================================================
-- 0189 · OFERTAS Y DESCUENTOS EN MÉTRICAS (20/10/2026)
-- ===========================================================================
-- Pedido del dueño: medir bien las ofertas y los descuentos —si una oferta es
-- rentable o no—, con cuánto stock empezó la oferta y cuánto se vendió con ella.
--
--   · oferta_stock_inicial: la FOTO del stock disponible de lo que alcanza la
--     oferta, en cada sucursal donde corre, tomada al empezar. Hace falta una
--     foto: la venta común baja el stock sin dejar movimiento, así que el stock
--     de un día pasado no se puede reconstruir. `al_empezar` = la foto se tomó
--     apenas arrancó (si no, la oferta ya venía corriendo: alta antes de esta
--     migración, o un producto que se sumó al alcance después).
--     `ofertas.foto_stock_en` dice que la foto se sacó aunque no haya dado
--     ninguna fila: «empezó sin stock» no es lo mismo que «no hay foto».
--
--   · metricas_descuento_dia: de la venta a precio de lista a la venta neta,
--     concepto por concepto (precio cambiado a mano, descuentos con nombre, del
--     cliente o a mano, cargos aparte, costo). Las ofertas salen de la otra.
--
--   · metricas_oferta_dia: lo vendido CON cada oferta, por artículo y sucursal.
--
-- Las dos de métricas son DERIVADAS y sin claves foráneas, como las de la 0122:
-- el motor de sincronización las rearma desde las ventas. `ultima_ok = NULL`
-- hace que el reloj rearme toda la historia en su primera vuelta (un minuto
-- después de arrancar), así las nuevas nacen con todo el pasado.

CREATE TABLE oferta_stock_inicial (
  oferta_id integer NOT NULL REFERENCES ofertas(id) ON DELETE CASCADE,
  producto_id integer NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  presentacion_id integer NOT NULL DEFAULT 0,
  sucursal_id integer NOT NULL REFERENCES sucursales(id) ON DELETE CASCADE,
  cantidad double precision NOT NULL DEFAULT 0,
  tomado_en timestamp with time zone NOT NULL DEFAULT now(),
  al_empezar boolean NOT NULL DEFAULT false,
  PRIMARY KEY (oferta_id, producto_id, presentacion_id, sucursal_id)
);
--> statement-breakpoint
ALTER TABLE ofertas ADD COLUMN foto_stock_en timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS metricas_descuento_dia (
  dia date NOT NULL,
  sucursal_id integer NOT NULL DEFAULT 0,
  concepto text NOT NULL,
  ref_id integer NOT NULL DEFAULT 0,
  nombre text NOT NULL DEFAULT '',
  importe double precision NOT NULL DEFAULT 0,
  renglones integer NOT NULL DEFAULT 0,
  PRIMARY KEY (dia, sucursal_id, concepto, ref_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS metricas_oferta_dia (
  dia date NOT NULL,
  sucursal_id integer NOT NULL DEFAULT 0,
  oferta_id integer NOT NULL DEFAULT 0,
  producto_id integer NOT NULL,
  presentacion_id integer NOT NULL DEFAULT 0,
  unidades double precision NOT NULL DEFAULT 0,
  venta_neta double precision NOT NULL DEFAULT 0,
  venta_costeada double precision NOT NULL DEFAULT 0,
  costo double precision NOT NULL DEFAULT 0,
  descuento double precision NOT NULL DEFAULT 0,
  descuento_costeado double precision NOT NULL DEFAULT 0,
  renglones integer NOT NULL DEFAULT 0,
  sin_costo integer NOT NULL DEFAULT 0,
  PRIMARY KEY (dia, sucursal_id, oferta_id, producto_id, presentacion_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ix_metricas_oferta_dia_oferta ON metricas_oferta_dia (oferta_id, dia);
--> statement-breakpoint
UPDATE metricas_estado SET ultima_ok = NULL;
