-- Chat privado 1-a-1: el mensaje gana destinatario (NULL = canal grupal) y la
-- marca de lectura pasa a ser POR CONVERSACION (0 = grupal, otro = el privado
-- con ese usuario).
ALTER TABLE "chat_mensajes" ADD COLUMN "para_usuario_id" integer;--> statement-breakpoint
ALTER TABLE "chat_mensajes" ADD CONSTRAINT "chat_mensajes_para_usuario_id_usuarios_id_fk" FOREIGN KEY ("para_usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_chat_mensajes_para" ON "chat_mensajes" ("sucursal_id","para_usuario_id","id");--> statement-breakpoint
ALTER TABLE "chat_lecturas" ADD COLUMN "canal_usuario_id" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "uq_chat_lectura";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_chat_lectura" ON "chat_lecturas" ("sucursal_id","usuario_id","canal_usuario_id");
