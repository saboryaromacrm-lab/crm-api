-- 0066 · CONTROL DE STOCK — el físico contra el virtual, como sesión de trabajo
--
-- Hasta acá no había forma de responder "¿lo que dice el sistema está de verdad
-- en la góndola?". Existía el ajuste suelto (un producto, una cantidad tipeada
-- a mano, la diferencia calculada de memoria) y la corrección puntual del
-- fraccionado. Contar un local entero era imposible de hecho.
--
-- EL CONTEO ES UNA SESIÓN, NO UNA ACCIÓN. Dura horas, se interrumpe y lo siguen
-- personas distintas — el mismo problema que el pedido de mercadería (0055), y
-- la misma solución: vive en la base desde que se abre, cada línea se guarda
-- sola, y el que entra al turno sigue donde quedó el anterior. Y es DEL LOCAL:
-- una sesión por alcance, no una por cajero.
--
-- LAS DECISIONES DEL DUEÑO (15/8/2026) QUE ESTA FORMA SOSTIENE:
--
--  1. LA LISTA SE CONGELA AL ABRIR. La sesión nace con sus renglones (los que
--     salen de los filtros: marca, categoría, proveedor, tipo) en estado
--     pendiente. Se cuenta la góndola de esa noche, no el catálogo vivo: un
--     producto dado de alta a mitad del conteo no se cuela.
--
--  2. SE TRABAJA POR DIFERENCIA, NUNCA POR VALOR ABSOLUTO. Cada línea guarda
--     el disponible DEL INSTANTE en que se contó (`virtual_al_contar`). La
--     discrepancia contado−virtual es un hecho de ese momento y no caduca.
--     Al aplicar se ajusta por esa diferencia sobre el stock actual: si el
--     sistema pisara el stock con el contado, resucitaría mercadería vendida
--     entre el conteo y la aplicación. Y como el control se hace con el LOCAL
--     CERRADO, cualquier movimiento entre contar y aplicar es una alarma que
--     la aplicación muestra con nombre y apellido — no debería haber ninguno.
--
--  3. CIEGO POR DEFECTO. El que cuenta no ve cuánto "debería" haber: se cuenta
--     lo que hay, no lo que dice el sistema. El campo es de la sesión porque
--     el jefe puede abrir una no-ciega, y el ocultamiento lo impone la API
--     (una columna escondida en pantalla se lee con F12).
--
--  4. LO NO CONTADO QUEDA COMO ESTÁ. Jamás se pone en cero un renglón
--     pendiente al aplicar: el reporte lo lista aparte y una persona decide.
--
-- El ajuste de un PAQUETE fraccionado no toca a la madre, a propósito: la
-- corrección del fraccionado (que sí compensa contra la madre) es para errores
-- de registro del fraccionamiento; acá un faltante de paquetes es pérdida
-- real — los 2 paquetes que no están no volvieron a ser granel solos.

