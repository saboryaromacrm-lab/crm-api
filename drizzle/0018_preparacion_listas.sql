-- Preparación en dos listas (enteros / fraccionados) sobre la fase "preparada".
-- La reserva de stock pasa a hacerse POR LISTA al confirmarla, no al entrar en preparación.
ALTER TABLE "transferencias" ADD COLUMN "enteros_listo" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "transferencias" ADD COLUMN "granel_listo" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "transferencia_items" ADD COLUMN "cantidad_preparada" double precision NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "transferencia_items" ADD COLUMN "agregado" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "transferencia_items" ADD COLUMN "motivo" text NOT NULL DEFAULT '';--> statement-breakpoint
-- Backfill: en el modelo viejo lo preparado ERA lo pedido.
UPDATE "transferencia_items" SET "cantidad_preparada" = "cantidad";--> statement-breakpoint
-- Las que ya estaban "preparadas" tienen TODA la reserva tomada: equivalen a
-- ambas listas confirmadas, y el despacho las trata exactamente igual.
UPDATE "transferencias" SET "enteros_listo" = true, "granel_listo" = true WHERE "estado" = 'preparada';
