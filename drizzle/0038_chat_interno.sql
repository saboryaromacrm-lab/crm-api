-- Chat interno por sucursal (fase 1: solo la distribuidora, gate por tipo de
-- sucursal en la API). Mensajes en la base + marca de lectura por usuario.
CREATE TABLE IF NOT EXISTS "chat_mensajes" (
	"id" serial PRIMARY KEY NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"sucursal_id" integer NOT NULL,
	"usuario_id" integer,
	"texto" text NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_lecturas" (
	"id" serial PRIMARY KEY NOT NULL,
	"sucursal_id" integer NOT NULL,
	"usuario_id" integer NOT NULL,
	"ultimo_mensaje_id" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
ALTER TABLE "chat_mensajes" ADD CONSTRAINT "chat_mensajes_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_mensajes" ADD CONSTRAINT "chat_mensajes_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_lecturas" ADD CONSTRAINT "chat_lecturas_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_lecturas" ADD CONSTRAINT "chat_lecturas_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_chat_mensajes_canal" ON "chat_mensajes" ("sucursal_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_lectura" ON "chat_lecturas" ("sucursal_id","usuario_id");
