-- El chat interno se eliminó del sistema (14/9/2026, pedido del dueño): se
-- van sus dos tablas. Los mensajes eran conversación de 24 horas, no archivo,
-- así que no hay nada que conservar ni migrar.
DROP TABLE "chat_lecturas" CASCADE;--> statement-breakpoint
DROP TABLE "chat_mensajes" CASCADE;