-- 0068 · MÓDULO PROVEEDORES — la app externa de cuentas por pagar se vuelve módulo
--
-- El dueño venía llevando la relación con sus proveedores en una app aparte
-- (PHP+MySQL): pedidos en kanban, compromisos de cuenta corriente, echeqs,
-- estados de cuenta con conciliación. La app se APAGA y su lógica entra acá,
-- pero NO su núcleo contable: facturas, pagos, imputaciones y saldos ya existen
-- en este sistema, más robustos (candados de concurrencia, permisos por
-- usuario, caja). Lo que esta migración agrega es exactamente LO QUE FALTABA:
--
--  1. LA FICHA COMERCIAL del proveedor: cómo factura (la "liquidación" de acá
--     es el "remito" de allá — la mitad sin factura), cómo se le paga
--     habitualmente, a cuántos días, y el MODO DE CUENTA:
--       'facturas' → cada pago se imputa a facturas puntuales POR EL TOTAL
--       'libre'    → pagos a cuenta contra la deuda global (2 proveedores hoy)
--     Más la marca de conciliación ("cuadré con su resumen hasta esta fecha").
--
--  2. COMPROMISOS: el vencimiento como entidad. La factura confirmada de un
--     proveedor de cta cte/echeq genera su(s) compromiso(s) — editables, con
--     cuotas a mano — y el pago que salda la factura los cierra SOLO (el
--     puente que en la app vieja se llamaba sincronizarProximos y acá corre
--     dentro de la misma transacción que el pago).
--
--  3. ECHEQS propios: cartera con estados; "cobrado" ejecuta el circuito
--     entero (pago + imputación + cierre del compromiso).
--
--  4. AJUSTES manuales del estado de cuenta (con signo y motivo obligatorio)
--     y PEDIDOS al proveedor (kanban informal admin ↔ encargado de compras).
--
--  5. PAGO MULTI-FORMA: un pago partido en N medios, cada parte con su fecha
--     opcional ("transferí una parte hace 10 días y el resto hoy").
--
-- Del modelo viejo NO viajan: su login/permisos (acá hay roles por usuario),
-- su catálogo de productos (el nuestro es nativo), sus notas, su detección de
-- "forma diferida" por substring del nombre (acá es un dato del padrón), ni
-- la trampa del pago borrado que seguía sumando (nuestras imputaciones ya
-- se anulan con su pago).

-- ── La ficha comercial ──────────────────────────────────────────────────────
-- 'liquidacion' = lo que la app viejo llamaba REM: la mitad que entra sin
-- factura y se paga igual. Ya existe como tipo de comprobante acá.
CREATE TYPE "condicion_compra_prov" AS ENUM ('factura', 'liquidacion', 'mixto');--> statement-breakpoint
-- El medio HABITUAL con el que este proveedor cobra. Uno solo, como en la app:
-- 'cta_cte' y 'echeq' son los diferidos — la factura confirmada genera
-- compromiso. NULL = sin definir (no genera nada).
CREATE TYPE "medio_habitual_prov" AS ENUM ('efectivo', 'transferencia', 'deposito', 'echeq', 'cta_cte');--> statement-breakpoint
CREATE TYPE "modo_cuenta_prov" AS ENUM ('facturas', 'libre');--> statement-breakpoint

ALTER TABLE "proveedores" ADD COLUMN IF NOT EXISTS "condicion_compra" "condicion_compra_prov" DEFAULT 'factura' NOT NULL;--> statement-breakpoint
ALTER TABLE "proveedores" ADD COLUMN IF NOT EXISTS "medio_habitual" "medio_habitual_prov";--> statement-breakpoint
ALTER TABLE "proveedores" ADD COLUMN IF NOT EXISTS "dias_pago" integer;--> statement-breakpoint
ALTER TABLE "proveedores" ADD COLUMN IF NOT EXISTS "modo_cuenta" "modo_cuenta_prov" DEFAULT 'facturas' NOT NULL;--> statement-breakpoint
-- La conciliación: "cuadré contra el resumen del proveedor hasta acá".
-- Las tres columnas van juntas (fecha + quién + cuándo lo marcó).
ALTER TABLE "proveedores" ADD COLUMN IF NOT EXISTS "conciliado_hasta" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "proveedores" ADD COLUMN IF NOT EXISTS "conciliado_por" integer;--> statement-breakpoint
ALTER TABLE "proveedores" ADD COLUMN IF NOT EXISTS "conciliado_at" timestamp with time zone;--> statement-breakpoint

