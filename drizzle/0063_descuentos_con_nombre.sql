-- 0063 · DESCUENTOS CON NOMBRE — la autorización que el dueño deja escrita
--
-- Hasta acá un precio podía bajar por tres caminos: el descuento del CLIENTE
-- (atributo de con quién se vende), el MANUAL del renglón (decisión del
-- vendedor, acotada por `ventas.descuentoMaxVendedor`) y la OFERTA (promoción
-- del catálogo, con su mecánica de 3×2 o precio fijo).
--
-- Esto es un cuarto camino y no encaja en ninguno: "Empleados 15%",
-- "Atención por tardanza 25%". Lo crea el dueño una vez y la cajera lo elige
-- en el momento, sin tipear un número.
--
-- LAS CINCO REGLAS QUE DEFINIÓ EL DUEÑO (14/8/2026) Y QUE ESTA FORMA SOSTIENE:
--
--  1. Cae sobre los renglones de SU lista, no sobre el subtotal de la venta.
--     Si el cliente lleva algo de Minorista y algo de Mayorista 1, un descuento
--     de Mayorista 1 toca solo esa parte. Por eso `lista_id` es NOT NULL.
--  2. Uno por lista. Dos de la misma lista competirían por los mismos
--     renglones; el motor lo rechaza, y esta forma es la que lo hace pensable.
--  3. Gana el mayor contra lo que el renglón ya traía — nunca se suman. Por eso
--     `venta_items.descuento_id` se llena SOLO si el nombrado ganó: si el 25%
--     del cliente le gana al 20% de "Familiares", ese renglón no es de
--     Familiares y el reporte de cuánto costó la autorización no debe contarlo.
--  4. No toca renglones con oferta: ya tienen su beneficio.
--  5. Si exige un medio de pago, el pago tiene que ser ÍNTEGRO de ese medio.
--     Eso se valida al confirmar, no acá, pero es el motivo de `medio_pago`.
--
-- Y `requiere_admin` existe porque el porcentaje de acá SALTEA el tope del
-- vendedor: lo autorizó el dueño al crearlo, no la cajera al tipearlo. Sin esa
-- bandera, publicar un 25% equivaldría a subirle el tope a todo el mundo.

CREATE TABLE IF NOT EXISTS "descuentos" (
  "id" serial PRIMARY KEY NOT NULL,
  "nombre" text NOT NULL,
  "porcentaje" double precision DEFAULT 0 NOT NULL,
  -- Nulo = sin vencimiento. Cuando tiene valor se guarda el instante FINAL del
  -- día elegido en hora argentina (23:59:59.999 de −03), porque el dueño pidió
  -- que valga todo el día del vencimiento. Guardando el fin del día, comparar
  -- con `now()` ya es correcto y nadie tiene que acordarse de sumar un día.
  "vence" timestamp with time zone,
  -- Nulo = cualquier forma de pago.
  "medio_pago" "medio_pago",
  "lista_id" integer NOT NULL,
  -- Nulo = TODAS las sucursales. Al revés que la lista a propósito: el alcance
  -- geográfico es una restricción opcional, el de lista es su identidad.
  "sucursal_id" integer,
  "requiere_admin" boolean DEFAULT false NOT NULL,
  "activo" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint

-- RESTRICT y no CASCADE: una lista con descuentos atrás no se borra de
-- sorpresa. Es el mismo criterio que ya usan los rubros de gasto.
ALTER TABLE "descuentos" ADD CONSTRAINT "descuentos_lista_id_listas_venta_id_fk"
  FOREIGN KEY ("lista_id") REFERENCES "public"."listas_venta"("id") ON DELETE restrict;--> statement-breakpoint
-- La sucursal SÍ cascadea: si se borra la sucursal, un descuento acotado a ella
-- no tiene sentido. (Y hoy borrar una sucursal ya es casi imposible.)
ALTER TABLE "descuentos" ADD CONSTRAINT "descuentos_sucursal_id_sucursales_id_fk"
  FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE cascade;--> statement-breakpoint

-- Dos "Empleados" en el desplegable de la caja es una trampa para la cajera.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_descuentos_nombre" ON "descuentos" ("nombre");--> statement-breakpoint
-- La pregunta que hace el POS en cada tecla: "cuáles sirven para ESTE ticket".
CREATE INDEX IF NOT EXISTS "ix_descuentos_vigentes" ON "descuentos" ("activo","lista_id");--> statement-breakpoint

-- EL RASTRO EN EL RENGLÓN, con la misma pareja id + texto congelado que ya
-- usan `lista` y `oferta`: un ticket de hace seis meses tiene que reimprimirse
-- diciendo "Empleados" aunque después se renombre o se dé de baja.
ALTER TABLE "venta_items" ADD COLUMN IF NOT EXISTS "descuento_id" integer;--> statement-breakpoint
ALTER TABLE "venta_items" ADD COLUMN IF NOT EXISTS "descuento_nombre" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- SET NULL y no RESTRICT: borrar un descuento que nunca se usó tiene que poder
-- hacerse sin trámite. El nombre congelado es lo que sostiene la historia, así
-- que el renglón no pierde información aunque el id se vaya.
ALTER TABLE "venta_items" ADD CONSTRAINT "venta_items_descuento_id_descuentos_id_fk"
  FOREIGN KEY ("descuento_id") REFERENCES "public"."descuentos"("id") ON DELETE set null;
