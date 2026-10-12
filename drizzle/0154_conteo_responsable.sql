-- ===========================================================================
-- 0154 · RESPONSABLE DEL CONTROL DE STOCK (10/10/2026)
-- ===========================================================================
-- Pedido del dueño: al abrir un control se escribe a mano quién es el
-- responsable (puede no tener usuario en el sistema). Sale en la pantalla y en
-- la planilla impresa. Los controles viejos quedan con '' (se muestra «—»).
-- ===========================================================================
ALTER TABLE "conteos" ADD COLUMN "responsable" text NOT NULL DEFAULT '';
