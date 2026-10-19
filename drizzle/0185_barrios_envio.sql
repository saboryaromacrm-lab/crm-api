-- ===========================================================================
-- 0185 · TIENDA MINORISTA › BARRIOS Y ENVÍO (19/10/2026)
-- ===========================================================================
-- El cliente marca en el mapa (Google Maps) dónde recibe; el servidor decide
-- en qué barrio cae y, con eso, el costo del envío y las promos del barrio
-- («Envío gratis a Independencia los martes»). Los barrios los dibuja el dueño
-- en Tienda online › Configuración › Tienda minorista, de a uno, cuando hace
-- falta: fuera de todo barrio rige la regla general de siempre.
--
--   · barrios: el contorno ([[lat, lng], …]) y su costo de envío (NULL = sin
--     costo propio: se coordina, o la regla general de «gratis desde»).
--   · barrio_promos: envío gratis, envío a precio fijo o descuento %, para uno
--     o varios barrios, por días de la semana (0 = domingo; vacío = todos) y
--     fechas opcionales, con compra mínima opcional.
--   · tienda_compradores.lat / lng: dónde recibe (el envío a «mi dirección
--     guardada» sabe su barrio sin volver a marcarla). El navegador no la ve.

CREATE TABLE barrios (
  id serial PRIMARY KEY,
  nombre text NOT NULL,
  poligono jsonb NOT NULL,
  costo_envio double precision CHECK (costo_envio IS NULL OR costo_envio >= 0),
  activo boolean NOT NULL DEFAULT true,
  actualizado_en timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_barrios_nombre ON barrios (lower(nombre));

CREATE TABLE barrio_promos (
  id serial PRIMARY KEY,
  barrio_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  tipo text NOT NULL CHECK (tipo IN ('envio_gratis', 'envio_fijo', 'descuento')),
  valor double precision NOT NULL DEFAULT 0 CHECK (valor >= 0),
  dias jsonb NOT NULL DEFAULT '[]'::jsonb,
  desde date,
  hasta date,
  minimo double precision NOT NULL DEFAULT 0 CHECK (minimo >= 0),
  activa boolean NOT NULL DEFAULT true,
  actualizado_en timestamp with time zone NOT NULL DEFAULT now(),
  CHECK (desde IS NULL OR hasta IS NULL OR desde <= hasta)
);

ALTER TABLE tienda_compradores
  ADD COLUMN lat double precision,
  ADD COLUMN lng double precision;
