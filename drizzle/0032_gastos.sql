-- MÓDULO GASTOS: lo que la empresa paga y no es mercadería.
-- El proveedor es el MISMO de compras (un CUIT, una cuenta): se lo clasifica
-- con dos flags en vez de duplicarlo en otra tabla.
ALTER TABLE "proveedores" ADD COLUMN IF NOT EXISTS "provee_mercaderia" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "proveedores" ADD COLUMN IF NOT EXISTS "provee_gastos" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TYPE "tipo_gasto" AS ENUM('fijo', 'variable');
--> statement-breakpoint
CREATE TYPE "tipo_doc_gasto" AS ENUM('factura', 'ticket', 'recibo', 'nota_credito', 'otro');
--> statement-breakpoint
CREATE TYPE "estado_gasto" AS ENUM('pendiente', 'pagado', 'anulado');
--> statement-breakpoint
CREATE TYPE "frecuencia_gasto" AS ENUM('mensual', 'bimestral', 'trimestral', 'semestral', 'anual');
--> statement-breakpoint
CREATE TABLE "gasto_categorias" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"tipo" "tipo_gasto" DEFAULT 'variable' NOT NULL,
	"descripcion" text DEFAULT '' NOT NULL,
	"activa" boolean DEFAULT true NOT NULL,
	"orden" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gasto_categoria_nombre" ON "gasto_categorias" USING btree ("nombre");
