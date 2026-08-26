-- AUDITORÍA DE CAMBIOS: quién tocó qué y cuándo, con el valor viejo y el nuevo.
--
-- PARA QUÉ. Las condiciones comerciales de un proveedor (costo de lista,
-- descuentos, flete %, sin factura %, percepciones, cómo cobra) definen los
-- costos y arrastran los precios de góndola — y hasta hoy se pisaban en el
-- lugar, sin rastro: alguien tocaba el "Sin factura %" y el margen de noventa
-- productos cambiaba en silencio. Los documentos (facturas, pagos) ya quedan
-- firmados con usuario y fecha; lo que no tenía firma eran los cambios A MANO.
--
-- LA TABLA ES GENERAL A PROPÓSITO (entidad + entidad_id), no "de proveedores":
-- es el mismo mecanismo que va a alimentar Gerencia › Auditoría el día que se
-- construya esa vista. Hoy escribe el primer cliente: las condiciones
-- comerciales del proveedor (formato de compra, percepciones, ficha comercial).
--
-- Cada fila es UN campo que cambió: fecha, quién, dónde (ámbito + detalle),
-- qué campo, antes → después. Solo se graba lo que efectivamente cambió.
--
-- usuario_id con SET NULL: borrar un usuario no puede borrar la historia de
-- lo que hizo (los usuarios además no se borran, se desactivan — esto es el
-- cinturón por si algún día uno se elimina de verdad).
--
-- Idempotente: se puede correr sobre una base que ya lo tenga.

CREATE TABLE IF NOT EXISTS auditoria (
  id          serial PRIMARY KEY,
  fecha       timestamptz NOT NULL DEFAULT now(),
  usuario_id  integer REFERENCES usuarios(id) ON DELETE SET NULL,
  entidad     text NOT NULL,
  entidad_id  integer NOT NULL,
  ambito      text NOT NULL,
  detalle     text NOT NULL DEFAULT '',
  campo       text NOT NULL,
  antes       text NOT NULL DEFAULT '',
  despues     text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS ix_auditoria_entidad ON auditoria (entidad, entidad_id, id DESC);
