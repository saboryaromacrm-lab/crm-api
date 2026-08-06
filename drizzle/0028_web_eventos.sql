-- Telemetría anónima del sitio: visitas, tiempo mirando cada producto y
-- agregados al carrito. Sesión = UUID del navegador, sin datos personales.
CREATE TABLE "web_eventos" (
	"id" serial PRIMARY KEY NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"sesion" text DEFAULT '' NOT NULL,
	"tipo" text NOT NULL,
	"ruta" text DEFAULT '' NOT NULL,
	"producto_id" integer,
	"segundos" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ix_web_eventos_fecha" ON "web_eventos" USING btree ("fecha");
--> statement-breakpoint
CREATE INDEX "ix_web_eventos_producto" ON "web_eventos" USING btree ("producto_id");
--> statement-breakpoint
-- Las estadísticas son una sección nueva del módulo Web.
UPDATE "roles" SET "permisos" = "permisos" || '["web.estadisticas"]'::jsonb WHERE "clave" = 'admin';
