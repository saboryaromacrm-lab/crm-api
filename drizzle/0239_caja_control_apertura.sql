-- 21/11/2026: el control que deja la apertura de la caja (lo que se encontró
-- contra lo que dejó el cierre anterior) queda marcado como tal. Lo usa
-- «Corregir lo que quedó en la caja»: si el cierre anterior dijo mal cuánto
-- dejaba, el faltante al abrir medido contra ese número tampoco era real.
ALTER TABLE caja_controles ADD COLUMN IF NOT EXISTS apertura boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE caja_controles SET apertura = true WHERE observaciones LIKE 'Apertura:%' AND apertura = false;
