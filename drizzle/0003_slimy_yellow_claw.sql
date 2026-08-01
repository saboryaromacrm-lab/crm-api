CREATE TYPE "public"."estado_caja" AS ENUM('abierta', 'cerrada');--> statement-breakpoint
CREATE TYPE "public"."tipo_mov_caja" AS ENUM('ingreso', 'egreso');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "caja_movimientos" (
	"id" serial PRIMARY KEY NOT NULL,
	"caja_sesion_id" integer NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"tipo" "tipo_mov_caja" NOT NULL,
	"motivo" text DEFAULT '' NOT NULL,
	"importe" double precision DEFAULT 0 NOT NULL,
	"usuario_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "caja_sesiones" (
	"id" serial PRIMARY KEY NOT NULL,
	"sucursal_id" integer NOT NULL,
	"usuario_id" integer,
	"apertura" timestamp with time zone DEFAULT now() NOT NULL,
	"monto_inicial" double precision DEFAULT 0 NOT NULL,
	"cierre" timestamp with time zone,
	"declarado_efectivo" double precision DEFAULT 0 NOT NULL,
	"sistema_efectivo" double precision DEFAULT 0 NOT NULL,
	"diferencia" double precision DEFAULT 0 NOT NULL,
	"totales" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"estado" "estado_caja" DEFAULT 'abierta' NOT NULL,
	"observaciones" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cobranzas" ADD COLUMN "caja_sesion_id" integer;--> statement-breakpoint
ALTER TABLE "presentaciones" ADD COLUMN "codigo_barras" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "productos" ADD COLUMN "codigo_barras" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "ventas" ADD COLUMN "caja_sesion_id" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "caja_movimientos" ADD CONSTRAINT "caja_movimientos_caja_sesion_id_caja_sesiones_id_fk" FOREIGN KEY ("caja_sesion_id") REFERENCES "public"."caja_sesiones"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "caja_movimientos" ADD CONSTRAINT "caja_movimientos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "caja_sesiones" ADD CONSTRAINT "caja_sesiones_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "caja_sesiones" ADD CONSTRAINT "caja_sesiones_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_caja_mov_sesion" ON "caja_movimientos" USING btree ("caja_sesion_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_caja_sesiones_sucursal" ON "caja_sesiones" USING btree ("sucursal_id","estado");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cobranzas" ADD CONSTRAINT "cobranzas_caja_sesion_id_caja_sesiones_id_fk" FOREIGN KEY ("caja_sesion_id") REFERENCES "public"."caja_sesiones"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ventas" ADD CONSTRAINT "ventas_caja_sesion_id_caja_sesiones_id_fk" FOREIGN KEY ("caja_sesion_id") REFERENCES "public"."caja_sesiones"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_presentaciones_codigo" ON "presentaciones" USING btree ("codigo_barras");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_productos_codigo" ON "productos" USING btree ("codigo_barras");