-- Cuentas bancarias (CBU de 22 dígitos o alias), N por proveedor con su
-- descripción ("Galicia, cuenta del titular"). Borrado físico: es dato de
-- referencia, no historia contable.
CREATE TABLE IF NOT EXISTS "proveedor_cuentas" (
  "id" serial PRIMARY KEY NOT NULL,
  "proveedor_id" integer NOT NULL,
  "cbu_alias" text DEFAULT '' NOT NULL,
  "descripcion" text DEFAULT '' NOT NULL
);--> statement-breakpoint
ALTER TABLE "proveedor_cuentas" ADD CONSTRAINT "proveedor_cuentas_proveedor_id_proveedores_id_fk"
  FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedores"("id") ON DELETE cascade;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_proveedor_cuentas_prov" ON "proveedor_cuentas" ("proveedor_id");--> statement-breakpoint

-- ── Pedidos al proveedor (el kanban de la app, tal cual) ────────────────────
-- Pizarra interna entre el admin y el encargado de compras. NO toca stock ni
-- deuda: el stock y la deuda nacen únicamente al confirmar la factura en
-- Compras. Los ítems van en texto libre a propósito — son notas de pedido
-- informales, no renglones facturables.
--   solicitado → hay que pedirle
--   pedido     → ya se le pidió (fecha_pedido)
--   recibido   → llegó (fecha_recepcion) — alimenta la pestaña Ingresos
--   retomar    → aparcado (se vuelve a solicitado cuando toque)
CREATE TYPE "estado_pedido_prov" AS ENUM ('solicitado', 'pedido', 'recibido', 'retomar');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pedidos_proveedor" (
  "id" serial PRIMARY KEY NOT NULL,
  "proveedor_id" integer NOT NULL,
  "estado" "estado_pedido_prov" DEFAULT 'solicitado' NOT NULL,
  "notas" text DEFAULT '' NOT NULL,
  "fecha_alta" timestamp with time zone DEFAULT now() NOT NULL,
  "fecha_pedido" timestamp with time zone,
  "fecha_recepcion" timestamp with time zone,
  -- "Ya le mandé el pedido (WhatsApp/mail) y espero confirmación". Solo tiene
  -- sentido en 'solicitado'; cualquier cambio de estado lo resetea.
  "pedido_enviado" boolean DEFAULT false NOT NULL,
  -- "Ya lo vi": revisé el stock de este proveedor y todavía no hay que pedir.
  -- Es FECHA y no booleano para poder decir "lo viste hace N días".
  "revisado_at" timestamp with time zone,
  "usuario_id" integer
);--> statement-breakpoint
ALTER TABLE "pedidos_proveedor" ADD CONSTRAINT "pedidos_proveedor_proveedor_id_proveedores_id_fk"
  FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedores"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "pedidos_proveedor" ADD CONSTRAINT "pedidos_proveedor_usuario_id_usuarios_id_fk"
  FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_pedidos_proveedor_estado" ON "pedidos_proveedor" ("estado", "proveedor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_pedidos_proveedor_recepcion" ON "pedidos_proveedor" ("fecha_recepcion");--> statement-breakpoint

