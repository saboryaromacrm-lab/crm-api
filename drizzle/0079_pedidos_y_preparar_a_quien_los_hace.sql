-- LOS PEDIDOS: las acciones a quien de verdad las hace.
--
-- Al cerrar los permisos en la API (14/8/2026) los endpoints empezaron a exigir
-- `pedidos` y `preparar`, y ninguna migración se los dio a nadie más que al
-- Administrador. El resultado, medido rol por rol antes de esto:
--
--   Fraccionador  armar un pedido ✕ 403   prepararlo ✕ 403
--   Cajero        armar un pedido ✓       prepararlo ✕ 403
--   Administrador ambos ✓
--
-- O sea que **preparar un pedido era exclusivo del Administrador**, y el que lo
-- prepara es el del depósito. La transferencia se arma durante el día y se
-- prepara en dos listas —enteros y granel— con la mercadería en la mano: es
-- trabajo de almacén, no de escritorio. Y el Fraccionador ni siquiera podía
-- abrir el borrador de su propia ruta.
--
-- Lo que se reparte, y por qué a cada uno:
--
--   `pedidos`   → armar, enviar, recibir y cancelar. Al **Fraccionador**, que
--                 arma el pedido de su ruta. El Cajero ya lo tenía: el local
--                 pide lo que le falta.
--   `preparar`  → juntar la mercadería y tildar las listas. A los **dos**: en
--                 los Express prepara el que está en el mostrador, y en la
--                 distribuidora el del depósito.
--
-- No se toca `almacen.transferencias` (la sección, o sea la visibilidad): los
-- dos roles ya la tienen, y por eso la pantalla se veía y los botones fallaban
-- recién al apretarlos — el peor de los dos mundos.
--
-- Idempotente: se puede correr sobre una base que ya los tenga.

UPDATE roles
   SET permisos = permisos || '["pedidos"]'::jsonb
 WHERE clave = 'fraccionador'
   AND NOT (permisos @> '["pedidos"]'::jsonb);

UPDATE roles
   SET permisos = permisos || '["preparar"]'::jsonb
 WHERE clave IN ('fraccionador', 'cajero')
   AND NOT (permisos @> '["preparar"]'::jsonb);
