-- REGISTRAR UN EQUIPO ES DE ADMINISTRACIÓN.
--
-- Registrar una terminal decide en qué sucursal opera **todo el que se siente
-- ahí**: no es una preferencia de la máquina, es la misma clase de decisión que
-- crear un usuario o mover el punto de venta de un local. Por eso la sección
-- Sistema › Este equipo nace con la llave del administrador y no del cajero.
--
-- Y sobre todo: si la pudiera tocar el mostrador, el arreglo no serviría de
-- nada. Todo el sentido de la terminal es que la sucursal deje de ser algo que
-- se elige en el momento de entrar — dejar que se reasigne desde la misma
-- pantalla sería volver al desplegable con un paso más.
--
-- El superadmin no se toca: pasa por `*` sin permisos enumerados.
--
-- Idempotente: se puede correr sobre una base que ya lo tenga.

UPDATE roles
   SET permisos = permisos || '["sistema.terminales"]'::jsonb
 WHERE clave = 'admin'
   AND NOT (permisos @> '["sistema.terminales"]'::jsonb);
