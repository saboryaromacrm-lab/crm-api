-- MAYORISTA POR AVISO Y POR BULTO CERRADO (1/10/2026, pedido del dueño).
-- El renglón que llegó al precio mayorista porque el ticket lleva la caja
-- cerrada del producto queda anotado con su propio origen, para poder
-- auditar por qué se cobró mayorista.
ALTER TYPE "public"."origen_lista" ADD VALUE IF NOT EXISTS 'bulto';
