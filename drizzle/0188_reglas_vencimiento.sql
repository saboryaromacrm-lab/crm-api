-- ===========================================================================
-- 0188 · REGLAS DE OFERTA POR RANGO DE VENCIMIENTO (20/10/2026)
-- ===========================================================================
-- Pedido del dueño: una regla fija por rango —sin oferta, % de descuento,
-- costo + % o llevá N pagá M— con la que el sistema arma, escala y mide la
-- oferta de cada registro de vencimiento. La cuenta vive en
-- `vencimientos/reglas.ts`; acá, la tabla y los valores de arranque:
--   +30 días sin oferta · 16–30 −25 % · 8–15 −40 % · 0–7 al costo (costo + 0 %).
--
--   · ofertas.auto_vencimiento: la oferta la maneja la regla. Si una persona
--     la edita, pasa a manual y la regla no la vuelve a tocar.

CREATE TABLE vencimiento_reglas (
  rango text PRIMARY KEY CHECK (rango IN ('vigente', 'd30', 'd15', 'd7')),
  mecanica text NOT NULL CHECK (mecanica IN ('ninguna', 'descuento', 'costo', 'nxm')),
  valor double precision NOT NULL DEFAULT 0,
  lleva integer NOT NULL DEFAULT 0,
  paga integer NOT NULL DEFAULT 0,
  usuario_id integer REFERENCES usuarios(id) ON DELETE SET NULL,
  actualizado_en timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO vencimiento_reglas (rango, mecanica, valor) VALUES
  ('vigente', 'ninguna', 0), ('d30', 'descuento', 25), ('d15', 'descuento', 40), ('d7', 'costo', 0);
--> statement-breakpoint
ALTER TABLE ofertas ADD COLUMN auto_vencimiento boolean NOT NULL DEFAULT false;
