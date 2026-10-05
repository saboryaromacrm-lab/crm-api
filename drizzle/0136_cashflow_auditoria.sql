-- ===========================================================================
-- 0136 · CASH FLOW: ARREGLOS DE LA AUDITORÍA DE TESORERÍA (5/10/2026)
-- ===========================================================================
-- cashflow_sobres.descartado  Un sobre que NO corresponde (ya estaba en el saldo
--                             inicial, extraviado con denuncia, duplicado): se
--                             resuelve con motivo, sin entrar plata y SIN
--                             cargarle un faltante al cajero.
-- cashflow_sobres.billetes    El control del sobre se hace contando billete por
-- cashflow_sobres.otros       billete (a ciegas): queda lo que contó el dueño.
-- cashflow_conteos.en_transito Lo que había en sobres sin controlar al contar
--                             la caja: explica un «sobrante» que era un sobre.
ALTER TABLE "cashflow_sobres" ADD COLUMN IF NOT EXISTS "descartado" boolean NOT NULL DEFAULT false;
ALTER TABLE "cashflow_sobres" ADD COLUMN IF NOT EXISTS "billetes" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "cashflow_sobres" ADD COLUMN IF NOT EXISTS "otros" double precision NOT NULL DEFAULT 0;
ALTER TABLE "cashflow_conteos" ADD COLUMN IF NOT EXISTS "en_transito" double precision NOT NULL DEFAULT 0;
