-- LA NOTA DE CRÉDITO ES DE ADMINISTRACIÓN, y ahora está escrito donde manda.
--
-- El endpoint pedía `devoluciones`, que **el cajero tiene** desde la 0024. El
-- candado de "solo el jefe emite notas de crédito" vivía únicamente en el
-- navegador (`esJefe` en el modal): un cajero con la sesión abierta podía
-- emitir una nota de crédito de cualquier venta de su sucursal sin tocar la
-- pantalla, con un POST. Auditoría del 21/8/2026.
--
-- Y no es un permiso más: la nota de crédito **saca plata del cajón** cuando
-- lleva devolución en efectivo, borra la deuda del cliente y da vuelta el
-- débito fiscal. Es la operación más delicada del módulo.
--
-- Se hace con una ACCIÓN PROPIA en vez de un `if (esAdmin)` en el código,
-- porque así la regla queda donde se administra —Usuarios y roles— y el día
-- que el dueño quiera dársela a un encargado no hay que tocar el sistema.
-- `devoluciones` sigue existiendo y sigue siendo del cajero: es la que habilita
-- ANULAR, que es otra cosa (un comprobante nuestro, sin CAE, que no salió a
-- ARCA).
--
-- Decisión del dueño, 21/8/2026: solo el administrador.
--
-- Idempotente: se puede correr sobre una base que ya lo tenga.

UPDATE roles
   SET permisos = permisos || '["nota_credito"]'::jsonb
 WHERE clave = 'admin'
   AND NOT (permisos @> '["nota_credito"]'::jsonb);
