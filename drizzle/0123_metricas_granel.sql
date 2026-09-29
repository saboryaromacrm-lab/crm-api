-- ===========================================================================
-- 0123 · MÉTRICAS: GRANEL Y ENTEROS (29/9/2026)
-- ===========================================================================
-- Pedido del dueño: ver lo vendido de granel (fraccionado en paquetes o suelto
-- al peso) y de enteros, cada uno con sus números, y qué parte del total es
-- cada uno («si un día vendí 100.000 y de granel 60.000, que diga 60 %»).
--
-- `granel` se guarda en el resumen con el tipo ACTUAL del producto. Si alguien
-- corrige el tipo de un producto, cambia la «firma» (`firma_tipos`: qué
-- productos son granel) y el reloj rearma toda la historia solo, en segundo
-- plano: los números viejos y los nuevos siempre usan la misma clasificación.
-- Suelto o fraccionado se distingue por `presentacion_id` (0 = el producto tal
-- cual, al peso; N = un paquete fraccionado).
-- ===========================================================================

ALTER TABLE "metricas_venta_prod_dia" ADD COLUMN IF NOT EXISTS "granel" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "metricas_estado" ADD COLUMN IF NOT EXISTS "firma_tipos" text NOT NULL DEFAULT '';
--> statement-breakpoint

-- Qué lleva cada ticket: solo enteros, solo granel o de los dos. Solo ventas
-- (las notas de crédito no son tickets); `venta_neta` es la del ticket entero.
CREATE TABLE IF NOT EXISTS "metricas_venta_mezcla_dia" (
  "dia" date NOT NULL,
  "sucursal_id" integer NOT NULL DEFAULT 0,
  "mezcla" text NOT NULL,
  "tickets" integer NOT NULL DEFAULT 0,
  "venta_neta" double precision NOT NULL DEFAULT 0,
  PRIMARY KEY ("dia", "sucursal_id", "mezcla"),
  CONSTRAINT "ck_metricas_mezcla" CHECK ("mezcla" IN ('entero', 'granel', 'mixto'))
);
--> statement-breakpoint

-- Lo ya resumido no tiene la marca nueva: sin estado, el reloj rearma toda la
-- historia en su próxima vuelta (segundos, fuera de las ventas).
DELETE FROM "metricas_estado";
