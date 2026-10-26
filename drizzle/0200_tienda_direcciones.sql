-- 0200 · LAS DIRECCIONES GUARDADAS DEL COMPRADOR MINORISTA (25/10/2026, pedido del dueño: «dos
-- direcciones guardadas con nombre, por ejemplo trabajo y casa»). Pasan a su propia tabla, con
-- nombre; la que cada uno tenía queda como «Casa» con su punto del mapa. El tope (dos) lo pone
-- el servidor (`MAX_DIRECCIONES`): cambiarlo no pide migración.
CREATE TABLE IF NOT EXISTS tienda_direcciones (
  id serial PRIMARY KEY,
  comprador_id integer NOT NULL REFERENCES tienda_compradores(id) ON DELETE CASCADE,
  nombre text NOT NULL,
  direccion text NOT NULL,
  localidad text NOT NULL DEFAULT '',
  referencia text NOT NULL DEFAULT '',
  lat double precision,
  lng double precision,
  creado_en timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);
-- Un nombre por comprador («Casa» y «casa» son la misma): guardar con un nombre que ya tiene la reemplaza.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tienda_direcciones_nombre ON tienda_direcciones (comprador_id, lower(nombre));
INSERT INTO tienda_direcciones (comprador_id, nombre, direccion, localidad, referencia, lat, lng, creado_en, actualizado_en)
  SELECT id, 'Casa', direccion, localidad, referencia, lat, lng, creado_en, actualizado_en
  FROM tienda_compradores WHERE direccion <> '';
ALTER TABLE tienda_compradores DROP COLUMN direccion, DROP COLUMN localidad, DROP COLUMN referencia, DROP COLUMN lat, DROP COLUMN lng;
