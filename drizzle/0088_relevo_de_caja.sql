-- RELEVO DE CAJA (27/8/2026, pedido del dueño).
-- El caso real: la cajera se ausenta y cobra el repositor SIN cambiar de
-- sesión. El usuario habilitado como relevo se elige en el POS y firma con su
-- PIN; la marca y el PIN se administran en Gerencia > Usuarios y roles.
-- Idempotente: producción la corre sola al arrancar el contenedor.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS relevo_caja boolean NOT NULL DEFAULT false;
-- Mismo formato que password_hash (s2:<salt>:<scrypt>). Vacío = sin PIN.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS pin_hash text NOT NULL DEFAULT '';
