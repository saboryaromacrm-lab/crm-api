-- ===========================================================================
-- 0102 · HISTORIAL DE FRACCIONAMIENTO Y OPERADORES (23/9/2026, pedido del dueno)
-- ===========================================================================
-- Hasta aca cada fraccionamiento dejaba UN movimiento con el detalle escrito
-- en texto ("Fracciono 5 kg en 10x500 g"): se podia leer, no filtrar ni sumar.
-- Y el autor era el usuario logueado, que en el puesto de fraccionado es una
-- cuenta compartida: tres personas fraccionando quedaban a nombre de una.
--
-- `fraccion_operadores` — las personas que fraccionan, SIN usuario ni clave.
--   No se borran (el historial las nombra): se desactivan. Nombre unico sin
--   importar mayusculas, para que "Juan" y "juan" no partan el reporte en dos.
--   `sucursal_id` NULL = trabaja en cualquier sucursal.
--
-- `fraccionamientos` — el REGISTRO, como un comprobante: la cabecera (cuando,
--   donde, quien lo hizo, quien lo cargo) y sus renglones. Un registro puede
--   traer varios productos: es la tanda de trabajo, no un producto suelto.
--   Origen:
--     manual     · "Registrar fraccionado"
--     correccion · "puse 20 y son 19" (paquetes y kilos con SIGNO)
--     pedido     · lo que la preparacion de un pedido armo sola para completarse
--   `kg` y `paquetes` van desnormalizados (con signo) para pintar la fila sin
--   sumar renglones; los totales del reporte salen de los renglones.
--
--   CUANDO SE HIZO vs CUANDO SE CARGO. Muchas veces se asienta despues ("me
--   olvide de cargar lo de ayer a la manana"): `fecha` + `turno` son el
--   trabajo, `registrado_en` es la carga. Cargado en el momento, las dos
--   fechas son la MISMA (now() de la transaccion); asentado despues, `fecha`
--   es el comienzo de ese turno y la diferencia queda a la vista.
--
-- `fraccionamiento_items` — que producto, de que tamano y cuantos paquetes.
--   El tamano se CONGELA: si manana el paquete pasa de 500 g a 450 g, lo
--   armado ayer sigue diciendo lo que se armo. `movimiento_id` es el
--   movimiento de stock de ESE producto en ese registro.
--
-- Sin backfill (decision del dueno): el historial arranca hoy.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "fraccion_operadores" (
  "id" serial PRIMARY KEY NOT NULL,
  "nombre" text NOT NULL,
  "sucursal_id" integer REFERENCES "sucursales"("id") ON DELETE SET NULL,
  "activo" boolean NOT NULL DEFAULT true,
  "creado_en" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ck_fraccion_operadores_nombre" CHECK (length(btrim("nombre")) > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_fraccion_operadores_nombre" ON "fraccion_operadores" (lower(btrim("nombre")));--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fraccionamientos" (
  "id" serial PRIMARY KEY NOT NULL,
  "fecha" timestamp with time zone NOT NULL DEFAULT now(),
  "turno" text NOT NULL,
  "registrado_en" timestamp with time zone NOT NULL DEFAULT now(),
  "origen" text NOT NULL,
  "sucursal_id" integer REFERENCES "sucursales"("id") ON DELETE SET NULL,
  -- RESTRICT: un operador con historial no se borra, se desactiva.
  "operador_id" integer REFERENCES "fraccion_operadores"("id") ON DELETE RESTRICT,
  "usuario_id" integer REFERENCES "usuarios"("id") ON DELETE SET NULL,
  "kg" double precision NOT NULL DEFAULT 0,
  "paquetes" integer NOT NULL DEFAULT 0,
  "transferencia_id" integer REFERENCES "transferencias"("id") ON DELETE SET NULL,
  "motivo" text NOT NULL DEFAULT '',
  CONSTRAINT "ck_fraccionamientos_origen" CHECK ("origen" IN ('manual', 'correccion', 'pedido')),
  CONSTRAINT "ck_fraccionamientos_turno" CHECK ("turno" IN ('manana', 'tarde'))
);--> statement-breakpoint
-- El listado siempre pide lo ultimo primero, acotado por fecha; los otros dos
-- son los filtros de cabecera que acotan por si solos (un local, un operador).
CREATE INDEX IF NOT EXISTS "ix_fracc_fecha" ON "fraccionamientos" ("fecha" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_fracc_suc_fecha" ON "fraccionamientos" ("sucursal_id", "fecha" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_fracc_oper_fecha" ON "fraccionamientos" ("operador_id", "fecha" DESC);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fraccionamiento_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "fraccionamiento_id" integer NOT NULL REFERENCES "fraccionamientos"("id") ON DELETE CASCADE,
  "producto_id" integer REFERENCES "productos"("id") ON DELETE SET NULL,
  "presentacion_id" integer REFERENCES "presentaciones"("id") ON DELETE SET NULL,
  "tam_kg" double precision NOT NULL,
  "paquetes" integer NOT NULL,
  "movimiento_id" integer REFERENCES "movimientos"("id") ON DELETE SET NULL,
  CONSTRAINT "ck_fracc_items_paquetes" CHECK ("paquetes" <> 0),
  CONSTRAINT "ck_fracc_items_tam" CHECK ("tam_kg" > 0)
);--> statement-breakpoint
-- Los renglones de un registro, con lo que suman los totales: se resuelven
-- leyendo solo el indice, sin ir a la tabla.
CREATE INDEX IF NOT EXISTS "ix_fracc_items_fracc" ON "fraccionamiento_items" ("fraccionamiento_id", "tam_kg") INCLUDE ("paquetes", "producto_id");--> statement-breakpoint
-- "Lo que se fracciono de ESTE producto": el filtro por producto entra por aca.
CREATE INDEX IF NOT EXISTS "ix_fracc_items_prod" ON "fraccionamiento_items" ("producto_id", "fraccionamiento_id");--> statement-breakpoint

-- ── Llave ───────────────────────────────────────────────────────────────────
-- Dar de alta y de baja operadores es del encargado, no del puesto: la cuenta
-- compartida del fraccionador no puede inventarse nombres. Arranca en admin;
-- superadmin ya tiene '*'.
UPDATE "roles" SET "permisos" = "permisos" || '["fraccion_operadores"]'::jsonb
WHERE "clave" = 'admin' AND NOT ("permisos" ? 'fraccion_operadores');
