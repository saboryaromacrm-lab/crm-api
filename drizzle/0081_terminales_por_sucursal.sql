-- TERMINALES: el equipo sabe en qué sucursal está, así la cajera no elige.
--
-- EL PROBLEMA. La sucursal se elegía a mano en el login, de un desplegable que
-- venía **precargado con la primera de la lista** (la Distribuidora). La cajera
-- de Express 2 que no tocaba ese campo entraba en la Distribuidora sin haber
-- elegido nada, y desde ahí vendía descontando el stock del local equivocado.
-- Como las cajeras rotan, confundirse era cuestión de tiempo.
--
-- Y NO LO DETECTA NADIE. Contra la intuición, el cierre de caja tampoco: el
-- arqueo es internamente coherente —vendió, cobró, contó su cajón, la
-- diferencia da cero—. Lo que queda roto es el stock de dos locales y plata
-- física de un local anotada en otro, y eso no aparece hasta un control de
-- stock semanas después. Desde ARCA es peor: cada sucursal tiene su punto de
-- venta con numeración propia y su domicilio impreso, así que una factura mal
-- emitida consume un número que no vuelve y sale con el domicilio de otro
-- local, con CAE y sin poder borrarse.
--
-- POR QUÉ EL EQUIPO Y NO LA PERSONA. Las cajeras rotan entre locales: asignarle
-- una sucursal a cada una obligaría a reasignarlas a mano todos los días. La PC
-- de Express 2, en cambio, está siempre en Express 2. Se ata el dato a lo que
-- está clavado, no a lo que se mueve.
--
-- POR QUÉ NO POR IP. Se evaluó y se descartó: cuando se corta internet las
-- cajeras siguen vendiendo con los datos de su celular, así que la IP pasa a
-- ser la del operador móvil, cambia sola y dos locales pueden verse iguales.
-- El aviso saltaría justo los días de más quilombo, y un aviso que suena cuando
-- no corresponde enseña a ignorar todos los avisos. El token de la terminal
-- vive en el navegador y no en la red: anda igual con fibra, con el repetidor
-- de la Distribuidora o colgado de un celular.
--
-- Idempotente: se puede correr sobre una base que ya lo tenga.

CREATE TABLE IF NOT EXISTS terminales (
  id            serial PRIMARY KEY,
  nombre        text NOT NULL,
  sucursal_id   integer NOT NULL REFERENCES sucursales(id) ON DELETE CASCADE,
  token_hash    text NOT NULL,
  activa        boolean NOT NULL DEFAULT true,
  creada_en     timestamptz NOT NULL DEFAULT now(),
  creada_por    integer REFERENCES usuarios(id) ON DELETE SET NULL,
  ultimo_uso    timestamptz,
  ultimo_agente text NOT NULL DEFAULT ''
);

-- El token identifica UN equipo: dos filas con el mismo hash harían que la
-- sucursal dependa de cuál devuelve primero la consulta.
CREATE UNIQUE INDEX IF NOT EXISTS ix_terminales_token ON terminales (token_hash);
CREATE INDEX IF NOT EXISTS ix_terminales_sucursal ON terminales (sucursal_id);