--> statement-breakpoint
CREATE TABLE "gastos" (
	"id" serial PRIMARY KEY NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"fecha_carga" timestamp with time zone DEFAULT now() NOT NULL,
	"tipo_doc" "tipo_doc_gasto" DEFAULT 'factura' NOT NULL,
	"letra" "letra_comprobante" DEFAULT 'B' NOT NULL,
	"numero" text DEFAULT '' NOT NULL,
	"proveedor_id" integer,
	"proveedor_texto" text DEFAULT '' NOT NULL,
	"categoria_id" integer NOT NULL,
	"sucursal_id" integer,
	"descripcion" text DEFAULT '' NOT NULL,
	"condicion_pago" "condicion_pago" DEFAULT 'contado' NOT NULL,
	"vencimiento" timestamp with time zone,
	"neto" double precision DEFAULT 0 NOT NULL,
	"iva" double precision DEFAULT 0 NOT NULL,
	"otros" double precision DEFAULT 0 NOT NULL,
	"total" double precision DEFAULT 0 NOT NULL,
	"pagado" double precision DEFAULT 0 NOT NULL,
	"estado" "estado_gasto" DEFAULT 'pendiente' NOT NULL,
	"recurrente_id" integer,
	"observaciones" text DEFAULT '' NOT NULL,
	"usuario_id" integer,
	CONSTRAINT "gastos_proveedor_id_proveedores_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "proveedores"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "gastos_categoria_id_gasto_categorias_id_fk" FOREIGN KEY ("categoria_id") REFERENCES "gasto_categorias"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "gastos_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "sucursales"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "gastos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "ix_gastos_fecha" ON "gastos" USING btree ("fecha");
--> statement-breakpoint
CREATE INDEX "ix_gastos_estado" ON "gastos" USING btree ("estado","vencimiento");
--> statement-breakpoint
CREATE INDEX "ix_gastos_categoria" ON "gastos" USING btree ("categoria_id");
--> statement-breakpoint
CREATE INDEX "ix_gastos_proveedor" ON "gastos" USING btree ("proveedor_id");
--> statement-breakpoint
CREATE TABLE "gasto_pagos" (
	"id" serial PRIMARY KEY NOT NULL,
	"gasto_id" integer NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"medio" "medio_pago" DEFAULT 'efectivo' NOT NULL,
	"importe" double precision DEFAULT 0 NOT NULL,
	"referencia" text DEFAULT '' NOT NULL,
	"caja_sesion_id" integer,
	"caja_movimiento_id" integer,
	"usuario_id" integer,
	CONSTRAINT "gasto_pagos_gasto_id_gastos_id_fk" FOREIGN KEY ("gasto_id") REFERENCES "gastos"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "gasto_pagos_caja_sesion_id_caja_sesiones_id_fk" FOREIGN KEY ("caja_sesion_id") REFERENCES "caja_sesiones"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "gasto_pagos_caja_movimiento_id_caja_movimientos_id_fk" FOREIGN KEY ("caja_movimiento_id") REFERENCES "caja_movimientos"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "gasto_pagos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "ix_gasto_pagos_gasto" ON "gasto_pagos" USING btree ("gasto_id");
--> statement-breakpoint
CREATE TABLE "gastos_recurrentes" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"categoria_id" integer NOT NULL,
	"proveedor_id" integer,
	"sucursal_id" integer,
	"importe_estimado" double precision DEFAULT 0 NOT NULL,
	"frecuencia" "frecuencia_gasto" DEFAULT 'mensual' NOT NULL,
	"dia_vencimiento" integer DEFAULT 10 NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"observaciones" text DEFAULT '' NOT NULL,
	CONSTRAINT "gastos_recurrentes_categoria_id_gasto_categorias_id_fk" FOREIGN KEY ("categoria_id") REFERENCES "gasto_categorias"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "gastos_recurrentes_proveedor_id_proveedores_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "proveedores"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "gastos_recurrentes_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "sucursales"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "ix_gastos_recurrentes_activo" ON "gastos_recurrentes" USING btree ("activo");
--> statement-breakpoint
CREATE TABLE "gasto_adjuntos" (
	"id" serial PRIMARY KEY NOT NULL,
	"gasto_id" integer NOT NULL,
	"nombre" text DEFAULT '' NOT NULL,
	"mime" text DEFAULT 'image/webp' NOT NULL,
	"data" text NOT NULL,
	"subido_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gasto_adjuntos_gasto_id_gastos_id_fk" FOREIGN KEY ("gasto_id") REFERENCES "gastos"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "ix_gasto_adjuntos_gasto" ON "gasto_adjuntos" USING btree ("gasto_id");
--> statement-breakpoint
-- Plan de gastos inicial. Es un punto de partida editable, no una verdad: la
-- empresa agrega y renombra rubros desde el módulo.
INSERT INTO "gasto_categorias" ("nombre", "tipo", "descripcion", "orden") VALUES
	('Alquiler', 'fijo', 'Alquiler del local y del depósito.', 10),
	('Servicios (luz, agua, gas)', 'fijo', 'EDEFOR, aguas, gas envasado o de red.', 20),
	('Internet y telefonía', 'fijo', 'Conexión, líneas y celulares de la empresa.', 30),
	('Sueldos y cargas sociales', 'fijo', 'Remuneraciones, aportes y contribuciones.', 40),
	('Impuestos y tasas', 'fijo', 'Ingresos brutos, tasas municipales, ARCA.', 50),
	('Seguros', 'fijo', 'Pólizas del local, de los vehículos y ART.', 60),
	('Honorarios profesionales', 'fijo', 'Contador, abogado, sistemas.', 70),
	('Combustible', 'variable', 'Nafta y gasoil de la camioneta y el reparto.', 80),
	('Fletes y logística', 'variable', 'Cadetes, fletes de terceros, encomiendas.', 90),
	('Mantenimiento y reparaciones', 'variable', 'Arreglos del local, vehículos y equipos.', 100),
	('Insumos y limpieza', 'variable', 'Artículos de limpieza y consumibles del local.', 110),
	('Packaging y papelería', 'variable', 'Bolsas, etiquetas, rollos, resmas.', 120),
	('Publicidad y marketing', 'variable', 'Redes, cartelería, promociones.', 130),
	('Gastos bancarios y comisiones', 'variable', 'Comisiones, sellados, costo de posnet.', 140),
	('Otros gastos', 'variable', 'Lo que no encaja en ningún rubro anterior.', 900);
--> statement-breakpoint
-- Gastos es un módulo nuevo: el admin lo ve completo desde el primer arranque.
UPDATE "roles" SET "permisos" = "permisos" || '["gastos.gastos","gastos.pagos","gastos.fijos","gastos.categorias","gastos.proveedores","gastos.resumen"]'::jsonb WHERE "clave" = 'admin';