-- ── Compromisos (las "Ctas Ctes" de la app) ─────────────────────────────────
-- El VENCIMIENTO como entidad propia. Nace de la factura confirmada de un
-- proveedor diferido (origen 'factura', editable, en cuotas si la factura
-- viene partida) o a mano (origen 'manual'). `pagado` no se tipea: lo pone el
-- PUENTE — cuando un pago salda la factura, el compromiso se cierra solo; si
-- el pago se anula o desaplica, se reabre. `es_echeq` decide la vitrina: los
-- echeq viven en su sección, no en Cuentas corrientes (regla de la app, que
-- allá era un LIKE sobre el nombre y acá es un dato).
CREATE TYPE "origen_compromiso" AS ENUM ('factura', 'manual');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proveedor_compromisos" (
  "id" serial PRIMARY KEY NOT NULL,
  -- RESTRICT: un compromiso es promesa de pago registrada; el proveedor con
  -- historia no se borra (mismo criterio que pagos y comprobantes).
  "proveedor_id" integer NOT NULL,
  -- SET NULL: si la factura se anula, sus compromisos PENDIENTES se borran en
  -- el servicio; este SET NULL es la red para un DELETE manual en la base.
  "comprobante_id" integer,
  "importe" double precision DEFAULT 0 NOT NULL,
  "fecha_emision" timestamp with time zone DEFAULT now() NOT NULL,
  "fecha_venc" timestamp with time zone NOT NULL,
  "origen" "origen_compromiso" DEFAULT 'manual' NOT NULL,
  "es_echeq" boolean DEFAULT false NOT NULL,
  -- "Cuota 2 de 3" cuando la factura vino partida. NULL = compromiso único.
  "cuota" integer,
  "cuotas" integer,
  "pagado" boolean DEFAULT false NOT NULL,
  -- Qué pago lo cerró (para reabrirlo si ese pago muere). SET NULL y no
  -- cascade: anular el pago REABRE el compromiso, no lo borra.
  "pago_id" integer,
  "obs" text DEFAULT '' NOT NULL,
  "creado_en" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "proveedor_compromisos" ADD CONSTRAINT "proveedor_compromisos_proveedor_id_proveedores_id_fk"
  FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedores"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "proveedor_compromisos" ADD CONSTRAINT "proveedor_compromisos_comprobante_id_comprobantes_id_fk"
  FOREIGN KEY ("comprobante_id") REFERENCES "public"."comprobantes"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "proveedor_compromisos" ADD CONSTRAINT "proveedor_compromisos_pago_id_proveedor_pagos_id_fk"
  FOREIGN KEY ("pago_id") REFERENCES "public"."proveedor_pagos"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_compromisos_pendientes" ON "proveedor_compromisos" ("pagado", "fecha_venc");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_compromisos_comprobante" ON "proveedor_compromisos" ("comprobante_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_compromisos_proveedor" ON "proveedor_compromisos" ("proveedor_id", "pagado");--> statement-breakpoint

-- ── Echeqs propios ──────────────────────────────────────────────────────────
-- Nace junto al compromiso cuando el proveedor cobra con echeq (número y banco
-- "a completar", como hacía la app) o a mano. 'cobrado' no es una etiqueta:
-- ejecuta el pago real. 'vencido' NO es estado: se deriva de la fecha.
CREATE TYPE "estado_echeq" AS ENUM ('emitido', 'entregado', 'cobrado', 'anulado');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proveedor_echeqs" (
  "id" serial PRIMARY KEY NOT NULL,
  "numero" text DEFAULT '' NOT NULL,
  "banco" text DEFAULT '' NOT NULL,
  "importe" double precision DEFAULT 0 NOT NULL,
  "fecha_emision" timestamp with time zone DEFAULT now() NOT NULL,
  "fecha_venc" timestamp with time zone NOT NULL,
  "proveedor_id" integer NOT NULL,
  "compromiso_id" integer,
  "pago_id" integer,
  "estado" "estado_echeq" DEFAULT 'emitido' NOT NULL,
  "obs" text DEFAULT '' NOT NULL,
  "creado_en" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "proveedor_echeqs" ADD CONSTRAINT "proveedor_echeqs_proveedor_id_proveedores_id_fk"
  FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedores"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "proveedor_echeqs" ADD CONSTRAINT "proveedor_echeqs_compromiso_id_proveedor_compromisos_id_fk"
  FOREIGN KEY ("compromiso_id") REFERENCES "public"."proveedor_compromisos"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "proveedor_echeqs" ADD CONSTRAINT "proveedor_echeqs_pago_id_proveedor_pagos_id_fk"
  FOREIGN KEY ("pago_id") REFERENCES "public"."proveedor_pagos"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_echeqs_estado" ON "proveedor_echeqs" ("estado", "fecha_venc");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_echeqs_compromiso" ON "proveedor_echeqs" ("compromiso_id");--> statement-breakpoint

-- ── Ajustes manuales del estado de cuenta ───────────────────────────────────
-- Con SIGNO: positivo suma deuda (DEBE), negativo la resta (HABER). El motivo
-- es obligatorio — un ajuste sin explicación es inauditable.
CREATE TABLE IF NOT EXISTS "proveedor_ajustes" (
  "id" serial PRIMARY KEY NOT NULL,
  "proveedor_id" integer NOT NULL,
  "importe" double precision NOT NULL,
  "motivo" text NOT NULL,
  "fecha" timestamp with time zone DEFAULT now() NOT NULL,
  "usuario_id" integer,
  "creado_en" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "proveedor_ajustes" ADD CONSTRAINT "proveedor_ajustes_proveedor_id_proveedores_id_fk"
  FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedores"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "proveedor_ajustes" ADD CONSTRAINT "proveedor_ajustes_usuario_id_usuarios_id_fk"
  FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_proveedor_ajustes_prov" ON "proveedor_ajustes" ("proveedor_id");--> statement-breakpoint

-- ── Pago multi-forma ────────────────────────────────────────────────────────
-- El split de un pago en N medios. Invariante (la impone el servicio, dentro
-- de la transacción del pago): SUM(importe) == proveedor_pagos.importe. La
-- parte en EFECTIVO es la que genera el egreso de caja. `fecha` propia por
-- parte: "una transferencia hace 10 días, el resto hoy". CASCADE: el split es
-- parte del pago, sin él no significa nada (el pago anulado conserva su split
-- porque se anula por estado, no por DELETE).
CREATE TABLE IF NOT EXISTS "pago_formas" (
  "id" serial PRIMARY KEY NOT NULL,
  "pago_id" integer NOT NULL,
  "medio" "medio_pago" DEFAULT 'efectivo' NOT NULL,
  "importe" double precision DEFAULT 0 NOT NULL,
  "fecha" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "pago_formas" ADD CONSTRAINT "pago_formas_pago_id_proveedor_pagos_id_fk"
  FOREIGN KEY ("pago_id") REFERENCES "public"."proveedor_pagos"("id") ON DELETE cascade;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_pago_formas_pago" ON "pago_formas" ("pago_id");--> statement-breakpoint

-- Medios nuevos para pagos a proveedor: el depósito (pedido del dueño) y el
-- echeq (el cobro de la cartera se registra con su medio real). Agregar
-- valores es seguro acá: esta migración no los USA — la restricción de
-- Postgres es sobre usar el valor nuevo en la misma transacción, no sobre
-- declararlo (y en el replay desde cero el tipo nace en esta misma
-- transacción, donde todo vale).
ALTER TYPE "medio_pago" ADD VALUE IF NOT EXISTS 'deposito';--> statement-breakpoint
ALTER TYPE "medio_pago" ADD VALUE IF NOT EXISTS 'echeq';--> statement-breakpoint

-- ── Llaves ──────────────────────────────────────────────────────────────────
-- El módulo es del dueño y el admin (decisión del 17/8): las cinco secciones
-- arrancan solo en admin. Superadmin ya tiene '*'. Sin acciones extra: quien
-- ve una sección de este módulo opera sobre ella — el que paga ya pasa por
-- las llaves de pagos de siempre.
UPDATE "roles" SET "permisos" = "permisos"
  || '["proveedores.pedidos","proveedores.ctasctes","proveedores.echeqs","proveedores.edoc","proveedores.padron"]'::jsonb
WHERE "clave" = 'admin' AND NOT ("permisos" ? 'proveedores.padron');
