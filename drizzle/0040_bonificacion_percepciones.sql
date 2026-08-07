-- El pie de la factura de compra: bonificación general (el "Bonif. 21,38%") y
-- percepciones (RG 5329, IIBB…). Sin esto el total del sistema no cuadraba con
-- el papel del proveedor.
CREATE TYPE "base_percepcion" AS ENUM ('neto', 'total');--> statement-breakpoint
ALTER TABLE "comprobantes" ADD COLUMN "bonificacion" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "comprobantes" ADD COLUMN "bonificacion_importe" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "comprobantes" ADD COLUMN "percepciones_total" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proveedor_percepciones" (
	"id" serial PRIMARY KEY NOT NULL,
	"proveedor_id" integer NOT NULL,
	"nombre" text NOT NULL,
	"alicuota" double precision DEFAULT 0 NOT NULL,
	"base" "base_percepcion" DEFAULT 'neto' NOT NULL,
	"activa" boolean DEFAULT true NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "comprobante_percepciones" (
	"id" serial PRIMARY KEY NOT NULL,
	"comprobante_id" integer NOT NULL,
	"nombre" text NOT NULL,
	"alicuota" double precision DEFAULT 0 NOT NULL,
	"base" "base_percepcion" DEFAULT 'neto' NOT NULL,
	"importe" double precision DEFAULT 0 NOT NULL
);--> statement-breakpoint
ALTER TABLE "proveedor_percepciones" ADD CONSTRAINT "proveedor_percepciones_proveedor_id_proveedores_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comprobante_percepciones" ADD CONSTRAINT "comprobante_percepciones_comprobante_id_comprobantes_id_fk" FOREIGN KEY ("comprobante_id") REFERENCES "public"."comprobantes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_proveedor_percepciones" ON "proveedor_percepciones" ("proveedor_id");
