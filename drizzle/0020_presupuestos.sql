-- Presupuestos: la bandeja de entrada de los pedidos mayoristas (WhatsApp hoy,
-- tienda web mañana). Cotización con ciclo de vida; NO es comprobante fiscal.
CREATE TYPE "estado_presupuesto" AS ENUM ('borrador', 'enviado', 'confirmado', 'cerrado', 'cancelado');--> statement-breakpoint
CREATE TABLE "presupuestos" (
  "id" serial PRIMARY KEY NOT NULL,
  "codigo" text NOT NULL DEFAULT '',
  "fecha" timestamp with time zone NOT NULL DEFAULT now(),
  "cliente_id" integer NOT NULL REFERENCES "clientes"("id") ON DELETE restrict,
  "sucursal_id" integer NOT NULL REFERENCES "sucursales"("id") ON DELETE restrict,
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE set null,
  "vendedor_id" integer REFERENCES "usuarios"("id") ON DELETE set null,
  "estado" "estado_presupuesto" NOT NULL DEFAULT 'borrador',
  "entrega" text NOT NULL DEFAULT 'retiro',
  "vencimiento" timestamp with time zone,
  "venta_id" integer REFERENCES "ventas"("id") ON DELETE set null,
  "observaciones" text NOT NULL DEFAULT '',
  "subtotal_neto" double precision NOT NULL DEFAULT 0,
  "iva_total" double precision NOT NULL DEFAULT 0,
  "total" double precision NOT NULL DEFAULT 0
);--> statement-breakpoint
CREATE TABLE "presupuesto_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "presupuesto_id" integer NOT NULL REFERENCES "presupuestos"("id") ON DELETE cascade,
  "producto_id" integer NOT NULL REFERENCES "productos"("id") ON DELETE restrict,
  "presentacion_id" integer REFERENCES "presentaciones"("id") ON DELETE set null,
  "nombre" text NOT NULL DEFAULT '',
  "detalle" text NOT NULL DEFAULT '',
  "cantidad" double precision NOT NULL DEFAULT 0,
  "cantidad_armada" double precision,
  "precio_lista" double precision NOT NULL DEFAULT 0,
  "descuento" double precision NOT NULL DEFAULT 0,
  "iva" double precision NOT NULL DEFAULT 21,
  "lista" text NOT NULL DEFAULT '',
  "oferta_nombre" text NOT NULL DEFAULT '',
  "motivo" text NOT NULL DEFAULT ''
);--> statement-breakpoint
CREATE INDEX "ix_presupuesto_items_presupuesto" ON "presupuesto_items" ("presupuesto_id");
