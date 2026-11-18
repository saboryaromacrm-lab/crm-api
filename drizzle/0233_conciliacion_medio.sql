-- CONCILIACIÓN MP · EL MEDIO CORREGIDO (18/11/2026): al confirmar un atado, si
-- Mercado Pago dice que el cobro entró por otro medio (se marcó QR y fue tarjeta
-- de crédito), se corrige el medio del renglón de pago. Acá queda el que tenía,
-- para mostrarlo y para volver atrás si se deshace el atado.
ALTER TABLE "mp_conciliacion_erp" ADD COLUMN IF NOT EXISTS "medio_anterior" "medio_pago";
