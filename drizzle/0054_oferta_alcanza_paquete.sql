-- ============================================================================
-- LA OFERTA DISTINGUE LA MADRE DEL PAQUETE
-- ============================================================================
-- Hasta acá una oferta "a la Nuez Pecán" le bajaba el precio TAMBIÉN a sus
-- paquetes de 250 g, y nadie lo había decidido: el motor compara el `productoId`
-- del renglón, y el renglón de un paquete lleva el de su madre. Con el paquete
-- cotizándose solo (0053) eso pasó a ser un descuento escondido.
--
-- Dos cosas, entonces:
--
--   1. un alcance nuevo, `presentacion`: la oferta puede apuntar a UN paquete
--      ("Lentejas 500 g a $X") sin tocar el kilo suelto ni los otros tamaños;
--
--   2. `incluye_fraccionados` en la oferta: cuando el alcance se resuelve por la
--      MADRE (producto, marca, categoría o etiqueta), el tilde decide si los
--      paquetes entran. Arranca en FALSE, también en las que ya existen: hoy
--      alcanzan a los paquetes, pero por arrastre y no por decisión.
ALTER TYPE "alcance_oferta" ADD VALUE IF NOT EXISTS 'presentacion';
--> statement-breakpoint
ALTER TABLE "ofertas" ADD COLUMN "incluye_fraccionados" boolean DEFAULT false NOT NULL;
