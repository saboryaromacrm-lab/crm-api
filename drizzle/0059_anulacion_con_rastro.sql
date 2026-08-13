-- 0059 · LA ANULACIÓN DEJA RASTRO
--
-- Anular una venta al contado le saca el efectivo al arqueo: la venta sale de
-- `esperadoEfectivo`, el stock vuelve, y el cierre da diferencia 0. Sin estas
-- tres columnas no había forma de saber QUIÉN la anuló ni por qué — el único
-- rastro posible era el autor del movimiento de reingreso de stock, y llegaba
-- nulo porque el controller no le pasaba el usuario.
--
-- `set null` en el usuario, igual que en el resto de la tabla: si el empleado se
-- borra, la anulación no desaparece — pierde el nombre, no el hecho.
ALTER TABLE "ventas" ADD COLUMN "anulado_por" integer;
ALTER TABLE "ventas" ADD COLUMN "anulado_en" timestamp with time zone;
ALTER TABLE "ventas" ADD COLUMN "anulado_motivo" text DEFAULT '' NOT NULL;

DO $$ BEGIN
 ALTER TABLE "ventas" ADD CONSTRAINT "ventas_anulado_por_usuarios_id_fk"
  FOREIGN KEY ("anulado_por") REFERENCES "public"."usuarios"("id")
  ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
