-- ===========================================================================
-- 0122 · MÉTRICAS Y RENTABILIDADES: LAS TABLAS RESUMEN (29/9/2026)
-- ===========================================================================
-- Pedido del dueño: un módulo de métricas con muchos cálculos SIN que el punto
-- de venta se enlentezca. La regla que lo garantiza: las pantallas de métricas
-- NUNCA leen las ventas una por una; leen estas tablas, que son totales por día
-- ya calculados. Un proceso de fondo las recalcula cada pocos minutos (y un
-- botón «Sincronizar» a demanda) SOLO leyendo las ventas: la venta no espera
-- ni escribe nada acá.
--
-- SIN CLAVES FORÁNEAS, A PROPÓSITO. Son datos DERIVADOS: se pueden borrar y
-- rearmar en cualquier momento desde las ventas. Con claves foráneas, borrar
-- un producto o un cliente sin historia quedaría trabado por una fila resumen.
--
-- Un día es el día de Argentina (America/Argentina/Buenos_Aires), no el de UTC.
-- Las notas de crédito (y devoluciones) restan; los borradores y anuladas no
-- cuentan. Mismo criterio que Gerencia › Rentabilidad, para que los números
-- coincidan.
-- ===========================================================================

-- Lo vendido por producto: la base de la rentabilidad, las listas y la rotación.
-- `cantidad_base` es en kg (granel) o unidades: un paquete de 500 g cuenta 0,5.
CREATE TABLE IF NOT EXISTS "metricas_venta_prod_dia" (
  "dia" date NOT NULL,
  "sucursal_id" integer NOT NULL DEFAULT 0,
  "producto_id" integer NOT NULL,
  "presentacion_id" integer NOT NULL DEFAULT 0,
  "lista_id" integer NOT NULL DEFAULT 0,
  "unidades" double precision NOT NULL DEFAULT 0,
  "cantidad_base" double precision NOT NULL DEFAULT 0,
  "venta_neta" double precision NOT NULL DEFAULT 0,
  "venta_costeada" double precision NOT NULL DEFAULT 0,
  "costo" double precision NOT NULL DEFAULT 0,
  "iva_absorbido" double precision NOT NULL DEFAULT 0,
  "renglones" integer NOT NULL DEFAULT 0,
  "con_costo" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("dia", "sucursal_id", "producto_id", "presentacion_id", "lista_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_metricas_vpd_producto" ON "metricas_venta_prod_dia" ("producto_id", "dia");
--> statement-breakpoint

-- Lo vendido por día, sucursal y quien cobró: tickets, ticket promedio, cajeros.
CREATE TABLE IF NOT EXISTS "metricas_venta_dia" (
  "dia" date NOT NULL,
  "sucursal_id" integer NOT NULL DEFAULT 0,
  "usuario_id" integer NOT NULL DEFAULT 0,
  "tickets" integer NOT NULL DEFAULT 0,
  "notas" integer NOT NULL DEFAULT 0,
  "venta_neta" double precision NOT NULL DEFAULT 0,
  "descuento" double precision NOT NULL DEFAULT 0,
  "iva" double precision NOT NULL DEFAULT 0,
  "total" double precision NOT NULL DEFAULT 0,
  PRIMARY KEY ("dia", "sucursal_id", "usuario_id")
);
--> statement-breakpoint

-- A qué hora se vende (solo ventas, sin notas de crédito).
CREATE TABLE IF NOT EXISTS "metricas_venta_hora" (
  "dia" date NOT NULL,
  "hora" smallint NOT NULL,
  "sucursal_id" integer NOT NULL DEFAULT 0,
  "tickets" integer NOT NULL DEFAULT 0,
  "venta_neta" double precision NOT NULL DEFAULT 0,
  PRIMARY KEY ("dia", "hora", "sucursal_id")
);
--> statement-breakpoint

-- Quién compra más.
CREATE TABLE IF NOT EXISTS "metricas_venta_cliente_dia" (
  "dia" date NOT NULL,
  "cliente_id" integer NOT NULL,
  "sucursal_id" integer NOT NULL DEFAULT 0,
  "tickets" integer NOT NULL DEFAULT 0,
  "venta_neta" double precision NOT NULL DEFAULT 0,
  PRIMARY KEY ("dia", "cliente_id", "sucursal_id")
);
--> statement-breakpoint

-- Cómo se cobra.
CREATE TABLE IF NOT EXISTS "metricas_venta_pago_dia" (
  "dia" date NOT NULL,
  "sucursal_id" integer NOT NULL DEFAULT 0,
  "medio" text NOT NULL,
  "importe" double precision NOT NULL DEFAULT 0,
  "cantidad" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("dia", "sucursal_id", "medio")
);
--> statement-breakpoint

-- Lo que se le compra a cada proveedor (facturas y liquidaciones; la NC resta).
CREATE TABLE IF NOT EXISTS "metricas_compra_prov_dia" (
  "dia" date NOT NULL,
  "proveedor_id" integer NOT NULL,
  "neto" double precision NOT NULL DEFAULT 0,
  "iva" double precision NOT NULL DEFAULT 0,
  "total" double precision NOT NULL DEFAULT 0,
  "comprobantes" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("dia", "proveedor_id")
);
--> statement-breakpoint

-- Cómo va la sincronización (una sola fila).
CREATE TABLE IF NOT EXISTS "metricas_estado" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "ultima_sync" timestamp with time zone,
  "ultima_ok" timestamp with time zone,
  "ultima_noche" timestamp with time zone,
  "modo" text NOT NULL DEFAULT '',
  "duracion_ms" integer NOT NULL DEFAULT 0,
  "desde_dia" date,
  "hasta_dia" date,
  "primer_dato" date,
  "filas" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "error" text NOT NULL DEFAULT '',
  CONSTRAINT "ck_metricas_estado_unica" CHECK ("id" = 1)
);
--> statement-breakpoint

-- Las compras se sincronizan por fecha del comprobante; sin este índice cada
-- sincronización recorría todos los comprobantes.
CREATE INDEX IF NOT EXISTS "ix_comprobantes_fecha" ON "comprobantes" ("fecha");
