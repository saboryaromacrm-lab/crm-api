-- ===========================================================================
-- 0182 · SISTEMA › FERIADOS DE FORMOSA CAPITAL (19/10/2026)
-- ===========================================================================
-- Los feriados y días no laborables, y qué hace cada sucursal ese día (abre o
-- no, horario, nota; sin fila = sin definir). La sección es de administración:
-- el rol admin recibe la llave (el superadmin pasa por `*`).
--
-- Carga inicial 2025 y 2026, verificada el 19/10/2026:
--   · nacionales: ArgentinaDatos (inamovible / trasladable = feriado; puente =
--     día no laborable) + Jueves Santo (no laborable, Ley 27.399);
--   · Formosa: calendario del Poder Judicial de Formosa («Días no laborables -
--     Feriados provinciales»): fundación (8/4), provincialización (28/6) y la
--     patrona de la provincia (16/7).
-- Los nombres son los de `src/feriados/reglas.ts`: «Traer feriados de AAAA» no
-- los duplica. Los años que vengan se traen desde la pantalla.

CREATE TABLE feriados (
  id serial PRIMARY KEY,
  fecha date NOT NULL,
  nombre text NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('feriado', 'no_laborable')),
  alcance text NOT NULL CHECK (alcance IN ('nacional', 'provincial', 'municipal')),
  observaciones text NOT NULL DEFAULT '',
  actualizado_en timestamp with time zone NOT NULL DEFAULT now(),
  actualizado_por integer REFERENCES usuarios(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX uq_feriados_fecha_nombre ON feriados (fecha, nombre);

CREATE TABLE feriado_sucursales (
  feriado_id integer NOT NULL REFERENCES feriados(id) ON DELETE CASCADE,
  sucursal_id integer NOT NULL REFERENCES sucursales(id) ON DELETE CASCADE,
  abre boolean NOT NULL,
  horario text NOT NULL DEFAULT '',
  nota text NOT NULL DEFAULT '',
  PRIMARY KEY (feriado_id, sucursal_id)
);

UPDATE roles
   SET permisos = permisos || '["sistema.feriados"]'::jsonb
 WHERE clave = 'admin'
   AND NOT (permisos @> '["sistema.feriados"]'::jsonb);

INSERT INTO feriados (fecha, nombre, tipo, alcance) VALUES
  -- 2025 · nacionales
  ('2025-01-01', 'Año nuevo', 'feriado', 'nacional'),
  ('2025-03-03', 'Carnaval', 'feriado', 'nacional'),
  ('2025-03-04', 'Carnaval', 'feriado', 'nacional'),
  ('2025-03-24', 'Día Nacional de la Memoria por la Verdad y la Justicia', 'feriado', 'nacional'),
  ('2025-04-02', 'Día del Veterano y de los Caídos en la Guerra de Malvinas', 'feriado', 'nacional'),
  ('2025-04-17', 'Jueves Santo', 'no_laborable', 'nacional'),
  ('2025-04-18', 'Viernes Santo', 'feriado', 'nacional'),
  ('2025-05-01', 'Día del Trabajador', 'feriado', 'nacional'),
  ('2025-05-02', 'Puente turístico no laborable', 'no_laborable', 'nacional'),
  ('2025-05-25', 'Día de la Revolución de Mayo', 'feriado', 'nacional'),
  ('2025-06-16', 'Paso a la Inmortalidad del General Martín Güemes', 'feriado', 'nacional'),
  ('2025-06-20', 'Paso a la Inmortalidad del General Manuel Belgrano', 'feriado', 'nacional'),
  ('2025-07-09', 'Día de la Independencia', 'feriado', 'nacional'),
  ('2025-08-15', 'Puente turístico no laborable', 'no_laborable', 'nacional'),
  ('2025-08-17', 'Paso a la Inmortalidad del Gral. José de San Martín', 'feriado', 'nacional'),
  ('2025-10-10', 'Puente turístico no laborable', 'no_laborable', 'nacional'),
  ('2025-10-12', 'Día del Respeto a la Diversidad Cultural', 'feriado', 'nacional'),
  ('2025-11-21', 'Puente turístico no laborable', 'no_laborable', 'nacional'),
  ('2025-11-24', 'Día de la Soberanía Nacional', 'feriado', 'nacional'),
  ('2025-12-08', 'Día de la Inmaculada Concepción de María', 'feriado', 'nacional'),
  ('2025-12-25', 'Navidad', 'feriado', 'nacional'),
  -- 2025 · Formosa
  ('2025-04-08', 'Aniversario de la fundación de Formosa (1879)', 'no_laborable', 'provincial'),
  ('2025-06-28', 'Provincialización de Formosa (1955)', 'no_laborable', 'provincial'),
  ('2025-07-16', 'Nuestra Señora del Carmen, patrona de la provincia de Formosa', 'no_laborable', 'provincial'),
  -- 2026 · nacionales
  ('2026-01-01', 'Año nuevo', 'feriado', 'nacional'),
  ('2026-02-16', 'Carnaval', 'feriado', 'nacional'),
  ('2026-02-17', 'Carnaval', 'feriado', 'nacional'),
  ('2026-03-23', 'Puente turístico no laborable', 'no_laborable', 'nacional'),
  ('2026-03-24', 'Día Nacional de la Memoria por la Verdad y la Justicia', 'feriado', 'nacional'),
  ('2026-04-02', 'Día del Veterano y de los Caídos en la Guerra de Malvinas', 'feriado', 'nacional'),
  ('2026-04-02', 'Jueves Santo', 'no_laborable', 'nacional'),
  ('2026-04-03', 'Viernes Santo', 'feriado', 'nacional'),
  ('2026-05-01', 'Día del Trabajador', 'feriado', 'nacional'),
  ('2026-05-25', 'Día de la Revolución de Mayo', 'feriado', 'nacional'),
  ('2026-06-15', 'Paso a la Inmortalidad del General Martín Güemes (17/6)', 'feriado', 'nacional'),
  ('2026-06-20', 'Paso a la Inmortalidad del General Manuel Belgrano', 'feriado', 'nacional'),
  ('2026-07-09', 'Día de la Independencia', 'feriado', 'nacional'),
  ('2026-07-10', 'Puente turístico no laborable', 'no_laborable', 'nacional'),
  ('2026-08-17', 'Paso a la Inmortalidad del Gral. José de San Martín', 'feriado', 'nacional'),
  ('2026-10-12', 'Día del Respeto a la Diversidad Cultural', 'feriado', 'nacional'),
  ('2026-11-09', 'Visita del papa León XIV', 'feriado', 'nacional'),
  ('2026-11-23', 'Día de la Soberanía Nacional (20/11)', 'feriado', 'nacional'),
  ('2026-12-07', 'Puente turístico no laborable', 'no_laborable', 'nacional'),
  ('2026-12-08', 'Día de la Inmaculada Concepción de María', 'feriado', 'nacional'),
  ('2026-12-25', 'Navidad', 'feriado', 'nacional'),
  -- 2026 · Formosa
  ('2026-04-08', 'Aniversario de la fundación de Formosa (1879)', 'no_laborable', 'provincial'),
  ('2026-06-28', 'Provincialización de Formosa (1955)', 'no_laborable', 'provincial'),
  ('2026-07-16', 'Nuestra Señora del Carmen, patrona de la provincia de Formosa', 'no_laborable', 'provincial')
ON CONFLICT (fecha, nombre) DO NOTHING;
