-- Controles de caja INTERMEDIOS: conteos de efectivo en medio del turno,
-- sin cerrar nada. Foto de fecha/hora + esperado + contado + diferencia.
CREATE TABLE "caja_controles" (
	"id" serial PRIMARY KEY NOT NULL,
	"caja_sesion_id" integer NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"esperado_efectivo" double precision DEFAULT 0 NOT NULL,
	"contado_efectivo" double precision DEFAULT 0 NOT NULL,
	"diferencia" double precision DEFAULT 0 NOT NULL,
	"observaciones" text DEFAULT '' NOT NULL,
	"usuario_id" integer
);
--> statement-breakpoint
ALTER TABLE "caja_controles" ADD CONSTRAINT "caja_controles_caja_sesion_id_caja_sesiones_id_fk" FOREIGN KEY ("caja_sesion_id") REFERENCES "public"."caja_sesiones"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "caja_controles" ADD CONSTRAINT "caja_controles_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "ix_caja_controles_sesion" ON "caja_controles" USING btree ("caja_sesion_id");
