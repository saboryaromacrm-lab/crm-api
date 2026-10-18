-- ===========================================================================
-- 0179 · MÉTRICAS DE LA TIENDA ONLINE POR MODO (18/10/2026)
-- ===========================================================================
-- Pedido del dueño: métricas de la tienda separadas en mayorista y minorista.
-- Cada evento del sitio dice en qué modo pasó (`modo`); lo anterior a esta
-- migración era todo mayorista (la minorista nació el 16/10/2026 y estuvo
-- apagada hasta ahora). El índice por modo y fecha es el que usan todas las
-- consultas de Tienda online › Métricas.
-- ===========================================================================
ALTER TABLE web_eventos ADD COLUMN modo text NOT NULL DEFAULT 'mayorista';
CREATE INDEX ix_web_eventos_modo_fecha ON web_eventos (modo, fecha);
