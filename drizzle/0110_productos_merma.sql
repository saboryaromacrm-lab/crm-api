-- ===========================================================================
-- 0110 · % DE MERMA AL FRACCIONAR (26/9/2026, pedido del dueño)
-- ===========================================================================
-- El costo del paquete era solo "costo del kilo x kilos": fraccionar pierde
-- producto (lo que queda en la bolsa madre, lo que se cae, el ajuste de
-- balanza), asi que el margen del fraccionado parecia mas alto de lo que es.
-- Con merma m%, llenar 1 kg de paquetes consume 1/(1-m) kg de granel.
-- 0 = sin merma: ningun precio cambia hasta que se cargue.
-- ===========================================================================

ALTER TABLE "productos" ADD COLUMN IF NOT EXISTS "merma" double precision NOT NULL DEFAULT 0;
