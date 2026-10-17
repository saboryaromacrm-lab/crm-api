-- ===========================================================================
-- 0178 · LA TIENDA MINORISTA CON INGRESO (17/10/2026)
-- ===========================================================================
-- Decisión del dueño: el cliente minorista tiene que ingresar para ver los
-- precios, con su WhatsApp como clave (el mayorista sigue con el DNI). Se
-- registra con WhatsApp, nombre, apellido y dirección y entra en el momento;
-- el que ya había comprado entra directo con su WhatsApp. Desde el ERP se lo
-- puede bloquear.
--
-- Las sesiones son las mismas de la tienda (0155): cada una es de UN acceso
-- mayorista o de UN comprador minorista, nunca de los dos.
-- ===========================================================================
ALTER TABLE tienda_compradores ADD COLUMN bloqueado boolean NOT NULL DEFAULT false;
ALTER TABLE tienda_compradores ADD COLUMN ultimo_ingreso timestamptz;

ALTER TABLE tienda_sesiones ALTER COLUMN acceso_id DROP NOT NULL;
ALTER TABLE tienda_sesiones ADD COLUMN comprador_id integer REFERENCES tienda_compradores(id) ON DELETE CASCADE;
ALTER TABLE tienda_sesiones ADD CONSTRAINT ck_tienda_sesiones_quien CHECK (num_nonnulls(acceso_id, comprador_id) = 1);
CREATE INDEX ix_tienda_sesiones_comprador ON tienda_sesiones (comprador_id);
