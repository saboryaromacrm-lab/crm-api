-- FACTURAS POR PROCESAR — la bandeja de papeles subidos.
--
-- Separa "recibir el papel" (la cajera saca la foto cuando llega el camión) de
-- "cargar la factura" (el admin la procesa el viernes). El encabezado sale del
-- QR de la RG 4892, que es un JSON dentro del papel: no se interpreta imagen.
--
-- Y de paso tapa un agujero que ya existía: `comprobantes` no tenía el índice
-- único de número que `ventas` y `cobranzas` sí tienen.
CREATE TYPE "estado_lectura" AS ENUM ('pendiente', 'cargada', 'descartada');--> statement-breakpoint
ALTER TABLE "comprobantes" ADD COLUMN "cae" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_comprobantes_numero" ON "comprobantes" ("proveedor_id","tipo","punto_venta","numero") WHERE "numero" is not null;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "factura_lecturas" (
	"id" serial PRIMARY KEY NOT NULL,
	"estado" "estado_lectura" DEFAULT 'pendiente' NOT NULL,
	"leido" boolean DEFAULT false NOT NULL,
	"cuit" text DEFAULT '' NOT NULL,
	"tipo" "tipo_comprobante",
	"letra" "letra_comprobante",
	"punto_venta" text DEFAULT '' NOT NULL,
	"numero" integer,
	"fecha" timestamp with time zone,
	"total" double precision DEFAULT 0 NOT NULL,
	"cae" text DEFAULT '' NOT NULL,
	"moneda" text DEFAULT '' NOT NULL,
	"cuit_receptor" text DEFAULT '' NOT NULL,
	"proveedor_id" integer,
	"sucursal_id" integer,
	"usuario_id" integer,
	"comprobante_id" integer,
	"observaciones" text DEFAULT '' NOT NULL,
	"hash" text DEFAULT '' NOT NULL,
	"subido_en" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "factura_archivos" (
	"id" serial PRIMARY KEY NOT NULL,
	"lectura_id" integer NOT NULL,
	"nombre" text DEFAULT '' NOT NULL,
	"mime" text DEFAULT 'image/webp' NOT NULL,
	"data" text NOT NULL,
	"subido_en" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "factura_lecturas" ADD CONSTRAINT "factura_lecturas_proveedor_id_proveedores_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedores"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factura_lecturas" ADD CONSTRAINT "factura_lecturas_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factura_lecturas" ADD CONSTRAINT "factura_lecturas_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factura_lecturas" ADD CONSTRAINT "factura_lecturas_comprobante_id_comprobantes_id_fk" FOREIGN KEY ("comprobante_id") REFERENCES "public"."comprobantes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factura_archivos" ADD CONSTRAINT "factura_archivos_lectura_id_factura_lecturas_id_fk" FOREIGN KEY ("lectura_id") REFERENCES "public"."factura_lecturas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_factura_lecturas_estado" ON "factura_lecturas" ("estado");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_factura_lecturas_numero" ON "factura_lecturas" ("proveedor_id","numero");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_factura_lecturas_hash" ON "factura_lecturas" ("hash");--> statement-breakpoint
-- La bandeja es de administración: subir un papel lo puede hacer cualquiera con
-- la sección, pero confirmar la factura sigue siendo del admin.
UPDATE "roles" SET "permisos" = "permisos" || '["compras.lecturas"]'::jsonb
WHERE "clave" IN ('admin', 'superadmin') AND NOT ("permisos" ? 'compras.lecturas');
