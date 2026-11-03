-- 0213 · VENTAS DEL SISTEMA ANTERIOR (3/11/2026, pedido del dueño: comparar los meses del sistema
-- viejo con los primeros del ERP, «aproximado nomás»). Un renglón por local y mes, tal como lo
-- exporta su «Estadística de ventas por período»: días con venta, comprobantes, monto y costo, los
-- dos CON IVA y de todo lo vendido. Las unidades y la participación del archivo no se guardan: no
-- se pueden comparar con lo del ERP.
--
-- A DIFERENCIA DE LAS OTRAS metricas_*, ESTO NO SE PUEDE REARMAR: es lo único que queda del sistema
-- viejo. Por eso no está en las tablas que borra la sincronización. Subir otra vez un mes lo
-- reemplaza.
CREATE TABLE IF NOT EXISTS "metricas_sistema_anterior" (
  "sucursal_id" integer NOT NULL REFERENCES "sucursales"("id"),
  "mes" date NOT NULL,
  "dias_venta" integer NOT NULL,
  "comprobantes" integer NOT NULL,
  "monto" numeric(14, 2) NOT NULL,
  "costo" numeric(14, 2) NOT NULL,
  "importado_en" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("sucursal_id", "mes"),
  CONSTRAINT "ck_msa_mes" CHECK (extract(day FROM "mes") = 1),
  CONSTRAINT "ck_msa_valores" CHECK ("dias_venta" BETWEEN 0 AND 31 AND "comprobantes" >= 0 AND "monto" >= 0 AND "costo" >= 0)
);
