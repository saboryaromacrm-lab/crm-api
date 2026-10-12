-- ===========================================================================
-- 0158 · FACTURAS DEL MES (11/10/2026)
-- ===========================================================================
-- Pedido del dueño: un proveedor entrega todo el mes con remitos SIN IVA (lo
-- que se le paga es eso: el valor de los remitos) y a fin de mes hace las
-- facturas de todo lo comprado, con IVA. Sobre cada factura cobra aparte una
-- comisión, sin factura. Siempre mensual.
--
-- Cargadas como facturas comunes, esas facturas entrarían OTRA VEZ al stock y
-- a la deuda (y con un IVA que no se paga). Acá viven aparte:
--
--   proveedores.factura_mensual        el proveedor trabaja así (ficha).
--   facturaciones_mes                  el mes facturado de un proveedor: uno
--                                      activo por mes; se anula, no se borra.
--   facturaciones_mes_facturas         cada factura del papel: SOLO fiscal
--                                      (IVA crédito y percepciones por su
--                                      fecha). No mueve stock ni suma deuda.
--                                      Su comisión es una liquidación aparte
--                                      (`comision_comprobante_id`): deuda sin IVA.
--   comprobantes.facturacion_mes_id    las entregas del mes que esas facturas
--                                      cubren (los remitos pasan a liquidación:
--                                      deuda por su valor sin IVA). Ya no
--                                      cuentan como «sin factura» en el IVA.
-- ===========================================================================
ALTER TABLE "proveedores" ADD COLUMN IF NOT EXISTS "factura_mensual" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "facturaciones_mes" (
  "id" serial PRIMARY KEY,
  "proveedor_id" integer NOT NULL REFERENCES "proveedores"("id") ON DELETE RESTRICT,
  "mes" text NOT NULL CHECK ("mes" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  "sucursal_id" integer REFERENCES "sucursales"("id") ON DELETE SET NULL,
  "neto_documentos" double precision NOT NULL DEFAULT 0,
  "estado" text NOT NULL DEFAULT 'activa' CHECK ("estado" IN ('activa', 'anulada')),
  "observaciones" text NOT NULL DEFAULT '',
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "creado_en" timestamp with time zone NOT NULL DEFAULT now(),
  "anulado_en" timestamp with time zone,
  "anulado_por" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "motivo_anulacion" text NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_facturaciones_mes" ON "facturaciones_mes" ("proveedor_id", "mes") WHERE "estado" = 'activa';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "facturaciones_mes_facturas" (
  "id" serial PRIMARY KEY,
  "facturacion_id" integer NOT NULL REFERENCES "facturaciones_mes"("id") ON DELETE CASCADE,
  "proveedor_id" integer NOT NULL REFERENCES "proveedores"("id") ON DELETE RESTRICT,
  "activa" boolean NOT NULL DEFAULT true,
  "letra" "letra_comprobante" NOT NULL CHECK ("letra" <> 'X'),
  "punto_venta" text NOT NULL,
  "numero" integer NOT NULL CHECK ("numero" > 0),
  "fecha" timestamp with time zone NOT NULL,
  "cae" text NOT NULL DEFAULT '',
  "neto" double precision NOT NULL CHECK ("neto" > 0),
  "iva" double precision NOT NULL DEFAULT 0 CHECK ("iva" >= 0),
  "perc_iva" double precision NOT NULL DEFAULT 0 CHECK ("perc_iva" >= 0),
  "perc_iibb" double precision NOT NULL DEFAULT 0 CHECK ("perc_iibb" >= 0),
  "perc_otras" double precision NOT NULL DEFAULT 0 CHECK ("perc_otras" >= 0),
  "total" double precision NOT NULL CHECK ("total" > 0),
  "comision" double precision NOT NULL DEFAULT 0 CHECK ("comision" >= 0),
  "comision_comprobante_id" integer REFERENCES "comprobantes"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_facturaciones_mes_facturas" ON "facturaciones_mes_facturas" ("proveedor_id", "letra", "punto_venta", "numero") WHERE "activa";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_facturaciones_mes_facturas_fecha" ON "facturaciones_mes_facturas" ("fecha") WHERE "activa";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_facturaciones_mes_facturas_facturacion" ON "facturaciones_mes_facturas" ("facturacion_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_facturaciones_mes_facturas_comision" ON "facturaciones_mes_facturas" ("comision_comprobante_id") WHERE "comision_comprobante_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "comprobantes" ADD COLUMN IF NOT EXISTS "facturacion_mes_id" integer REFERENCES "facturaciones_mes"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_comprobantes_facturacion_mes" ON "comprobantes" ("facturacion_mes_id") WHERE "facturacion_mes_id" IS NOT NULL;