CREATE TYPE "estado_conteo" AS ENUM ('en_curso', 'cerrado', 'aplicado', 'descartado');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "conteos" (
  "id" serial PRIMARY KEY NOT NULL,
  -- RESTRICT: un conteo aplicado es historia contable de la sucursal.
  "sucursal_id" integer NOT NULL,
  "nombre" text DEFAULT '' NOT NULL,
  -- La descripción HUMANA de los filtros, congelada ("Marca CUMANA · solo con
  -- stock"). Los ids de los filtros no hacen falta: la lista ya nació de ellos.
  "alcance" text DEFAULT '' NOT NULL,
  "ciego" boolean DEFAULT true NOT NULL,
  "estado" "estado_conteo" DEFAULT 'en_curso' NOT NULL,
  "usuario_id" integer,
  "creado_en" timestamp with time zone DEFAULT now() NOT NULL,
  "cerrado_en" timestamp with time zone,
  "aplicado_en" timestamp with time zone,
  "aplicado_por" integer
);--> statement-breakpoint

ALTER TABLE "conteos" ADD CONSTRAINT "conteos_sucursal_id_sucursales_id_fk"
  FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "conteos" ADD CONSTRAINT "conteos_usuario_id_usuarios_id_fk"
  FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "conteos" ADD CONSTRAINT "conteos_aplicado_por_usuarios_id_fk"
  FOREIGN KEY ("aplicado_por") REFERENCES "public"."usuarios"("id") ON DELETE set null;--> statement-breakpoint

-- La pregunta de siempre: "¿hay una sesión abierta en esta sucursal?"
CREATE INDEX IF NOT EXISTS "ix_conteos_sucursal" ON "conteos" ("sucursal_id", "estado");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "conteo_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "conteo_id" integer NOT NULL,
  -- RESTRICT en producto y presentación: el conteo ES huella, y "eliminar"
  -- un producto existe solo para el que no dejó ninguna (criterio de 0051).
  "producto_id" integer NOT NULL,
  "presentacion_id" integer,
  -- Nombre y tamaño CONGELADOS al abrir, como `lista`/`oferta`/`descuento` en
  -- la venta: el reporte de un conteo viejo se relee aunque renombren.
  "nombre" text DEFAULT '' NOT NULL,
  "pres_label" text DEFAULT '' NOT NULL,
  "unidad" text DEFAULT 'u' NOT NULL,
  -- NULL = pendiente de contar. El 0 es un conteo real ("no hay ninguno").
  "contado" double precision,
  -- El disponible del instante del conteo. Con esto la diferencia es un hecho
  -- y no depende de cuándo se aplique.
  "virtual_al_contar" double precision,
  "contado_por" integer,
  "contado_en" timestamp with time zone,
  -- Marcado desde el reporte: "esta diferencia es grande, volvé a la góndola".
  "recontar" boolean DEFAULT false NOT NULL
);--> statement-breakpoint

ALTER TABLE "conteo_items" ADD CONSTRAINT "conteo_items_conteo_id_conteos_id_fk"
  FOREIGN KEY ("conteo_id") REFERENCES "public"."conteos"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "conteo_items" ADD CONSTRAINT "conteo_items_producto_id_productos_id_fk"
  FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "conteo_items" ADD CONSTRAINT "conteo_items_presentacion_id_presentaciones_id_fk"
  FOREIGN KEY ("presentacion_id") REFERENCES "public"."presentaciones"("id") ON DELETE restrict;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "ix_conteo_items_conteo" ON "conteo_items" ("conteo_id");--> statement-breakpoint
-- Una fila por forma física dentro de la sesión. COALESCE porque dos NULL no
-- chocan en un UNIQUE de Postgres, y la madre (sin presentación) es una fila.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_conteo_items_forma"
  ON "conteo_items" ("conteo_id", "producto_id", COALESCE("presentacion_id", 0));--> statement-breakpoint

-- El rastro en el ledger, con el patrón de ref_transferencia_id: entero suelto,
-- sin FK — el movimiento sobrevive a cualquier limpieza del conteo.
ALTER TABLE "movimientos" ADD COLUMN IF NOT EXISTS "ref_conteo_id" integer;--> statement-breakpoint

-- Sección y acción. CONTAR pueden admin y cajero (registrar la realidad no
-- mueve stock); APLICAR es acción aparte y arranca solo en admin — el dueño
-- se la da a quien haga de encargado desde Usuarios y roles. Superadmin ya
-- tiene '*'. El mismo doble nivel que en todo el sistema: la sección da la
-- pestaña, la acción da el botón.
UPDATE "roles" SET "permisos" = "permisos" || '["almacen.conteos"]'::jsonb
WHERE "clave" IN ('admin', 'cajero') AND NOT ("permisos" ? 'almacen.conteos');--> statement-breakpoint
UPDATE "roles" SET "permisos" = "permisos" || '["conteos_aplicar"]'::jsonb
WHERE "clave" IN ('admin') AND NOT ("permisos" ? 'conteos_aplicar');
