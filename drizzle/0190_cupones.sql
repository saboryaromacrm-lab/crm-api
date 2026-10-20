-- ===========================================================================
-- 0190 · CUPONES DE DESCUENTO DE LA TIENDA MINORISTA (20/10/2026)
-- ===========================================================================
-- Pedido del dueño: cupones configurables por días, horarios, medios de pago,
-- montos y demás, medibles hasta la rentabilidad real. La cuenta y las reglas
-- viven en `cupones/reglas.ts`.
--
--   · cupones: la definición.
--   · presupuestos.cupon_*: el cupón del pedido, congelado al pedir.
--   · presupuesto_items.cupon_pct: la parte del descuento del renglón que es
--     del cupón (fracción). Con eso la caja la reconoce al cerrar el pedido.
--   · venta_items.cupon_id / cupon_descuento: lo que el cupón descontó en la
--     venta, neto. Solo informa (la plata ya está en `descuento`): es lo que se mide.

CREATE TABLE cupones (
  id serial PRIMARY KEY,
  codigo text NOT NULL,
  descripcion text NOT NULL DEFAULT '',
  activo boolean NOT NULL DEFAULT true,
  tipo text NOT NULL CHECK (tipo IN ('porcentaje', 'monto', 'envio_gratis')),
  valor double precision NOT NULL DEFAULT 0,
  tope double precision NOT NULL DEFAULT 0,
  monto_minimo double precision NOT NULL DEFAULT 0,
  desde timestamp with time zone,
  hasta timestamp with time zone,
  dias text NOT NULL DEFAULT '',
  hora_desde text NOT NULL DEFAULT '',
  hora_hasta text NOT NULL DEFAULT '',
  medios_pago text NOT NULL DEFAULT '',
  entrega text NOT NULL DEFAULT '' CHECK (entrega IN ('', 'retiro', 'envio')),
  marcas text NOT NULL DEFAULT '',
  categorias text NOT NULL DEFAULT '',
  usos_max integer NOT NULL DEFAULT 0,
  usos_por_cliente integer NOT NULL DEFAULT 1,
  solo_primera_compra boolean NOT NULL DEFAULT false,
  creado_por integer REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en timestamp with time zone NOT NULL DEFAULT now(),
  actualizado_en timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_cupones_codigo ON cupones (codigo);
--> statement-breakpoint
ALTER TABLE presupuestos
  ADD COLUMN cupon_id integer REFERENCES cupones(id) ON DELETE SET NULL,
  ADD COLUMN cupon_codigo text NOT NULL DEFAULT '',
  ADD COLUMN cupon_descuento double precision NOT NULL DEFAULT 0,
  ADD COLUMN cupon_envio double precision;
--> statement-breakpoint
CREATE INDEX ix_presupuestos_cupon ON presupuestos (cupon_id) WHERE cupon_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE presupuesto_items ADD COLUMN cupon_pct double precision NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE venta_items
  ADD COLUMN cupon_id integer REFERENCES cupones(id) ON DELETE SET NULL,
  ADD COLUMN cupon_descuento double precision NOT NULL DEFAULT 0;
