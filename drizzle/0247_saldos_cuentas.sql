-- «¿Dónde está mi plata?» (Gerencia › Vista profesional, 26/11/2026, pedido del dueño: «siento que me falta
-- dinero… que no me mienta»). El ERP sabe lo que sale de cada cuenta propia (los pagos con «¿De qué cuenta
-- salió?») y lo que entra a Mercado Pago (los cobros que baja la conciliación), pero NO el saldo: ese lo
-- carga el dueño mirando la app. Cada saldo cargado guarda lo que el sistema calculaba en ese momento:
-- la diferencia es plata que se movió por fuera del ERP.
ALTER TABLE cuentas_propias ADD COLUMN IF NOT EXISTS es_mercado_pago boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_cuentas_propias_mercado_pago ON cuentas_propias (es_mercado_pago) WHERE es_mercado_pago;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cuenta_saldos (
  id serial PRIMARY KEY,
  cuenta_propia_id integer NOT NULL REFERENCES cuentas_propias(id) ON DELETE RESTRICT,
  fecha timestamptz NOT NULL DEFAULT now(),
  saldo double precision NOT NULL,
  estimado double precision,
  diferencia double precision,
  nota text NOT NULL DEFAULT '',
  usuario_id integer REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en timestamptz NOT NULL DEFAULT now(),
  anulado_en timestamptz,
  anulado_por integer REFERENCES usuarios(id) ON DELETE SET NULL,
  anulado_motivo text NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ix_cuenta_saldos_cuenta ON cuenta_saldos (cuenta_propia_id, fecha DESC) WHERE anulado_en IS NULL;
