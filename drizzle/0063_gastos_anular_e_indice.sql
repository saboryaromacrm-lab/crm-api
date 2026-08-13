-- GASTOS: la acción "Anular gastos" no la tenía NADIE, y el índice que faltaba.
--
-- 1) `gastos_anular` existe en el catálogo de permisos desde el primer día
--    (`usuarios.module.ts`), se puede tildar en la pantalla de roles… y ninguna
--    migración se la dio a nadie. Mientras el endpoint no pedía permiso eso no
--    se notaba; al cerrarlo (14/8) el botón "Anular" pasó a devolver 403 para
--    TODOS menos el superadmin, que pasa por el comodín. Se la damos al rol
--    Administrador, que es de quien es la responsabilidad: anular un gasto
--    borra del resumen del mes algo que se cargó, y por eso el catálogo la
--    declara como acción aparte y no la incluye en la sección.
--
--    El cajero NO la recibe: él paga (`gastos_pagar_proveedor`, que ya tiene),
--    no decide qué comprobante deja de contar.
--
-- 2) `gastos.recurrente_id` no tenía índice, y la generación de gastos fijos
--    consulta por esa columna DENTRO de la transacción que sostiene el candado
--    sobre las plantillas: un seq scan de la tabla entera con las filas
--    bloqueadas. Hoy son pocas; crece con todos los gastos de la historia.

UPDATE roles
   SET permisos = permisos || '["gastos_anular"]'::jsonb
 WHERE clave = 'admin'
   AND NOT (permisos @> '["gastos_anular"]'::jsonb);

CREATE INDEX IF NOT EXISTS ix_gastos_recurrente ON gastos (recurrente_id);
