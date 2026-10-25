-- 0198 · SEGUIR PREGUNTANDO SOBRE UN ANÁLISIS (25/10/2026, pedido del dueño: «poder
-- volver a preguntarle a la IA cuando me responde algo»). La conversación que nace
-- desde un análisis queda atada a él: la IA lo tiene entero en cada pregunta y la
-- pantalla la muestra debajo del análisis. Borrar el análisis no borra la charla.
ALTER TABLE asesor_conversaciones ADD COLUMN IF NOT EXISTS informe_id integer REFERENCES asesor_informes(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_asesor_conv_informe ON asesor_conversaciones (informe_id) WHERE informe_id IS NOT NULL;
