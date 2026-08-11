-- ============================================================================
-- UN SOLO BORRADOR POR RUTA (origen → destino)
-- ============================================================================
-- El borrador es EL PEDIDO DEL LOCAL, no el de un cajero. Si fuera de cada
-- uno, Marta arma el suyo a la mañana y Carla el suyo a la tarde, y la
-- Distribuidora recibe DOS pedidos para Express 3 el mismo día: prepara dos
-- veces y manda mercadería duplicada. El que entra sigue la lista que dejó el
-- otro, que es lo que pasa en el mostrador.
--
-- El índice es el candado de verdad: el `get-or-create` de la API hace SELECT
-- y después INSERT, así que dos cajeros abriendo el pedido en el mismo
-- segundo crearían dos borradores. Con el único, el segundo INSERT falla y la
-- API vuelve a leer el que ganó.
--
-- Parcial a propósito: la unicidad vale SOLO mientras está en borrador. Una
-- vez enviado hay tantos pedidos por ruta como haga falta, que es lo normal.
CREATE UNIQUE INDEX IF NOT EXISTS "transfer_borrador_unico"
  ON "transferencias" ("origen_id", "destino_id")
  WHERE "estado" = 'borrador';
