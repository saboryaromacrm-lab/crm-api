-- RESCATE DE UNA MIGRACIÓN QUE NUNCA CORRIÓ.
--
-- `0063_gastos_anular_e_indice.sql` existe en la carpeta desde el 14/8/2026 y
-- **no está en `_journal.json`**: hay DOS archivos numerados 0063 y solo uno
-- quedó anotado. `db:migrate` lee el journal, no la carpeta, así que ese
-- archivo nunca se aplicó en ninguna base creada desde entonces — y no hay
-- error: el deploy dice "migraciones aplicadas" y sigue de largo.
--
-- No alcanza con agregarlo al journal con su número viejo: el migrador de
-- drizzle compara el `when` de cada entrada contra la ÚLTIMA aplicada, así que
-- una entrada con fecha anterior se saltea igual. Por eso se rescata como
-- migración nueva, al final de la fila.
--
-- Las dos cosas que arrastra, y las dos son de verdad:
--
-- 1) `gastos_anular` está en el catálogo de permisos desde el primer día y
--    **ningún rol la tiene**. Mientras el endpoint no pedía permiso no se
--    notaba; desde que se cerró (14/8) el botón "Anular" devuelve 403 para
--    todos menos el superadmin, que pasa por el comodín. Le corresponde al
--    Administrador: anular un gasto saca del resumen del mes algo que se
--    cargó. El cajero NO la recibe — él paga, no decide qué deja de contar.
--
-- 2) `gastos.recurrente_id` sin índice. La generación de gastos fijos consulta
--    por esa columna DENTRO de la transacción que sostiene el candado sobre
--    las plantillas: un seq scan de la tabla entera con las filas bloqueadas.
--    Hoy son pocas; crece con todos los gastos de la historia.
--
-- Las dos sentencias son IDEMPOTENTES a propósito: en la base de desarrollo ya
-- están aplicadas (a mano, en su momento) y esto tiene que poder correr ahí sin
-- romper nada.

UPDATE roles
   SET permisos = permisos || '["gastos_anular"]'::jsonb
 WHERE clave = 'admin'
   AND NOT (permisos @> '["gastos_anular"]'::jsonb);

CREATE INDEX IF NOT EXISTS ix_gastos_recurrente ON gastos (recurrente_id);
