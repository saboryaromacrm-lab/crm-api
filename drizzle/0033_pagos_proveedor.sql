-- PAGOS A PROVEEDORES: la plata que sale, en un solo registro.
--
-- `gasto_pagos` se reemplaza por `proveedor_pagos` + `proveedor_imputaciones`.
-- El pago pasa a ser del PROVEEDOR y no del documento: así la cajera puede
-- pagarle a Coca-Cola cuando llega el pedido, sin que exista todavía la
-- factura, y el admin aplica ese pago al cargarla al día siguiente.
DROP TABLE IF EXISTS "gasto_pagos";
--> statement-breakpoint
CREATE TYPE "estado_pago_prov" AS ENUM('activo', 'anulado');
--> statement-breakpoint
ALTER TABLE "comprobantes" ADD COLUMN IF NOT EXISTS "pagado" double precision DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE "proveedor_pagos" (
	"id" serial PRIMARY KEY NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"proveedor_id" integer,
	"medio" "medio_pago" DEFAULT 'efectivo' NOT NULL,
	"importe" double precision DEFAULT 0 NOT NULL,
	"aplicado" double precision DEFAULT 0 NOT NULL,
	"concepto" text DEFAULT '' NOT NULL,
	"referencia" text DEFAULT '' NOT NULL,
	"sucursal_id" integer,
	"caja_sesion_id" integer,
	"caja_movimiento_id" integer,
	"usuario_id" integer,
	"estado" "estado_pago_prov" DEFAULT 'activo' NOT NULL,
	"observaciones" text DEFAULT '' NOT NULL,
	CONSTRAINT "proveedor_pagos_proveedor_id_proveedores_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "proveedores"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "proveedor_pagos_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "sucursales"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "proveedor_pagos_caja_sesion_id_caja_sesiones_id_fk" FOREIGN KEY ("caja_sesion_id") REFERENCES "caja_sesiones"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "proveedor_pagos_caja_movimiento_id_caja_movimientos_id_fk" FOREIGN KEY ("caja_movimiento_id") REFERENCES "caja_movimientos"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "proveedor_pagos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "ix_proveedor_pagos_proveedor" ON "proveedor_pagos" USING btree ("proveedor_id","estado");
--> statement-breakpoint
CREATE INDEX "ix_proveedor_pagos_fecha" ON "proveedor_pagos" USING btree ("fecha");
--> statement-breakpoint
CREATE INDEX "ix_proveedor_pagos_caja" ON "proveedor_pagos" USING btree ("caja_sesion_id");
--> statement-breakpoint
CREATE TABLE "proveedor_imputaciones" (
	"id" serial PRIMARY KEY NOT NULL,
	"pago_id" integer NOT NULL,
	"gasto_id" integer,
	"comprobante_id" integer,
	"importe" double precision DEFAULT 0 NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"usuario_id" integer,
	CONSTRAINT "proveedor_imputaciones_pago_id_proveedor_pagos_id_fk" FOREIGN KEY ("pago_id") REFERENCES "proveedor_pagos"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "proveedor_imputaciones_gasto_id_gastos_id_fk" FOREIGN KEY ("gasto_id") REFERENCES "gastos"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "proveedor_imputaciones_comprobante_id_comprobantes_id_fk" FOREIGN KEY ("comprobante_id") REFERENCES "comprobantes"("id") ON DELETE cascade ON UPDATE no action,
	-- Una imputación apunta a UN documento: o un gasto o un comprobante de
	-- compra, nunca a los dos ni a ninguno. Lo garantiza la base, no el código.
	CONSTRAINT "ck_prov_imput_un_documento" CHECK (("gasto_id" IS NOT NULL)::int + ("comprobante_id" IS NOT NULL)::int = 1)
);
--> statement-breakpoint
CREATE INDEX "ix_prov_imput_pago" ON "proveedor_imputaciones" USING btree ("pago_id");
--> statement-breakpoint
CREATE INDEX "ix_prov_imput_gasto" ON "proveedor_imputaciones" USING btree ("gasto_id");
--> statement-breakpoint
CREATE INDEX "ix_prov_imput_comprobante" ON "proveedor_imputaciones" USING btree ("comprobante_id");
--> statement-breakpoint
-- Pagar al proveedor desde la caja es una acción del cajero; aplicar el pago a
-- una factura es del administrador. Se separan a propósito.
UPDATE "roles" SET "permisos" = "permisos" || '["gastos.pagos_proveedor","gastos_pagar_proveedor","gastos_imputar"]'::jsonb WHERE "clave" IN ('admin', 'superadmin');
--> statement-breakpoint
UPDATE "roles" SET "permisos" = "permisos" || '["gastos_pagar_proveedor"]'::jsonb WHERE "clave" = 'cajero';
