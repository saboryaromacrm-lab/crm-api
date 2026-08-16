-- 0067 · LA CARGA DE GASTOS, MÁS SIMPLE (pedido del dueño, 15/8/2026)
--
-- Tres movimientos, y los tres apuntan a lo mismo: que cargar la factura de la
-- luz se parezca a leerla, no a llenar un formulario contable.
--
--  1. CONCEPTOS CON SU MONTO. El gasto deja de ser una "descripción" libre más
--     un desglose neto/IVA/otros que nadie tenía a mano, y pasa a ser
--     RENGLONES: "abono mensual $45.000, cargo por reconexión $8.000" — como
--     se lee del papel. El total es la suma. El IVA queda como UN campo
--     opcional informativo (para la factura A que lo discrimina); neto se
--     deriva (total − IVA) para que los reportes que suman neto/iva sigan
--     diciendo la verdad sin pedirle nada a nadie.
--
--  2. LA LETRA VIVE EN EL PROVEEDOR. Edesur hace siempre la misma letra de
--     factura: se le pregunta UNA vez (en su ficha) y el formulario la
--     precarga en cada carga, editable. NULL = nunca se definió, y el
--     formulario se queda con su default de siempre.
--
--  3. Los campos que se van del formulario ("anotalo a mano", "descripción",
--     "negocio") NO se van de la base: los gastos viejos los tienen, los
--     gastos fijos generados los siguen usando, y `descripcion` pasa a
--     escribirse sola con los conceptos — así todos los listados y búsquedas
--     existentes siguen andando sin tocarlos.

CREATE TABLE IF NOT EXISTS "gasto_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "gasto_id" integer NOT NULL,
  "concepto" text DEFAULT '' NOT NULL,
  -- El importe FINAL del renglón, como está en el papel. Sin neto por renglón
  -- a propósito: ese nivel de detalle es el que hacía pesada la carga.
  "monto" double precision DEFAULT 0 NOT NULL
);--> statement-breakpoint

ALTER TABLE "gasto_items" ADD CONSTRAINT "gasto_items_gasto_id_gastos_id_fk"
  FOREIGN KEY ("gasto_id") REFERENCES "public"."gastos"("id") ON DELETE cascade;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_gasto_items_gasto" ON "gasto_items" ("gasto_id");--> statement-breakpoint

-- La letra que este proveedor factura. Reusa el enum de siempre; NULL = sin
-- definir (el alta de gasto usa su default). Vive en el padrón único: es un
-- dato DEL proveedor, no de cada papel.
ALTER TABLE "proveedores" ADD COLUMN IF NOT EXISTS "letra_gasto" "letra_comprobante";
