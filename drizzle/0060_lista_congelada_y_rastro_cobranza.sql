-- 0060 · LA LISTA QUE SE COTIZÓ, EL RASTRO DE LA COBRANZA Y QUIÉN COBRÓ
--
-- Tres columnas de tres tablas distintas, juntas porque las tres arreglan el
-- mismo tipo de olvido: el documento guardaba el NÚMERO pero no de dónde salía.
--
-- 1 · `presupuesto_items.lista_id` — la más urgente, porque hoy rompe una venta.
--     El renglón cotizado guardaba `lista` como TEXTO ("Mayorista 2"), lindo
--     para el papel e inútil para el sistema. Desde que el servidor recalcula el
--     precio contra `producto_listas`, cerrar un presupuesto en el POS manda el
--     precio congelado sin decir con qué lista se congeló: el portero lo compara
--     contra el piso de HOY, no coincide, y lo rechaza por "precio pisado". O
--     sea que todo pedido mayorista dejó de poder cobrarse salvo por alguien con
--     `precio_manual`. Un presupuesto existe justamente para que el precio no se
--     mueva; guardar el id de la lista es lo que permite demostrarlo.
--
-- 2 · `cobranzas.anulado_*` — la gemela exacta de la 0059. Anular un recibo le
--     saca la plata al arqueo del turno y le sube el saldo al cliente; sin estas
--     columnas, sin quién y sin por qué. La venta ya lo guarda desde la 0059 y
--     la cobranza no: la misma maniobra, en la puerta de al lado.
--
-- 3 · `ventas.cobrado_por` — armar y cobrar son dos actos y dos personas. Hasta
--     acá se guardaba uno solo, y encima el equivocado: al confirmar se pisaba
--     el vendedor del borrador con el de quien cobraba, así que el ticket que
--     armó Marta toda la mañana quedaba a nombre de Juan por apretar F2. Ahora
--     `usuario_id` es de quien lo armó (que es lo que el código ya decía querer)
--     y esta columna, de quien lo cobró.
--
-- `set null` en las tres referencias a usuario, igual que en toda la base: si el
-- empleado se borra, el hecho no desaparece — pierde el nombre, no el hecho.

ALTER TABLE "presupuesto_items" ADD COLUMN "lista_id" integer;

ALTER TABLE "cobranzas" ADD COLUMN "anulado_por" integer;
ALTER TABLE "cobranzas" ADD COLUMN "anulado_en" timestamp with time zone;
ALTER TABLE "cobranzas" ADD COLUMN "anulado_motivo" text DEFAULT '' NOT NULL;

ALTER TABLE "ventas" ADD COLUMN "cobrado_por" integer;

DO $$ BEGIN
 ALTER TABLE "presupuesto_items" ADD CONSTRAINT "presupuesto_items_lista_id_listas_venta_id_fk"
  FOREIGN KEY ("lista_id") REFERENCES "public"."listas_venta"("id")
  ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "cobranzas" ADD CONSTRAINT "cobranzas_anulado_por_usuarios_id_fk"
  FOREIGN KEY ("anulado_por") REFERENCES "public"."usuarios"("id")
  ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "ventas" ADD CONSTRAINT "ventas_cobrado_por_usuarios_id_fk"
  FOREIGN KEY ("cobrado_por") REFERENCES "public"."usuarios"("id")
  ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- El turno de caja de la cobranza y el de la venta se consultan en cada arqueo
-- (dos veces) y en el filtro "por turno" del listado, y ninguna de las dos tenía
-- índice: el arqueo hacía scan completo de tablas que crecen todos los días.
CREATE INDEX IF NOT EXISTS "ix_cobranzas_caja_sesion" ON "cobranzas" ("caja_sesion_id");
CREATE INDEX IF NOT EXISTS "ix_ventas_caja_sesion" ON "ventas" ("caja_sesion_id");
-- El `count(*)` de pedidos web pendientes lo pollea CADA navegador cada 30 s.
CREATE INDEX IF NOT EXISTS "ix_presupuestos_estado_origen" ON "presupuestos" ("estado", "origen");
CREATE INDEX IF NOT EXISTS "ix_presupuestos_cliente" ON "presupuestos" ("cliente_id");
