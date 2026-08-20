-- ARCA · EL TICKET DE ACCESO DEL WSAA (0074)
-- ============================================================================
-- No es un cache por performance: ARCA RECHAZA pedir un ticket nuevo mientras
-- haya otro vigente ("Ya posee un TA válido"). Dura ~12 horas, así que sin
-- esta tabla el primer reinicio de la API deja la facturación trabada hasta
-- que el anterior venza.
--
-- `service` lleva el ENTORNO adentro (`wsfe` vs `wsfe@prod`): un ticket de
-- homologación no sirve en producción, y con una sola clave el sistema le
-- mandaría al ARCA real el permiso de pruebas.
--
-- token y sign son credenciales EFÍMERAS que emite ARCA. La clave privada del
-- certificado nunca se guarda en la base.

CREATE TABLE IF NOT EXISTS "arca_tokens" (
  "service"    text PRIMARY KEY,
  "token"      text NOT NULL,
  "sign"       text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
