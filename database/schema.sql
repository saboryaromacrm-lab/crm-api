-- ESTRUCTURA COMPLETA de la base del CRM, generada por drizzle-kit desde
-- src/db/schema.ts el 1/9/2026 (79 tablas, 47 tipos enumerados). Sirve para
-- LEER el esquema de un vistazo. NO sirve para levantar una base: no crea la
-- tabla de migraciones de Drizzle, y una base creada asi rechaza db:migrate.
-- Para levantar la base: npm run db:create && npm run db:migrate.

CREATE TYPE "public"."alcance_oferta" AS ENUM('producto', 'marca', 'categoria', 'etiqueta', 'presentacion');CREATE TYPE "public"."base_percepcion" AS ENUM('neto', 'total');CREATE TYPE "public"."condicion_compra_prov" AS ENUM('factura', 'liquidacion', 'mixto');CREATE TYPE "public"."condicion_iva" AS ENUM('responsable_inscripto', 'monotributo', 'consumidor_final', 'exento', 'no_categorizado');CREATE TYPE "public"."condicion_pago" AS ENUM('contado', 'cuenta_corriente');CREATE TYPE "public"."destino_pago_prov" AS ENUM('mercaderia', 'gastos');CREATE TYPE "public"."estado_caja" AS ENUM('abierta', 'cerrada');CREATE TYPE "public"."estado_cobranza" AS ENUM('confirmada', 'anulada');CREATE TYPE "public"."estado_comprobante" AS ENUM('borrador', 'confirmado', 'anulado');CREATE TYPE "public"."estado_conteo" AS ENUM('en_curso', 'cerrado', 'aplicado', 'descartado');CREATE TYPE "public"."estado_echeq" AS ENUM('emitido', 'entregado', 'cobrado', 'anulado');CREATE TYPE "public"."estado_envio_cafe" AS ENUM('enviado', 'anulado');CREATE TYPE "public"."estado_gasto" AS ENUM('pendiente', 'pagado', 'anulado');CREATE TYPE "public"."estado_incidencia" AS ENUM('pendiente', 'revision', 'resuelta');CREATE TYPE "public"."estado_lectura" AS ENUM('pendiente', 'cargada', 'descartada');CREATE TYPE "public"."estado_pago_prov" AS ENUM('activo', 'anulado');CREATE TYPE "public"."estado_pedido_cafe" AS ENUM('pendiente', 'armando', 'enviado', 'anulado');CREATE TYPE "public"."estado_pedido_prov" AS ENUM('solicitado', 'pedido', 'recibido', 'retomar');CREATE TYPE "public"."estado_presupuesto" AS ENUM('borrador', 'enviado', 'confirmado', 'cerrado', 'cancelado', 'pendiente');CREATE TYPE "public"."estado_producto" AS ENUM('activo', 'discontinuado', 'archivado');CREATE TYPE "public"."estado_stock" AS ENUM('disponible', 'comprometido', 'retenido', 'defectuoso', 'vencido', 'en_transito');CREATE TYPE "public"."estado_transferencia" AS ENUM('borrador', 'pendiente', 'preparada', 'transito', 'recibida', 'cancelada');CREATE TYPE "public"."estado_venta" AS ENUM('borrador', 'confirmada', 'anulada', 'pendiente_cae');CREATE TYPE "public"."frecuencia_gasto" AS ENUM('mensual', 'bimestral', 'trimestral', 'semestral', 'anual');CREATE TYPE "public"."letra_comprobante" AS ENUM('A', 'B', 'C', 'X');CREATE TYPE "public"."medio_habitual_prov" AS ENUM('efectivo', 'transferencia', 'deposito', 'echeq', 'cta_cte');CREATE TYPE "public"."medio_pago" AS ENUM('efectivo', 'transferencia', 'tarjeta_debito', 'tarjeta_credito', 'cheque', 'qr', 'otro', 'deposito', 'echeq');CREATE TYPE "public"."modo_costo" AS ENUM('lista', 'final');CREATE TYPE "public"."modo_cuenta_prov" AS ENUM('facturas', 'libre');CREATE TYPE "public"."modo_envio_cafe" AS ENUM('granel', 'paquete', 'unidad');CREATE TYPE "public"."modo_precio" AS ENUM('markup', 'precio');CREATE TYPE "public"."negocio_gasto" AS ENUM('distribuidora', 'cafeteria');CREATE TYPE "public"."origen_compromiso" AS ENUM('factura', 'manual');CREATE TYPE "public"."origen_costo" AS ENUM('alta', 'manual', 'masiva', 'recepcion', 'reversion');CREATE TYPE "public"."origen_lista" AS ENUM('base', 'cliente', 'auto', 'manual', 'marca', 'monto', 'presupuesto');CREATE TYPE "public"."origen_precio" AS ENUM('inicial', 'costo', 'formato_compra', 'formato_venta', 'activacion', 'reversion');CREATE TYPE "public"."tipo_comprobante" AS ENUM('orden_compra', 'remito', 'factura', 'liquidacion', 'nota_credito', 'nota_debito');CREATE TYPE "public"."tipo_doc" AS ENUM('cuit', 'cuil', 'dni', 'sin_identificar');CREATE TYPE "public"."tipo_doc_gasto" AS ENUM('factura', 'ticket', 'recibo', 'nota_credito', 'otro');CREATE TYPE "public"."tipo_gasto" AS ENUM('fijo', 'variable');CREATE TYPE "public"."tipo_imagen_web" AS ENUM('producto', 'categoria', 'marca', 'banner', 'logo', 'favicon');CREATE TYPE "public"."tipo_mov_caja" AS ENUM('ingreso', 'egreso');CREATE TYPE "public"."tipo_movimiento" AS ENUM('compra', 'fraccionamiento', 'venta_granel', 'venta_fraccionada', 'devolucion', 'ajuste', 'merma', 'vencido', 'defectuoso', 'transferencia', 'envio_cafeteria');CREATE TYPE "public"."tipo_oferta" AS ENUM('porcentaje', 'precio_fijo', 'nxm', 'segunda_unidad', 'pack', 'combo', 'ticket');CREATE TYPE "public"."tipo_producto" AS ENUM('granel', 'entero');CREATE TYPE "public"."tipo_sucursal" AS ENUM('distribuidora', 'express');CREATE TYPE "public"."tipo_venta" AS ENUM('ticket', 'factura_a', 'factura_b', 'factura_c', 'nota_credito_a', 'nota_credito_b', 'nota_credito_c', 'nota_debito_a', 'nota_debito_b', 'nota_debito_c');CREATE TABLE IF NOT EXISTS "arca_tokens" (
	"service" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"sign" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "auditoria" (
	"id" serial PRIMARY KEY NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"usuario_id" integer,
	"entidad" text NOT NULL,
	"entidad_id" integer NOT NULL,
	"ambito" text NOT NULL,
	"detalle" text DEFAULT '' NOT NULL,
	"campo" text NOT NULL,
	"antes" text DEFAULT '' NOT NULL,
	"despues" text DEFAULT '' NOT NULL
);
CREATE TABLE IF NOT EXISTS "caja_controles" (
	"id" serial PRIMARY KEY NOT NULL,
	"caja_sesion_id" integer NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"esperado_efectivo" double precision DEFAULT 0 NOT NULL,
	"contado_efectivo" double precision DEFAULT 0 NOT NULL,
	"diferencia" double precision DEFAULT 0 NOT NULL,
	"observaciones" text DEFAULT '' NOT NULL,
	"usuario_id" integer
);
CREATE TABLE IF NOT EXISTS "caja_movimientos" (
	"id" serial PRIMARY KEY NOT NULL,
	"caja_sesion_id" integer NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"tipo" "tipo_mov_caja" NOT NULL,
	"motivo" text DEFAULT '' NOT NULL,
	"importe" double precision DEFAULT 0 NOT NULL,
	"usuario_id" integer
);
CREATE TABLE IF NOT EXISTS "caja_sesiones" (
	"id" serial PRIMARY KEY NOT NULL,
	"sucursal_id" integer NOT NULL,
	"usuario_id" integer,
	"apertura" timestamp with time zone DEFAULT now() NOT NULL,
	"monto_inicial" double precision DEFAULT 0 NOT NULL,
	"cierre" timestamp with time zone,
	"declarado_efectivo" double precision DEFAULT 0 NOT NULL,
	"sistema_efectivo" double precision DEFAULT 0 NOT NULL,
	"diferencia" double precision DEFAULT 0 NOT NULL,
	"totales" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"estado" "estado_caja" DEFAULT 'abierta' NOT NULL,
	"observaciones" text DEFAULT '' NOT NULL
);
CREATE TABLE IF NOT EXISTS "categorias" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"activa" boolean DEFAULT true NOT NULL
);
CREATE TABLE IF NOT EXISTS "chat_lecturas" (
	"id" serial PRIMARY KEY NOT NULL,
	"sucursal_id" integer NOT NULL,
	"usuario_id" integer NOT NULL,
	"canal_usuario_id" integer DEFAULT 0 NOT NULL,
	"ultimo_mensaje_id" integer DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "chat_mensajes" (
	"id" serial PRIMARY KEY NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"sucursal_id" integer NOT NULL,
	"usuario_id" integer,
	"para_usuario_id" integer,
	"texto" text NOT NULL
);
CREATE TABLE IF NOT EXISTS "cliente_listas" (
	"id" serial PRIMARY KEY NOT NULL,
	"cliente_id" integer NOT NULL,
	"lista_id" integer NOT NULL
);
CREATE TABLE IF NOT EXISTS "clientes" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"nombre_fantasia" text DEFAULT '' NOT NULL,
	"tipo_doc" "tipo_doc" DEFAULT 'dni' NOT NULL,
	"numero_doc" text DEFAULT '' NOT NULL,
	"condicion_iva" "condicion_iva" DEFAULT 'consumidor_final' NOT NULL,
	"direccion" text DEFAULT '' NOT NULL,
	"localidad" text DEFAULT '' NOT NULL,
	"telefono" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"descuento" double precision DEFAULT 0 NOT NULL,
	"vendedor_id" integer,
	"sucursal_id" integer,
	"cta_cte_habilitada" boolean DEFAULT false NOT NULL,
	"limite_credito" double precision DEFAULT 0 NOT NULL,
	"dias_plazo" integer DEFAULT 0 NOT NULL,
	"observaciones" text DEFAULT '' NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"es_consumidor_final" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "cobranza_imputaciones" (
	"id" serial PRIMARY KEY NOT NULL,
	"cobranza_id" integer NOT NULL,
	"venta_id" integer NOT NULL,
	"importe" double precision DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "cobranza_pagos" (
	"id" serial PRIMARY KEY NOT NULL,
	"cobranza_id" integer NOT NULL,
	"medio" "medio_pago" DEFAULT 'efectivo' NOT NULL,
	"importe" double precision DEFAULT 0 NOT NULL,
	"referencia" text DEFAULT '' NOT NULL
);
CREATE TABLE IF NOT EXISTS "cobranzas" (
	"id" serial PRIMARY KEY NOT NULL,
	"punto_venta" text DEFAULT '0001' NOT NULL,
	"numero" integer DEFAULT 0 NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"cliente_id" integer NOT NULL,
	"sucursal_id" integer,
	"usuario_id" integer,
	"caja_sesion_id" integer,
	"total" double precision DEFAULT 0 NOT NULL,
	"a_cuenta" double precision DEFAULT 0 NOT NULL,
	"estado" "estado_cobranza" DEFAULT 'confirmada' NOT NULL,
	"observaciones" text DEFAULT '' NOT NULL,
	"anulado_por" integer,
	"anulado_en" timestamp with time zone,
	"anulado_motivo" text DEFAULT '' NOT NULL
);
CREATE TABLE IF NOT EXISTS "comprobante_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"comprobante_id" integer NOT NULL,
	"producto_id" integer NOT NULL,
	"presentacion_id" integer,
	"cantidad" double precision DEFAULT 0 NOT NULL,
	"costo_unitario" double precision DEFAULT 0 NOT NULL,
	"descuento" double precision DEFAULT 0 NOT NULL,
	"iva" double precision DEFAULT 21 NOT NULL,
	"subtotal" double precision DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "comprobante_percepciones" (
	"id" serial PRIMARY KEY NOT NULL,
	"comprobante_id" integer NOT NULL,
	"nombre" text NOT NULL,
	"alicuota" double precision DEFAULT 0 NOT NULL,
	"base" "base_percepcion" DEFAULT 'neto' NOT NULL,
	"importe" double precision DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "comprobantes" (
	"id" serial PRIMARY KEY NOT NULL,
	"tipo" "tipo_comprobante" NOT NULL,
	"letra" "letra_comprobante" DEFAULT 'A' NOT NULL,
	"punto_venta" text DEFAULT '0001' NOT NULL,
	"numero" integer,
	"cae" text DEFAULT '' NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"fecha_carga" timestamp with time zone DEFAULT now() NOT NULL,
	"proveedor_id" integer NOT NULL,
	"sucursal_id" integer,
	"estado" "estado_comprobante" DEFAULT 'confirmado' NOT NULL,
	"condicion_pago" "condicion_pago" DEFAULT 'cuenta_corriente' NOT NULL,
	"vencimiento_pago" timestamp with time zone,
	"recepcion" boolean DEFAULT false NOT NULL,
	"bonificacion" double precision DEFAULT 0 NOT NULL,
	"bonificacion_importe" double precision DEFAULT 0 NOT NULL,
	"subtotal_neto" double precision DEFAULT 0 NOT NULL,
	"iva_total" double precision DEFAULT 0 NOT NULL,
	"percepciones_total" double precision DEFAULT 0 NOT NULL,
	"total" double precision DEFAULT 0 NOT NULL,
	"pagado" double precision DEFAULT 0 NOT NULL,
	"ref_comprobante_id" integer,
	"observaciones" text DEFAULT '' NOT NULL,
	"usuario_id" integer
);
CREATE TABLE IF NOT EXISTS "configuracion" (
	"id" serial PRIMARY KEY NOT NULL,
	"clave" text NOT NULL,
	"valor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "conteo_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"conteo_id" integer NOT NULL,
	"producto_id" integer NOT NULL,
	"presentacion_id" integer,
	"nombre" text DEFAULT '' NOT NULL,
	"pres_label" text DEFAULT '' NOT NULL,
	"unidad" text DEFAULT 'u' NOT NULL,
	"contado" double precision,
	"virtual_al_contar" double precision,
	"contado_por" integer,
	"contado_en" timestamp with time zone,
	"recontar" boolean DEFAULT false NOT NULL
);
CREATE TABLE IF NOT EXISTS "conteos" (
	"id" serial PRIMARY KEY NOT NULL,
	"sucursal_id" integer NOT NULL,
	"nombre" text DEFAULT '' NOT NULL,
	"alcance" text DEFAULT '' NOT NULL,
	"ciego" boolean DEFAULT true NOT NULL,
	"estado" "estado_conteo" DEFAULT 'en_curso' NOT NULL,
	"usuario_id" integer,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"cerrado_en" timestamp with time zone,
	"aplicado_en" timestamp with time zone,
	"aplicado_por" integer
);
CREATE TABLE IF NOT EXISTS "descuentos" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"porcentaje" double precision DEFAULT 0 NOT NULL,
	"vence" timestamp with time zone,
	"medio_pago" "medio_pago",
	"lista_id" integer NOT NULL,
	"sucursal_id" integer,
	"requiere_admin" boolean DEFAULT false NOT NULL,
	"activo" boolean DEFAULT true NOT NULL
);
CREATE TABLE IF NOT EXISTS "envio_cafeteria_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"envio_id" integer NOT NULL,
	"producto_id" integer NOT NULL,
	"presentacion_id" integer,
	"modo" "modo_envio_cafe" DEFAULT 'unidad' NOT NULL,
	"cantidad" double precision DEFAULT 0 NOT NULL,
	"tam_kg" double precision DEFAULT 0 NOT NULL,
	"costo_unitario" double precision DEFAULT 0 NOT NULL,
	"nombre" text DEFAULT '' NOT NULL,
	"unidad" text DEFAULT '' NOT NULL,
	"codigo_barras" text DEFAULT '' NOT NULL,
	"codigo_propio" text DEFAULT '' NOT NULL
);
CREATE TABLE IF NOT EXISTS "envios_cafeteria" (
	"id" serial PRIMARY KEY NOT NULL,
	"codigo" text DEFAULT '' NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"sucursal_id" integer NOT NULL,
	"usuario_id" integer,
	"estado" "estado_envio_cafe" DEFAULT 'enviado' NOT NULL,
	"total_costo" double precision DEFAULT 0 NOT NULL,
	"observaciones" text DEFAULT '' NOT NULL,
	"motivo_anulacion" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"pedido_id" integer
);
CREATE TABLE IF NOT EXISTS "etiquetas" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"color" text DEFAULT '' NOT NULL,
	"activa" boolean DEFAULT true NOT NULL
);
CREATE TABLE IF NOT EXISTS "factura_archivos" (
	"id" serial PRIMARY KEY NOT NULL,
	"lectura_id" integer NOT NULL,
	"nombre" text DEFAULT '' NOT NULL,
	"mime" text DEFAULT 'image/webp' NOT NULL,
	"data" text NOT NULL,
	"subido_en" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "factura_lecturas" (
	"id" serial PRIMARY KEY NOT NULL,
	"estado" "estado_lectura" DEFAULT 'pendiente' NOT NULL,
	"leido" boolean DEFAULT false NOT NULL,
	"cuit" text DEFAULT '' NOT NULL,
	"tipo" "tipo_comprobante",
	"letra" "letra_comprobante",
	"punto_venta" text DEFAULT '' NOT NULL,
	"numero" integer,
	"fecha" timestamp with time zone,
	"total" double precision DEFAULT 0 NOT NULL,
	"cae" text DEFAULT '' NOT NULL,
	"moneda" text DEFAULT '' NOT NULL,
	"cuit_receptor" text DEFAULT '' NOT NULL,
	"proveedor_id" integer,
	"sucursal_id" integer,
	"usuario_id" integer,
	"comprobante_id" integer,
	"observaciones" text DEFAULT '' NOT NULL,
	"hash" text DEFAULT '' NOT NULL,
	"subido_en" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "gasto_adjuntos" (
	"id" serial PRIMARY KEY NOT NULL,
	"gasto_id" integer NOT NULL,
	"nombre" text DEFAULT '' NOT NULL,
	"mime" text DEFAULT 'image/webp' NOT NULL,
	"data" text NOT NULL,
	"subido_en" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "gasto_categorias" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"tipo" "tipo_gasto" DEFAULT 'variable' NOT NULL,
	"descripcion" text DEFAULT '' NOT NULL,
	"activa" boolean DEFAULT true NOT NULL,
	"orden" integer DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "gasto_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"gasto_id" integer NOT NULL,
	"concepto" text DEFAULT '' NOT NULL,
	"monto" double precision DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "gastos" (
	"id" serial PRIMARY KEY NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"fecha_carga" timestamp with time zone DEFAULT now() NOT NULL,
	"tipo_doc" "tipo_doc_gasto" DEFAULT 'factura' NOT NULL,
	"letra" "letra_comprobante" DEFAULT 'B' NOT NULL,
	"numero" text DEFAULT '' NOT NULL,
	"proveedor_id" integer,
	"proveedor_texto" text DEFAULT '' NOT NULL,
	"categoria_id" integer NOT NULL,
	"sucursal_id" integer,
	"descripcion" text DEFAULT '' NOT NULL,
	"condicion_pago" "condicion_pago" DEFAULT 'contado' NOT NULL,
	"vencimiento" timestamp with time zone,
	"neto" double precision DEFAULT 0 NOT NULL,
	"iva" double precision DEFAULT 0 NOT NULL,
	"otros" double precision DEFAULT 0 NOT NULL,
	"imp_internos" double precision DEFAULT 0 NOT NULL,
	"perc_dgi" double precision DEFAULT 0 NOT NULL,
	"perc_dgr" double precision DEFAULT 0 NOT NULL,
	"total" double precision DEFAULT 0 NOT NULL,
	"pagado" double precision DEFAULT 0 NOT NULL,
	"estado" "estado_gasto" DEFAULT 'pendiente' NOT NULL,
	"negocio" "negocio_gasto" DEFAULT 'distribuidora' NOT NULL,
	"recurrente_id" integer,
	"observaciones" text DEFAULT '' NOT NULL,
	"usuario_id" integer
);
CREATE TABLE IF NOT EXISTS "gastos_recurrentes" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"categoria_id" integer NOT NULL,
	"proveedor_id" integer,
	"sucursal_id" integer,
	"importe_estimado" double precision DEFAULT 0 NOT NULL,
	"frecuencia" "frecuencia_gasto" DEFAULT 'mensual' NOT NULL,
	"dia_vencimiento" integer DEFAULT 10 NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"observaciones" text DEFAULT '' NOT NULL
);
CREATE TABLE IF NOT EXISTS "incidencias" (
	"id" serial PRIMARY KEY NOT NULL,
	"codigo" text DEFAULT '' NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"tipo" text NOT NULL,
	"estado" "estado_incidencia" DEFAULT 'pendiente' NOT NULL,
	"responsable_id" integer,
	"motivo" text DEFAULT '' NOT NULL,
	"producto_id" integer NOT NULL,
	"sucursal_id" integer NOT NULL,
	"presentacion_id" integer,
	"cantidad" double precision DEFAULT 0 NOT NULL,
	"unidad" text DEFAULT '' NOT NULL,
	"resolucion" text,
	"fecha_resolucion" timestamp with time zone,
	"activa" boolean DEFAULT true NOT NULL
);
CREATE TABLE IF NOT EXISTS "listas_venta" (
	"id" serial PRIMARY KEY NOT NULL,
	"modalidad_id" integer NOT NULL,
	"numero" integer NOT NULL,
	"nombre" text NOT NULL,
	"orden" integer DEFAULT 0 NOT NULL,
	"activa" boolean DEFAULT true NOT NULL
);
CREATE TABLE IF NOT EXISTS "marcas" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"activa" boolean DEFAULT true NOT NULL
);
CREATE TABLE IF NOT EXISTS "modalidades_venta" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"orden" integer DEFAULT 0 NOT NULL,
	"activa" boolean DEFAULT true NOT NULL
);
CREATE TABLE IF NOT EXISTS "movimientos" (
	"id" serial PRIMARY KEY NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"tipo" "tipo_movimiento" NOT NULL,
	"producto_id" integer,
	"sucursal_id" integer,
	"presentacion_id" integer,
	"signo" integer DEFAULT 0 NOT NULL,
	"cantidad" double precision DEFAULT 0 NOT NULL,
	"unidad" text DEFAULT '' NOT NULL,
	"motivo" text DEFAULT '' NOT NULL,
	"pres_label" text DEFAULT '' NOT NULL,
	"estado_desde" "estado_stock",
	"estado_hacia" "estado_stock",
	"sucursal_destino_id" integer,
	"vencimiento" timestamp with time zone,
	"costo_unitario" double precision DEFAULT 0 NOT NULL,
	"proveedor_nombre" text DEFAULT '' NOT NULL,
	"usuario_id" integer,
	"ref_transferencia_id" integer,
	"ref_incidencia_id" integer,
	"ref_conteo_id" integer,
	"descripcion" text DEFAULT '' NOT NULL
);
CREATE TABLE IF NOT EXISTS "oferta_alcances" (
	"id" serial PRIMARY KEY NOT NULL,
	"oferta_id" integer NOT NULL,
	"tipo" "alcance_oferta" NOT NULL,
	"ref_id" integer NOT NULL
);
CREATE TABLE IF NOT EXISTS "oferta_componentes" (
	"id" serial PRIMARY KEY NOT NULL,
	"oferta_id" integer NOT NULL,
	"producto_id" integer NOT NULL,
	"cantidad" double precision DEFAULT 1 NOT NULL
);
CREATE TABLE IF NOT EXISTS "ofertas" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"tipo" "tipo_oferta" NOT NULL,
	"porcentaje" double precision DEFAULT 0 NOT NULL,
	"precio" double precision DEFAULT 0 NOT NULL,
	"lleva" double precision DEFAULT 0 NOT NULL,
	"paga" double precision DEFAULT 0 NOT NULL,
	"monto_minimo" double precision DEFAULT 0 NOT NULL,
	"desde" timestamp with time zone,
	"hasta" timestamp with time zone,
	"dias" text DEFAULT '' NOT NULL,
	"sucursales" text DEFAULT '' NOT NULL,
	"medios_pago" text DEFAULT '' NOT NULL,
	"listas" text DEFAULT '' NOT NULL,
	"incluye_fraccionados" boolean DEFAULT false NOT NULL,
	"activa" boolean DEFAULT true NOT NULL
);
CREATE TABLE IF NOT EXISTS "pago_formas" (
	"id" serial PRIMARY KEY NOT NULL,
	"pago_id" integer NOT NULL,
	"medio" "medio_pago" DEFAULT 'efectivo' NOT NULL,
	"importe" double precision DEFAULT 0 NOT NULL,
	"fecha" timestamp with time zone
);
CREATE TABLE IF NOT EXISTS "pedido_cafeteria_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"pedido_id" integer NOT NULL,
	"producto_id" integer NOT NULL,
	"presentacion_id" integer,
	"cantidad" double precision DEFAULT 0 NOT NULL,
	"nombre" text DEFAULT '' NOT NULL,
	"unidad" text DEFAULT '' NOT NULL
);
CREATE TABLE IF NOT EXISTS "pedidos_cafeteria" (
	"id" serial PRIMARY KEY NOT NULL,
	"codigo" text DEFAULT '' NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"usuario_id" integer,
	"estado" "estado_pedido_cafe" DEFAULT 'pendiente' NOT NULL,
	"observaciones" text DEFAULT '' NOT NULL,
	"motivo_anulacion" text DEFAULT '' NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "pedidos_proveedor" (
	"id" serial PRIMARY KEY NOT NULL,
	"proveedor_id" integer NOT NULL,
	"estado" "estado_pedido_prov" DEFAULT 'solicitado' NOT NULL,
	"notas" text DEFAULT '' NOT NULL,
	"fecha_alta" timestamp with time zone DEFAULT now() NOT NULL,
	"fecha_pedido" timestamp with time zone,
	"fecha_recepcion" timestamp with time zone,
	"pedido_enviado" boolean DEFAULT false NOT NULL,
	"revisado_at" timestamp with time zone,
	"usuario_id" integer
);
CREATE TABLE IF NOT EXISTS "precio_historial" (
	"id" serial PRIMARY KEY NOT NULL,
	"producto_id" integer NOT NULL,
	"lista_id" integer NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"precio_anterior" double precision,
	"precio" double precision DEFAULT 0 NOT NULL,
	"origen" "origen_precio" DEFAULT 'costo' NOT NULL,
	"detalle" text DEFAULT '' NOT NULL,
	"usuario_id" integer
);
CREATE TABLE IF NOT EXISTS "presentaciones" (
	"id" serial PRIMARY KEY NOT NULL,
	"producto_id" integer NOT NULL,
	"tam_kg" double precision NOT NULL,
	"codigo_barras" text DEFAULT '' NOT NULL
);
CREATE TABLE IF NOT EXISTS "presupuesto_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"presupuesto_id" integer NOT NULL,
	"producto_id" integer NOT NULL,
	"presentacion_id" integer,
	"nombre" text DEFAULT '' NOT NULL,
	"detalle" text DEFAULT '' NOT NULL,
	"cantidad" double precision DEFAULT 0 NOT NULL,
	"cantidad_armada" double precision,
	"precio_lista" double precision DEFAULT 0 NOT NULL,
	"descuento" double precision DEFAULT 0 NOT NULL,
	"iva" double precision DEFAULT 21 NOT NULL,
	"lista" text DEFAULT '' NOT NULL,
	"lista_id" integer,
	"oferta_nombre" text DEFAULT '' NOT NULL,
	"motivo" text DEFAULT '' NOT NULL
);
CREATE TABLE IF NOT EXISTS "presupuestos" (
	"id" serial PRIMARY KEY NOT NULL,
	"codigo" text DEFAULT '' NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"cliente_id" integer,
	"sucursal_id" integer NOT NULL,
	"usuario_id" integer,
	"vendedor_id" integer,
	"estado" "estado_presupuesto" DEFAULT 'borrador' NOT NULL,
	"entrega" text DEFAULT 'retiro' NOT NULL,
	"vencimiento" timestamp with time zone,
	"venta_id" integer,
	"reservado" boolean DEFAULT false NOT NULL,
	"origen" text DEFAULT 'manual' NOT NULL,
	"web_cliente" jsonb,
	"observaciones" text DEFAULT '' NOT NULL,
	"subtotal_neto" double precision DEFAULT 0 NOT NULL,
	"iva_total" double precision DEFAULT 0 NOT NULL,
	"total" double precision DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "producto_etiquetas" (
	"id" serial PRIMARY KEY NOT NULL,
	"producto_id" integer NOT NULL,
	"etiqueta_id" integer NOT NULL
);
CREATE TABLE IF NOT EXISTS "producto_listas" (
	"id" serial PRIMARY KEY NOT NULL,
	"producto_id" integer NOT NULL,
	"presentacion_id" integer,
	"lista_id" integer NOT NULL,
	"unidades" double precision DEFAULT 1 NOT NULL,
	"codigo_barras" text DEFAULT '' NOT NULL,
	"modo_precio" "modo_precio" DEFAULT 'markup' NOT NULL,
	"markup" double precision DEFAULT 0 NOT NULL,
	"precio_fijo" double precision DEFAULT 0 NOT NULL,
	"unidades_minimas" double precision DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "producto_proveedor_costos" (
	"id" serial PRIMARY KEY NOT NULL,
	"producto_proveedor_id" integer NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"costo_anterior" double precision DEFAULT 0 NOT NULL,
	"descuento_anterior" double precision DEFAULT 0 NOT NULL,
	"flete_anterior" double precision DEFAULT 0 NOT NULL,
	"costo" double precision DEFAULT 0 NOT NULL,
	"descuento" double precision DEFAULT 0 NOT NULL,
	"flete" double precision DEFAULT 0 NOT NULL,
	"origen" "origen_costo" DEFAULT 'manual' NOT NULL,
	"activo_anterior" integer,
	"activo_nuevo" integer,
	"motivo" text DEFAULT '' NOT NULL,
	"lote" text DEFAULT '' NOT NULL,
	"usuario_id" integer,
	"comprobante_id" integer
);
CREATE TABLE IF NOT EXISTS "producto_proveedores" (
	"id" serial PRIMARY KEY NOT NULL,
	"producto_id" integer NOT NULL,
	"proveedor_id" integer NOT NULL,
	"cantidad" double precision DEFAULT 1 NOT NULL,
	"costo" double precision DEFAULT 0 NOT NULL,
	"descuento" double precision DEFAULT 0 NOT NULL,
	"descuento2" double precision DEFAULT 0 NOT NULL,
	"descuento3" double precision DEFAULT 0 NOT NULL,
	"descuento4" double precision DEFAULT 0 NOT NULL,
	"flete" double precision DEFAULT 0 NOT NULL,
	"modo_costo" "modo_costo" DEFAULT 'lista' NOT NULL,
	"costo_final" double precision DEFAULT 0 NOT NULL,
	"porc_sin_factura" double precision DEFAULT 0 NOT NULL,
	"usar_para_precio" boolean DEFAULT false NOT NULL,
	"codigo_proveedor" text DEFAULT '' NOT NULL
);
CREATE TABLE IF NOT EXISTS "productos" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"descripcion" text DEFAULT '' NOT NULL,
	"codigo_propio" text DEFAULT '' NOT NULL,
	"codigo_barras" text DEFAULT '' NOT NULL,
	"dun" text DEFAULT '' NOT NULL,
	"unidades_por_bulto" double precision DEFAULT 1 NOT NULL,
	"etiqueta_marca" text,
	"etiqueta_nombre" text,
	"marca_id" integer,
	"categoria_id" integer,
	"subcategoria_id" integer,
	"iva" double precision DEFAULT 21 NOT NULL,
	"tipo" "tipo_producto" DEFAULT 'entero' NOT NULL,
	"estado" "estado_producto" DEFAULT 'activo' NOT NULL,
	"estado_desde" timestamp with time zone,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"motivo_baja" text DEFAULT '' NOT NULL,
	"solo_fraccionar" boolean DEFAULT false NOT NULL,
	"solo_cafeteria" boolean DEFAULT false NOT NULL,
	"stock_min" double precision DEFAULT 0 NOT NULL,
	"redondeo" integer,
	"publicado" boolean DEFAULT false NOT NULL,
	"id_externo" text DEFAULT '' NOT NULL,
	"imagen_url" text DEFAULT '' NOT NULL,
	"destacado" boolean DEFAULT false NOT NULL,
	"web_stock_min" double precision DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "proveedor_ajustes" (
	"id" serial PRIMARY KEY NOT NULL,
	"proveedor_id" integer NOT NULL,
	"importe" double precision NOT NULL,
	"motivo" text NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"usuario_id" integer,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "proveedor_articulos" (
	"id" serial PRIMARY KEY NOT NULL,
	"proveedor_id" integer NOT NULL,
	"codigo" text NOT NULL,
	"producto_id" integer NOT NULL,
	"descripcion" text DEFAULT '' NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "proveedor_compromisos" (
	"id" serial PRIMARY KEY NOT NULL,
	"proveedor_id" integer NOT NULL,
	"comprobante_id" integer,
	"importe" double precision DEFAULT 0 NOT NULL,
	"fecha_emision" timestamp with time zone DEFAULT now() NOT NULL,
	"fecha_venc" timestamp with time zone NOT NULL,
	"origen" "origen_compromiso" DEFAULT 'manual' NOT NULL,
	"es_echeq" boolean DEFAULT false NOT NULL,
	"cuota" integer,
	"cuotas" integer,
	"pagado" boolean DEFAULT false NOT NULL,
	"pago_id" integer,
	"obs" text DEFAULT '' NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "proveedor_cuentas" (
	"id" serial PRIMARY KEY NOT NULL,
	"proveedor_id" integer NOT NULL,
	"cbu_alias" text DEFAULT '' NOT NULL,
	"descripcion" text DEFAULT '' NOT NULL
);
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
);
CREATE TABLE IF NOT EXISTS "proveedor_imputaciones" (
	"id" serial PRIMARY KEY NOT NULL,
	"pago_id" integer NOT NULL,
	"gasto_id" integer,
	"comprobante_id" integer,
	"importe" double precision DEFAULT 0 NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"usuario_id" integer
);
CREATE TABLE IF NOT EXISTS "proveedor_pagos" (
	"id" serial PRIMARY KEY NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"proveedor_id" integer,
	"medio" "medio_pago" DEFAULT 'efectivo' NOT NULL,
	"importe" double precision DEFAULT 0 NOT NULL,
	"destino" "destino_pago_prov" DEFAULT 'mercaderia' NOT NULL,
	"aplicado" double precision DEFAULT 0 NOT NULL,
	"es_flete" boolean DEFAULT false NOT NULL,
	"concepto" text DEFAULT '' NOT NULL,
	"referencia" text DEFAULT '' NOT NULL,
	"sucursal_id" integer,
	"caja_sesion_id" integer,
	"caja_movimiento_id" integer,
	"usuario_id" integer,
	"estado" "estado_pago_prov" DEFAULT 'activo' NOT NULL,
	"observaciones" text DEFAULT '' NOT NULL
);
CREATE TABLE IF NOT EXISTS "proveedor_percepciones" (
	"id" serial PRIMARY KEY NOT NULL,
	"proveedor_id" integer NOT NULL,
	"nombre" text NOT NULL,
	"alicuota" double precision DEFAULT 0 NOT NULL,
	"base" "base_percepcion" DEFAULT 'neto' NOT NULL,
	"activa" boolean DEFAULT true NOT NULL
);
CREATE TABLE IF NOT EXISTS "proveedores" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"cuit" text DEFAULT '' NOT NULL,
	"condicion_iva" "condicion_iva" DEFAULT 'responsable_inscripto' NOT NULL,
	"direccion" text DEFAULT '' NOT NULL,
	"telefono" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"provee_mercaderia" boolean DEFAULT true NOT NULL,
	"provee_gastos" boolean DEFAULT false NOT NULL,
	"letra_gasto" "letra_comprobante",
	"condicion_compra" "condicion_compra_prov" DEFAULT 'factura' NOT NULL,
	"porc_sin_factura" double precision DEFAULT 0 NOT NULL,
	"medio_habitual" "medio_habitual_prov",
	"dias_pago" integer,
	"modo_cuenta" "modo_cuenta_prov" DEFAULT 'facturas' NOT NULL,
	"conciliado_hasta" timestamp with time zone,
	"conciliado_por" integer,
	"conciliado_at" timestamp with time zone,
	"productos_esperados" integer DEFAULT 0 NOT NULL,
	"migracion_lista" boolean DEFAULT false NOT NULL
);
CREATE TABLE IF NOT EXISTS "reglas_marca" (
	"id" serial PRIMARY KEY NOT NULL,
	"marca_id" integer NOT NULL,
	"unidades_minimas" double precision DEFAULT 0 NOT NULL,
	"modalidad_id" integer NOT NULL,
	"activa" boolean DEFAULT true NOT NULL
);
CREATE TABLE IF NOT EXISTS "roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"clave" text NOT NULL,
	"nombre" text NOT NULL,
	"descripcion" text DEFAULT '' NOT NULL,
	"permisos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"es_sistema" boolean DEFAULT false NOT NULL,
	CONSTRAINT "roles_clave_unique" UNIQUE("clave")
);
CREATE TABLE IF NOT EXISTS "sesiones" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"usuario_id" integer NOT NULL,
	"sucursal_id" integer NOT NULL,
	"creada_en" timestamp with time zone DEFAULT now() NOT NULL,
	"ultimo_uso" timestamp with time zone DEFAULT now() NOT NULL,
	"expira_en" timestamp with time zone NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL
);
CREATE TABLE IF NOT EXISTS "stock" (
	"id" serial PRIMARY KEY NOT NULL,
	"producto_id" integer NOT NULL,
	"sucursal_id" integer NOT NULL,
	"presentacion_id" integer,
	"estado" "estado_stock" DEFAULT 'disponible' NOT NULL,
	"cantidad" double precision DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "subcategorias" (
	"id" serial PRIMARY KEY NOT NULL,
	"categoria_id" integer NOT NULL,
	"nombre" text NOT NULL,
	"activa" boolean DEFAULT true NOT NULL
);
CREATE TABLE IF NOT EXISTS "sucursales" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"tipo" "tipo_sucursal" DEFAULT 'express' NOT NULL,
	"punto_venta" text DEFAULT '' NOT NULL,
	"direccion" text DEFAULT '' NOT NULL
);
CREATE TABLE IF NOT EXISTS "terminales" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"sucursal_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"activa" boolean DEFAULT true NOT NULL,
	"creada_en" timestamp with time zone DEFAULT now() NOT NULL,
	"creada_por" integer,
	"ultimo_uso" timestamp with time zone,
	"ultimo_agente" text DEFAULT '' NOT NULL
);
CREATE TABLE IF NOT EXISTS "transferencia_hist" (
	"id" serial PRIMARY KEY NOT NULL,
	"transferencia_id" integer NOT NULL,
	"estado" "estado_transferencia" NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"usuario_id" integer
);
CREATE TABLE IF NOT EXISTS "transferencia_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"transferencia_id" integer NOT NULL,
	"producto_id" integer NOT NULL,
	"presentacion_id" integer,
	"cantidad" double precision DEFAULT 0 NOT NULL,
	"cantidad_preparada" double precision DEFAULT 0 NOT NULL,
	"cantidad_recibida" double precision,
	"agregado" boolean DEFAULT false NOT NULL,
	"motivo" text DEFAULT '' NOT NULL,
	"costo_unitario" double precision DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "transferencias" (
	"id" serial PRIMARY KEY NOT NULL,
	"codigo" text DEFAULT '' NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"origen_id" integer NOT NULL,
	"destino_id" integer NOT NULL,
	"usuario_id" integer,
	"estado" "estado_transferencia" DEFAULT 'pendiente' NOT NULL,
	"observaciones" text DEFAULT '' NOT NULL,
	"enteros_listo" boolean DEFAULT false NOT NULL,
	"granel_listo" boolean DEFAULT false NOT NULL
);
CREATE TABLE IF NOT EXISTS "usuarios" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"rol_id" integer NOT NULL,
	"password_hash" text DEFAULT '' NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"relevo_caja" boolean DEFAULT false NOT NULL,
	"pin_hash" text DEFAULT '' NOT NULL
);
CREATE TABLE IF NOT EXISTS "vencimiento_sesiones" (
	"id" serial PRIMARY KEY NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"sucursal_id" integer NOT NULL,
	"usuario_id" integer,
	"total_items" integer DEFAULT 0 NOT NULL,
	"total_unidades" double precision DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "vencimientos" (
	"id" serial PRIMARY KEY NOT NULL,
	"producto_id" integer NOT NULL,
	"presentacion_id" integer,
	"sucursal_id" integer NOT NULL,
	"sesion_id" integer,
	"fecha_vencimiento" date NOT NULL,
	"cantidad" double precision DEFAULT 0 NOT NULL,
	"costo_unitario" double precision DEFAULT 0 NOT NULL,
	"nombre" text DEFAULT '' NOT NULL,
	"unidad" text DEFAULT '' NOT NULL,
	"codigo_barras" text DEFAULT '' NOT NULL,
	"observaciones" text DEFAULT '' NOT NULL,
	"unidades_vendidas" double precision DEFAULT 0 NOT NULL,
	"procesado" boolean DEFAULT false NOT NULL,
	"procesado_en" timestamp with time zone,
	"merma_movimiento_id" integer,
	"oferta_id" integer,
	"usuario_id" integer,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "venta_extras" (
	"id" serial PRIMARY KEY NOT NULL,
	"venta_id" integer NOT NULL,
	"concepto" text DEFAULT '' NOT NULL,
	"importe" double precision DEFAULT 0 NOT NULL,
	"iva" double precision DEFAULT 21 NOT NULL
);
CREATE TABLE IF NOT EXISTS "venta_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"venta_id" integer NOT NULL,
	"producto_id" integer NOT NULL,
	"presentacion_id" integer,
	"cantidad" double precision DEFAULT 0 NOT NULL,
	"lista_id" integer,
	"lista" text DEFAULT '' NOT NULL,
	"lista_origen" "origen_lista" DEFAULT 'base' NOT NULL,
	"precio_lista" double precision DEFAULT 0 NOT NULL,
	"descuento" double precision DEFAULT 0 NOT NULL,
	"precio_unitario" double precision DEFAULT 0 NOT NULL,
	"iva" double precision DEFAULT 21 NOT NULL,
	"oferta_id" integer,
	"oferta" text DEFAULT '' NOT NULL,
	"oferta_descuento" double precision DEFAULT 0 NOT NULL,
	"descuento_id" integer,
	"descuento_nombre" text DEFAULT '' NOT NULL,
	"descuento_base" double precision DEFAULT 0 NOT NULL,
	"subtotal" double precision DEFAULT 0 NOT NULL,
	"costo_unitario" double precision,
	"iva_absorbido_unitario" double precision,
	"porc_sin_factura" double precision,
	"ref_item_id" integer
);
CREATE TABLE IF NOT EXISTS "venta_pagos" (
	"id" serial PRIMARY KEY NOT NULL,
	"venta_id" integer NOT NULL,
	"medio" "medio_pago" DEFAULT 'efectivo' NOT NULL,
	"importe" double precision DEFAULT 0 NOT NULL,
	"referencia" text DEFAULT '' NOT NULL
);
CREATE TABLE IF NOT EXISTS "ventas" (
	"id" serial PRIMARY KEY NOT NULL,
	"tipo" "tipo_venta" DEFAULT 'ticket' NOT NULL,
	"punto_venta" text DEFAULT '0001' NOT NULL,
	"numero" integer,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"cliente_id" integer NOT NULL,
	"sucursal_id" integer,
	"usuario_id" integer,
	"caja_sesion_id" integer,
	"estado" "estado_venta" DEFAULT 'confirmada' NOT NULL,
	"condicion_pago" "condicion_pago" DEFAULT 'contado' NOT NULL,
	"vencimiento_pago" timestamp with time zone,
	"presupuesto_id" integer,
	"lista_precio" text DEFAULT '' NOT NULL,
	"subtotal_neto" double precision DEFAULT 0 NOT NULL,
	"descuento_total" double precision DEFAULT 0 NOT NULL,
	"iva_total" double precision DEFAULT 0 NOT NULL,
	"total" double precision DEFAULT 0 NOT NULL,
	"cae" text DEFAULT '' NOT NULL,
	"cae_vencimiento" timestamp with time zone,
	"facturar_pendiente" boolean DEFAULT false NOT NULL,
	"facturar_motivo" text DEFAULT '' NOT NULL,
	"facturar_cbte_nro" integer,
	"facturar_cbte_tipo" integer,
	"ref_venta_id" integer,
	"observaciones" text DEFAULT '' NOT NULL,
	"anulado_por" integer,
	"anulado_en" timestamp with time zone,
	"anulado_motivo" text DEFAULT '' NOT NULL,
	"cobrado_por" integer
);
CREATE TABLE IF NOT EXISTS "web_eventos" (
	"id" serial PRIMARY KEY NOT NULL,
	"fecha" timestamp with time zone DEFAULT now() NOT NULL,
	"sesion" text DEFAULT '' NOT NULL,
	"tipo" text NOT NULL,
	"ruta" text DEFAULT '' NOT NULL,
	"producto_id" integer,
	"segundos" double precision DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "web_imagenes" (
	"id" serial PRIMARY KEY NOT NULL,
	"tipo" "tipo_imagen_web" NOT NULL,
	"ref_id" integer NOT NULL,
	"mime" text DEFAULT 'image/jpeg' NOT NULL,
	"data" text NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "auditoria" ADD CONSTRAINT "auditoria_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "caja_controles" ADD CONSTRAINT "caja_controles_caja_sesion_id_caja_sesiones_id_fk" FOREIGN KEY ("caja_sesion_id") REFERENCES "public"."caja_sesiones"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "caja_controles" ADD CONSTRAINT "caja_controles_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "caja_movimientos" ADD CONSTRAINT "caja_movimientos_caja_sesion_id_caja_sesiones_id_fk" FOREIGN KEY ("caja_sesion_id") REFERENCES "public"."caja_sesiones"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "caja_movimientos" ADD CONSTRAINT "caja_movimientos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "caja_sesiones" ADD CONSTRAINT "caja_sesiones_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "caja_sesiones" ADD CONSTRAINT "caja_sesiones_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "chat_lecturas" ADD CONSTRAINT "chat_lecturas_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "chat_lecturas" ADD CONSTRAINT "chat_lecturas_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "chat_mensajes" ADD CONSTRAINT "chat_mensajes_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "chat_mensajes" ADD CONSTRAINT "chat_mensajes_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "chat_mensajes" ADD CONSTRAINT "chat_mensajes_para_usuario_id_usuarios_id_fk" FOREIGN KEY ("para_usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "cliente_listas" ADD CONSTRAINT "cliente_listas_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "cliente_listas" ADD CONSTRAINT "cliente_listas_lista_id_listas_venta_id_fk" FOREIGN KEY ("lista_id") REFERENCES "public"."listas_venta"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "clientes" ADD CONSTRAINT "clientes_vendedor_id_usuarios_id_fk" FOREIGN KEY ("vendedor_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "clientes" ADD CONSTRAINT "clientes_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "cobranza_imputaciones" ADD CONSTRAINT "cobranza_imputaciones_cobranza_id_cobranzas_id_fk" FOREIGN KEY ("cobranza_id") REFERENCES "public"."cobranzas"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "cobranza_imputaciones" ADD CONSTRAINT "cobranza_imputaciones_venta_id_ventas_id_fk" FOREIGN KEY ("venta_id") REFERENCES "public"."ventas"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "cobranza_pagos" ADD CONSTRAINT "cobranza_pagos_cobranza_id_cobranzas_id_fk" FOREIGN KEY ("cobranza_id") REFERENCES "public"."cobranzas"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "cobranzas" ADD CONSTRAINT "cobranzas_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "cobranzas" ADD CONSTRAINT "cobranzas_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "cobranzas" ADD CONSTRAINT "cobranzas_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "cobranzas" ADD CONSTRAINT "cobranzas_caja_sesion_id_caja_sesiones_id_fk" FOREIGN KEY ("caja_sesion_id") REFERENCES "public"."caja_sesiones"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "cobranzas" ADD CONSTRAINT "cobranzas_anulado_por_usuarios_id_fk" FOREIGN KEY ("anulado_por") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "comprobante_items" ADD CONSTRAINT "comprobante_items_comprobante_id_comprobantes_id_fk" FOREIGN KEY ("comprobante_id") REFERENCES "public"."comprobantes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "comprobante_items" ADD CONSTRAINT "comprobante_items_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "comprobante_items" ADD CONSTRAINT "comprobante_items_presentacion_id_presentaciones_id_fk" FOREIGN KEY ("presentacion_id") REFERENCES "public"."presentaciones"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "comprobante_percepciones" ADD CONSTRAINT "comprobante_percepciones_comprobante_id_comprobantes_id_fk" FOREIGN KEY ("comprobante_id") REFERENCES "public"."comprobantes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "comprobantes" ADD CONSTRAINT "comprobantes_proveedor_id_proveedores_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedores"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "comprobantes" ADD CONSTRAINT "comprobantes_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "comprobantes" ADD CONSTRAINT "comprobantes_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "conteo_items" ADD CONSTRAINT "conteo_items_conteo_id_conteos_id_fk" FOREIGN KEY ("conteo_id") REFERENCES "public"."conteos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "conteo_items" ADD CONSTRAINT "conteo_items_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "conteo_items" ADD CONSTRAINT "conteo_items_presentacion_id_presentaciones_id_fk" FOREIGN KEY ("presentacion_id") REFERENCES "public"."presentaciones"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "conteo_items" ADD CONSTRAINT "conteo_items_contado_por_usuarios_id_fk" FOREIGN KEY ("contado_por") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "conteos" ADD CONSTRAINT "conteos_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "conteos" ADD CONSTRAINT "conteos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "conteos" ADD CONSTRAINT "conteos_aplicado_por_usuarios_id_fk" FOREIGN KEY ("aplicado_por") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "descuentos" ADD CONSTRAINT "descuentos_lista_id_listas_venta_id_fk" FOREIGN KEY ("lista_id") REFERENCES "public"."listas_venta"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "descuentos" ADD CONSTRAINT "descuentos_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "envio_cafeteria_items" ADD CONSTRAINT "envio_cafeteria_items_envio_id_envios_cafeteria_id_fk" FOREIGN KEY ("envio_id") REFERENCES "public"."envios_cafeteria"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "envio_cafeteria_items" ADD CONSTRAINT "envio_cafeteria_items_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "envio_cafeteria_items" ADD CONSTRAINT "envio_cafeteria_items_presentacion_id_presentaciones_id_fk" FOREIGN KEY ("presentacion_id") REFERENCES "public"."presentaciones"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "envios_cafeteria" ADD CONSTRAINT "envios_cafeteria_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "envios_cafeteria" ADD CONSTRAINT "envios_cafeteria_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "factura_archivos" ADD CONSTRAINT "factura_archivos_lectura_id_factura_lecturas_id_fk" FOREIGN KEY ("lectura_id") REFERENCES "public"."factura_lecturas"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "factura_lecturas" ADD CONSTRAINT "factura_lecturas_proveedor_id_proveedores_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedores"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "factura_lecturas" ADD CONSTRAINT "factura_lecturas_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "factura_lecturas" ADD CONSTRAINT "factura_lecturas_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "factura_lecturas" ADD CONSTRAINT "factura_lecturas_comprobante_id_comprobantes_id_fk" FOREIGN KEY ("comprobante_id") REFERENCES "public"."comprobantes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "gasto_adjuntos" ADD CONSTRAINT "gasto_adjuntos_gasto_id_gastos_id_fk" FOREIGN KEY ("gasto_id") REFERENCES "public"."gastos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "gasto_items" ADD CONSTRAINT "gasto_items_gasto_id_gastos_id_fk" FOREIGN KEY ("gasto_id") REFERENCES "public"."gastos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "gastos" ADD CONSTRAINT "gastos_proveedor_id_proveedores_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedores"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "gastos" ADD CONSTRAINT "gastos_categoria_id_gasto_categorias_id_fk" FOREIGN KEY ("categoria_id") REFERENCES "public"."gasto_categorias"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "gastos" ADD CONSTRAINT "gastos_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "gastos" ADD CONSTRAINT "gastos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "gastos_recurrentes" ADD CONSTRAINT "gastos_recurrentes_categoria_id_gasto_categorias_id_fk" FOREIGN KEY ("categoria_id") REFERENCES "public"."gasto_categorias"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "gastos_recurrentes" ADD CONSTRAINT "gastos_recurrentes_proveedor_id_proveedores_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedores"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "gastos_recurrentes" ADD CONSTRAINT "gastos_recurrentes_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "incidencias" ADD CONSTRAINT "incidencias_responsable_id_usuarios_id_fk" FOREIGN KEY ("responsable_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "incidencias" ADD CONSTRAINT "incidencias_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "incidencias" ADD CONSTRAINT "incidencias_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "incidencias" ADD CONSTRAINT "incidencias_presentacion_id_presentaciones_id_fk" FOREIGN KEY ("presentacion_id") REFERENCES "public"."presentaciones"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "listas_venta" ADD CONSTRAINT "listas_venta_modalidad_id_modalidades_venta_id_fk" FOREIGN KEY ("modalidad_id") REFERENCES "public"."modalidades_venta"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "movimientos" ADD CONSTRAINT "movimientos_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "movimientos" ADD CONSTRAINT "movimientos_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "movimientos" ADD CONSTRAINT "movimientos_presentacion_id_presentaciones_id_fk" FOREIGN KEY ("presentacion_id") REFERENCES "public"."presentaciones"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "movimientos" ADD CONSTRAINT "movimientos_sucursal_destino_id_sucursales_id_fk" FOREIGN KEY ("sucursal_destino_id") REFERENCES "public"."sucursales"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "movimientos" ADD CONSTRAINT "movimientos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "oferta_alcances" ADD CONSTRAINT "oferta_alcances_oferta_id_ofertas_id_fk" FOREIGN KEY ("oferta_id") REFERENCES "public"."ofertas"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "oferta_componentes" ADD CONSTRAINT "oferta_componentes_oferta_id_ofertas_id_fk" FOREIGN KEY ("oferta_id") REFERENCES "public"."ofertas"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "oferta_componentes" ADD CONSTRAINT "oferta_componentes_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pago_formas" ADD CONSTRAINT "pago_formas_pago_id_proveedor_pagos_id_fk" FOREIGN KEY ("pago_id") REFERENCES "public"."proveedor_pagos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pedido_cafeteria_items" ADD CONSTRAINT "pedido_cafeteria_items_pedido_id_pedidos_cafeteria_id_fk" FOREIGN KEY ("pedido_id") REFERENCES "public"."pedidos_cafeteria"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pedido_cafeteria_items" ADD CONSTRAINT "pedido_cafeteria_items_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pedido_cafeteria_items" ADD CONSTRAINT "pedido_cafeteria_items_presentacion_id_presentaciones_id_fk" FOREIGN KEY ("presentacion_id") REFERENCES "public"."presentaciones"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pedidos_cafeteria" ADD CONSTRAINT "pedidos_cafeteria_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pedidos_proveedor" ADD CONSTRAINT "pedidos_proveedor_proveedor_id_proveedores_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "pedidos_proveedor" ADD CONSTRAINT "pedidos_proveedor_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "precio_historial" ADD CONSTRAINT "precio_historial_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "precio_historial" ADD CONSTRAINT "precio_historial_lista_id_listas_venta_id_fk" FOREIGN KEY ("lista_id") REFERENCES "public"."listas_venta"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "precio_historial" ADD CONSTRAINT "precio_historial_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "presentaciones" ADD CONSTRAINT "presentaciones_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "presupuesto_items" ADD CONSTRAINT "presupuesto_items_presupuesto_id_presupuestos_id_fk" FOREIGN KEY ("presupuesto_id") REFERENCES "public"."presupuestos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "presupuesto_items" ADD CONSTRAINT "presupuesto_items_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "presupuesto_items" ADD CONSTRAINT "presupuesto_items_presentacion_id_presentaciones_id_fk" FOREIGN KEY ("presentacion_id") REFERENCES "public"."presentaciones"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "presupuesto_items" ADD CONSTRAINT "presupuesto_items_lista_id_listas_venta_id_fk" FOREIGN KEY ("lista_id") REFERENCES "public"."listas_venta"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "presupuestos" ADD CONSTRAINT "presupuestos_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "presupuestos" ADD CONSTRAINT "presupuestos_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "presupuestos" ADD CONSTRAINT "presupuestos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "presupuestos" ADD CONSTRAINT "presupuestos_vendedor_id_usuarios_id_fk" FOREIGN KEY ("vendedor_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "presupuestos" ADD CONSTRAINT "presupuestos_venta_id_ventas_id_fk" FOREIGN KEY ("venta_id") REFERENCES "public"."ventas"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "producto_etiquetas" ADD CONSTRAINT "producto_etiquetas_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "producto_etiquetas" ADD CONSTRAINT "producto_etiquetas_etiqueta_id_etiquetas_id_fk" FOREIGN KEY ("etiqueta_id") REFERENCES "public"."etiquetas"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "producto_listas" ADD CONSTRAINT "producto_listas_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "producto_listas" ADD CONSTRAINT "producto_listas_presentacion_id_presentaciones_id_fk" FOREIGN KEY ("presentacion_id") REFERENCES "public"."presentaciones"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "producto_listas" ADD CONSTRAINT "producto_listas_lista_id_listas_venta_id_fk" FOREIGN KEY ("lista_id") REFERENCES "public"."listas_venta"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "producto_proveedor_costos" ADD CONSTRAINT "producto_proveedor_costos_producto_proveedor_id_producto_proveedores_id_fk" FOREIGN KEY ("producto_proveedor_id") REFERENCES "public"."producto_proveedores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "producto_proveedor_costos" ADD CONSTRAINT "producto_proveedor_costos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "producto_proveedores" ADD CONSTRAINT "producto_proveedores_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "producto_proveedores" ADD CONSTRAINT "producto_proveedores_proveedor_id_proveedores_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "productos" ADD CONSTRAINT "productos_marca_id_marcas_id_fk" FOREIGN KEY ("marca_id") REFERENCES "public"."marcas"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "productos" ADD CONSTRAINT "productos_categoria_id_categorias_id_fk" FOREIGN KEY ("categoria_id") REFERENCES "public"."categorias"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "productos" ADD CONSTRAINT "productos_subcategoria_id_subcategorias_id_fk" FOREIGN KEY ("subcategoria_id") REFERENCES "public"."subcategorias"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "proveedor_ajustes" ADD CONSTRAINT "proveedor_ajustes_proveedor_id_proveedores_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "proveedor_ajustes" ADD CONSTRAINT "proveedor_ajustes_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "proveedor_articulos" ADD CONSTRAINT "proveedor_articulos_proveedor_id_proveedores_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "proveedor_articulos" ADD CONSTRAINT "proveedor_articulos_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "proveedor_compromisos" ADD CONSTRAINT "proveedor_compromisos_proveedor_id_proveedores_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedores"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "proveedor_compromisos" ADD CONSTRAINT "proveedor_compromisos_comprobante_id_comprobantes_id_fk" FOREIGN KEY ("comprobante_id") REFERENCES "public"."comprobantes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "proveedor_compromisos" ADD CONSTRAINT "proveedor_compromisos_pago_id_proveedor_pagos_id_fk" FOREIGN KEY ("pago_id") REFERENCES "public"."proveedor_pagos"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "proveedor_cuentas" ADD CONSTRAINT "proveedor_cuentas_proveedor_id_proveedores_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "proveedor_echeqs" ADD CONSTRAINT "proveedor_echeqs_proveedor_id_proveedores_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedores"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "proveedor_echeqs" ADD CONSTRAINT "proveedor_echeqs_compromiso_id_proveedor_compromisos_id_fk" FOREIGN KEY ("compromiso_id") REFERENCES "public"."proveedor_compromisos"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "proveedor_echeqs" ADD CONSTRAINT "proveedor_echeqs_pago_id_proveedor_pagos_id_fk" FOREIGN KEY ("pago_id") REFERENCES "public"."proveedor_pagos"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "proveedor_imputaciones" ADD CONSTRAINT "proveedor_imputaciones_pago_id_proveedor_pagos_id_fk" FOREIGN KEY ("pago_id") REFERENCES "public"."proveedor_pagos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "proveedor_imputaciones" ADD CONSTRAINT "proveedor_imputaciones_gasto_id_gastos_id_fk" FOREIGN KEY ("gasto_id") REFERENCES "public"."gastos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "proveedor_imputaciones" ADD CONSTRAINT "proveedor_imputaciones_comprobante_id_comprobantes_id_fk" FOREIGN KEY ("comprobante_id") REFERENCES "public"."comprobantes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "proveedor_imputaciones" ADD CONSTRAINT "proveedor_imputaciones_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "proveedor_pagos" ADD CONSTRAINT "proveedor_pagos_proveedor_id_proveedores_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedores"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "proveedor_pagos" ADD CONSTRAINT "proveedor_pagos_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "proveedor_pagos" ADD CONSTRAINT "proveedor_pagos_caja_sesion_id_caja_sesiones_id_fk" FOREIGN KEY ("caja_sesion_id") REFERENCES "public"."caja_sesiones"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "proveedor_pagos" ADD CONSTRAINT "proveedor_pagos_caja_movimiento_id_caja_movimientos_id_fk" FOREIGN KEY ("caja_movimiento_id") REFERENCES "public"."caja_movimientos"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "proveedor_pagos" ADD CONSTRAINT "proveedor_pagos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "proveedor_percepciones" ADD CONSTRAINT "proveedor_percepciones_proveedor_id_proveedores_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "reglas_marca" ADD CONSTRAINT "reglas_marca_marca_id_marcas_id_fk" FOREIGN KEY ("marca_id") REFERENCES "public"."marcas"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "reglas_marca" ADD CONSTRAINT "reglas_marca_modalidad_id_modalidades_venta_id_fk" FOREIGN KEY ("modalidad_id") REFERENCES "public"."modalidades_venta"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "sesiones" ADD CONSTRAINT "sesiones_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "sesiones" ADD CONSTRAINT "sesiones_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "stock" ADD CONSTRAINT "stock_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "stock" ADD CONSTRAINT "stock_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "stock" ADD CONSTRAINT "stock_presentacion_id_presentaciones_id_fk" FOREIGN KEY ("presentacion_id") REFERENCES "public"."presentaciones"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "subcategorias" ADD CONSTRAINT "subcategorias_categoria_id_categorias_id_fk" FOREIGN KEY ("categoria_id") REFERENCES "public"."categorias"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "terminales" ADD CONSTRAINT "terminales_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "terminales" ADD CONSTRAINT "terminales_creada_por_usuarios_id_fk" FOREIGN KEY ("creada_por") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "transferencia_hist" ADD CONSTRAINT "transferencia_hist_transferencia_id_transferencias_id_fk" FOREIGN KEY ("transferencia_id") REFERENCES "public"."transferencias"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "transferencia_hist" ADD CONSTRAINT "transferencia_hist_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "transferencia_items" ADD CONSTRAINT "transferencia_items_transferencia_id_transferencias_id_fk" FOREIGN KEY ("transferencia_id") REFERENCES "public"."transferencias"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "transferencia_items" ADD CONSTRAINT "transferencia_items_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "transferencia_items" ADD CONSTRAINT "transferencia_items_presentacion_id_presentaciones_id_fk" FOREIGN KEY ("presentacion_id") REFERENCES "public"."presentaciones"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "transferencias" ADD CONSTRAINT "transferencias_origen_id_sucursales_id_fk" FOREIGN KEY ("origen_id") REFERENCES "public"."sucursales"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "transferencias" ADD CONSTRAINT "transferencias_destino_id_sucursales_id_fk" FOREIGN KEY ("destino_id") REFERENCES "public"."sucursales"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "transferencias" ADD CONSTRAINT "transferencias_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_rol_id_roles_id_fk" FOREIGN KEY ("rol_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "vencimiento_sesiones" ADD CONSTRAINT "vencimiento_sesiones_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "vencimiento_sesiones" ADD CONSTRAINT "vencimiento_sesiones_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "vencimientos" ADD CONSTRAINT "vencimientos_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "vencimientos" ADD CONSTRAINT "vencimientos_presentacion_id_presentaciones_id_fk" FOREIGN KEY ("presentacion_id") REFERENCES "public"."presentaciones"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "vencimientos" ADD CONSTRAINT "vencimientos_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "vencimientos" ADD CONSTRAINT "vencimientos_sesion_id_vencimiento_sesiones_id_fk" FOREIGN KEY ("sesion_id") REFERENCES "public"."vencimiento_sesiones"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "vencimientos" ADD CONSTRAINT "vencimientos_oferta_id_ofertas_id_fk" FOREIGN KEY ("oferta_id") REFERENCES "public"."ofertas"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "vencimientos" ADD CONSTRAINT "vencimientos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "venta_extras" ADD CONSTRAINT "venta_extras_venta_id_ventas_id_fk" FOREIGN KEY ("venta_id") REFERENCES "public"."ventas"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "venta_items" ADD CONSTRAINT "venta_items_venta_id_ventas_id_fk" FOREIGN KEY ("venta_id") REFERENCES "public"."ventas"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "venta_items" ADD CONSTRAINT "venta_items_producto_id_productos_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."productos"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "venta_items" ADD CONSTRAINT "venta_items_presentacion_id_presentaciones_id_fk" FOREIGN KEY ("presentacion_id") REFERENCES "public"."presentaciones"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "venta_items" ADD CONSTRAINT "venta_items_lista_id_listas_venta_id_fk" FOREIGN KEY ("lista_id") REFERENCES "public"."listas_venta"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "venta_items" ADD CONSTRAINT "venta_items_oferta_id_ofertas_id_fk" FOREIGN KEY ("oferta_id") REFERENCES "public"."ofertas"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "venta_items" ADD CONSTRAINT "venta_items_descuento_id_descuentos_id_fk" FOREIGN KEY ("descuento_id") REFERENCES "public"."descuentos"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "venta_pagos" ADD CONSTRAINT "venta_pagos_venta_id_ventas_id_fk" FOREIGN KEY ("venta_id") REFERENCES "public"."ventas"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "ventas" ADD CONSTRAINT "ventas_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "ventas" ADD CONSTRAINT "ventas_sucursal_id_sucursales_id_fk" FOREIGN KEY ("sucursal_id") REFERENCES "public"."sucursales"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "ventas" ADD CONSTRAINT "ventas_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "ventas" ADD CONSTRAINT "ventas_caja_sesion_id_caja_sesiones_id_fk" FOREIGN KEY ("caja_sesion_id") REFERENCES "public"."caja_sesiones"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "ventas" ADD CONSTRAINT "ventas_anulado_por_usuarios_id_fk" FOREIGN KEY ("anulado_por") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "ventas" ADD CONSTRAINT "ventas_cobrado_por_usuarios_id_fk" FOREIGN KEY ("cobrado_por") REFERENCES "public"."usuarios"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "ix_auditoria_entidad" ON "auditoria" USING btree ("entidad","entidad_id");CREATE INDEX IF NOT EXISTS "ix_caja_controles_sesion" ON "caja_controles" USING btree ("caja_sesion_id");CREATE INDEX IF NOT EXISTS "ix_caja_mov_sesion" ON "caja_movimientos" USING btree ("caja_sesion_id");CREATE INDEX IF NOT EXISTS "ix_caja_sesiones_sucursal" ON "caja_sesiones" USING btree ("sucursal_id","estado");CREATE UNIQUE INDEX IF NOT EXISTS "uq_caja_abierta_por_sucursal" ON "caja_sesiones" USING btree ("sucursal_id") WHERE "caja_sesiones"."estado" = 'abierta';CREATE UNIQUE INDEX IF NOT EXISTS "uq_categoria_nombre" ON "categorias" USING btree ("nombre");CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_lectura" ON "chat_lecturas" USING btree ("sucursal_id","usuario_id","canal_usuario_id");CREATE INDEX IF NOT EXISTS "ix_chat_mensajes_canal" ON "chat_mensajes" USING btree ("sucursal_id","id");CREATE INDEX IF NOT EXISTS "ix_chat_mensajes_para" ON "chat_mensajes" USING btree ("sucursal_id","para_usuario_id","id");CREATE UNIQUE INDEX IF NOT EXISTS "uq_cliente_lista" ON "cliente_listas" USING btree ("cliente_id","lista_id");CREATE INDEX IF NOT EXISTS "ix_clientes_nombre" ON "clientes" USING btree ("nombre");CREATE INDEX IF NOT EXISTS "ix_clientes_doc" ON "clientes" USING btree ("tipo_doc","numero_doc");CREATE INDEX IF NOT EXISTS "ix_cobranza_imput_cobranza" ON "cobranza_imputaciones" USING btree ("cobranza_id");CREATE INDEX IF NOT EXISTS "ix_cobranza_imput_venta" ON "cobranza_imputaciones" USING btree ("venta_id");CREATE INDEX IF NOT EXISTS "ix_cobranza_pagos_cobranza" ON "cobranza_pagos" USING btree ("cobranza_id");CREATE INDEX IF NOT EXISTS "ix_cobranzas_cliente" ON "cobranzas" USING btree ("cliente_id");CREATE UNIQUE INDEX IF NOT EXISTS "uq_cobranzas_numero" ON "cobranzas" USING btree ("punto_venta","numero");CREATE INDEX IF NOT EXISTS "ix_cobranzas_caja_sesion" ON "cobranzas" USING btree ("caja_sesion_id");CREATE INDEX IF NOT EXISTS "ix_comprobante_items_comprobante" ON "comprobante_items" USING btree ("comprobante_id");CREATE INDEX IF NOT EXISTS "ix_comprobante_percepciones_comprobante" ON "comprobante_percepciones" USING btree ("comprobante_id");CREATE UNIQUE INDEX IF NOT EXISTS "uq_comprobantes_numero" ON "comprobantes" USING btree ("proveedor_id","tipo","punto_venta","numero") WHERE "comprobantes"."numero" is not null;CREATE INDEX IF NOT EXISTS "ix_comprobantes_ref" ON "comprobantes" USING btree ("ref_comprobante_id") WHERE "comprobantes"."ref_comprobante_id" is not null;CREATE INDEX IF NOT EXISTS "ix_comprobantes_proveedor" ON "comprobantes" USING btree ("proveedor_id","estado");CREATE UNIQUE INDEX IF NOT EXISTS "uq_configuracion_clave" ON "configuracion" USING btree ("clave");CREATE INDEX IF NOT EXISTS "ix_conteo_items_conteo" ON "conteo_items" USING btree ("conteo_id");CREATE UNIQUE INDEX IF NOT EXISTS "uq_conteo_items_forma" ON "conteo_items" USING btree ("conteo_id","producto_id",COALESCE("presentacion_id", 0));CREATE INDEX IF NOT EXISTS "ix_conteos_sucursal" ON "conteos" USING btree ("sucursal_id","estado");CREATE UNIQUE INDEX IF NOT EXISTS "uq_descuentos_nombre" ON "descuentos" USING btree ("nombre");CREATE INDEX IF NOT EXISTS "ix_descuentos_vigentes" ON "descuentos" USING btree ("activo","lista_id");CREATE INDEX IF NOT EXISTS "ix_envios_cafe_fecha" ON "envios_cafeteria" USING btree ("fecha");CREATE INDEX IF NOT EXISTS "ix_envios_cafe_actualizado" ON "envios_cafeteria" USING btree ("actualizado_en");CREATE UNIQUE INDEX IF NOT EXISTS "uq_etiqueta_nombre" ON "etiquetas" USING btree ("nombre");CREATE INDEX IF NOT EXISTS "ix_factura_archivos_lectura" ON "factura_archivos" USING btree ("lectura_id");CREATE INDEX IF NOT EXISTS "ix_factura_lecturas_estado" ON "factura_lecturas" USING btree ("estado");CREATE INDEX IF NOT EXISTS "ix_factura_lecturas_numero" ON "factura_lecturas" USING btree ("proveedor_id","numero");CREATE INDEX IF NOT EXISTS "ix_factura_lecturas_hash" ON "factura_lecturas" USING btree ("hash");CREATE INDEX IF NOT EXISTS "ix_gasto_adjuntos_gasto" ON "gasto_adjuntos" USING btree ("gasto_id");CREATE UNIQUE INDEX IF NOT EXISTS "uq_gasto_categoria_nombre" ON "gasto_categorias" USING btree ("nombre");CREATE INDEX IF NOT EXISTS "ix_gasto_items_gasto" ON "gasto_items" USING btree ("gasto_id");CREATE INDEX IF NOT EXISTS "ix_gastos_fecha" ON "gastos" USING btree ("fecha");CREATE INDEX IF NOT EXISTS "ix_gastos_estado" ON "gastos" USING btree ("estado","vencimiento");CREATE INDEX IF NOT EXISTS "ix_gastos_categoria" ON "gastos" USING btree ("categoria_id");CREATE INDEX IF NOT EXISTS "ix_gastos_proveedor" ON "gastos" USING btree ("proveedor_id");CREATE INDEX IF NOT EXISTS "ix_gastos_recurrente" ON "gastos" USING btree ("recurrente_id");CREATE INDEX IF NOT EXISTS "ix_gastos_recurrentes_activo" ON "gastos_recurrentes" USING btree ("activo");CREATE UNIQUE INDEX IF NOT EXISTS "uq_lista_modalidad_numero" ON "listas_venta" USING btree ("modalidad_id","numero");CREATE INDEX IF NOT EXISTS "ix_listas_venta_orden" ON "listas_venta" USING btree ("orden");CREATE UNIQUE INDEX IF NOT EXISTS "uq_marca_nombre" ON "marcas" USING btree ("nombre");CREATE UNIQUE INDEX IF NOT EXISTS "uq_oferta_alcance" ON "oferta_alcances" USING btree ("oferta_id","tipo","ref_id");CREATE UNIQUE INDEX IF NOT EXISTS "uq_oferta_componente" ON "oferta_componentes" USING btree ("oferta_id","producto_id");CREATE INDEX IF NOT EXISTS "ix_pago_formas_pago" ON "pago_formas" USING btree ("pago_id");CREATE INDEX IF NOT EXISTS "ix_pedidos_cafe_estado" ON "pedidos_cafeteria" USING btree ("estado");CREATE INDEX IF NOT EXISTS "ix_pedidos_proveedor_estado" ON "pedidos_proveedor" USING btree ("estado","proveedor_id");CREATE INDEX IF NOT EXISTS "ix_pedidos_proveedor_recepcion" ON "pedidos_proveedor" USING btree ("fecha_recepcion");CREATE INDEX IF NOT EXISTS "ix_precio_historial_producto" ON "precio_historial" USING btree ("producto_id","fecha");CREATE INDEX IF NOT EXISTS "ix_precio_historial_fecha" ON "precio_historial" USING btree ("fecha");CREATE INDEX IF NOT EXISTS "ix_presentaciones_codigo" ON "presentaciones" USING btree ("codigo_barras");CREATE UNIQUE INDEX IF NOT EXISTS "uq_presentacion_codigo_barras" ON "presentaciones" USING btree ("codigo_barras") WHERE "presentaciones"."codigo_barras" <> '';CREATE INDEX IF NOT EXISTS "ix_presupuesto_items_presupuesto" ON "presupuesto_items" USING btree ("presupuesto_id");CREATE INDEX IF NOT EXISTS "ix_presupuestos_estado_origen" ON "presupuestos" USING btree ("estado","origen");CREATE INDEX IF NOT EXISTS "ix_presupuestos_cliente" ON "presupuestos" USING btree ("cliente_id");CREATE UNIQUE INDEX IF NOT EXISTS "uq_producto_etiqueta" ON "producto_etiquetas" USING btree ("producto_id","etiqueta_id");CREATE INDEX IF NOT EXISTS "ix_producto_etiquetas_etiqueta" ON "producto_etiquetas" USING btree ("etiqueta_id");CREATE UNIQUE INDEX IF NOT EXISTS "uq_producto_lista" ON "producto_listas" USING btree ("producto_id","lista_id") WHERE "producto_listas"."presentacion_id" IS NULL;CREATE UNIQUE INDEX IF NOT EXISTS "uq_presentacion_lista" ON "producto_listas" USING btree ("presentacion_id","lista_id") WHERE "producto_listas"."presentacion_id" IS NOT NULL;CREATE INDEX IF NOT EXISTS "ix_producto_listas_producto" ON "producto_listas" USING btree ("producto_id");CREATE INDEX IF NOT EXISTS "ix_producto_listas_presentacion" ON "producto_listas" USING btree ("presentacion_id");CREATE UNIQUE INDEX IF NOT EXISTS "uq_producto_lista_codigo" ON "producto_listas" USING btree ("codigo_barras") WHERE "producto_listas"."codigo_barras" <> '';CREATE INDEX IF NOT EXISTS "ix_ppc_entrada" ON "producto_proveedor_costos" USING btree ("producto_proveedor_id","fecha");CREATE INDEX IF NOT EXISTS "ix_ppc_lote" ON "producto_proveedor_costos" USING btree ("lote");CREATE INDEX IF NOT EXISTS "ix_producto_proveedores_producto" ON "producto_proveedores" USING btree ("producto_id");CREATE INDEX IF NOT EXISTS "ix_producto_proveedores_proveedor" ON "producto_proveedores" USING btree ("proveedor_id");CREATE INDEX IF NOT EXISTS "ix_productos_codigo" ON "productos" USING btree ("codigo_barras");CREATE INDEX IF NOT EXISTS "ix_productos_codigo_propio" ON "productos" USING btree ("codigo_propio");CREATE INDEX IF NOT EXISTS "ix_productos_marca" ON "productos" USING btree ("marca_id");CREATE INDEX IF NOT EXISTS "ix_productos_categoria" ON "productos" USING btree ("categoria_id");CREATE UNIQUE INDEX IF NOT EXISTS "uq_producto_codigo_propio" ON "productos" USING btree ("codigo_propio") WHERE "productos"."codigo_propio" <> '';CREATE UNIQUE INDEX IF NOT EXISTS "uq_producto_codigo_barras" ON "productos" USING btree ("codigo_barras") WHERE "productos"."codigo_barras" <> '';CREATE UNIQUE INDEX IF NOT EXISTS "uq_producto_dun" ON "productos" USING btree ("dun") WHERE "productos"."dun" <> '';CREATE INDEX IF NOT EXISTS "ix_proveedor_ajustes_prov" ON "proveedor_ajustes" USING btree ("proveedor_id");CREATE UNIQUE INDEX IF NOT EXISTS "uq_proveedor_articulo" ON "proveedor_articulos" USING btree ("proveedor_id","codigo");CREATE INDEX IF NOT EXISTS "ix_compromisos_pendientes" ON "proveedor_compromisos" USING btree ("pagado","fecha_venc");CREATE INDEX IF NOT EXISTS "ix_compromisos_comprobante" ON "proveedor_compromisos" USING btree ("comprobante_id");CREATE INDEX IF NOT EXISTS "ix_compromisos_proveedor" ON "proveedor_compromisos" USING btree ("proveedor_id","pagado");CREATE INDEX IF NOT EXISTS "ix_proveedor_cuentas_prov" ON "proveedor_cuentas" USING btree ("proveedor_id");CREATE INDEX IF NOT EXISTS "ix_echeqs_estado" ON "proveedor_echeqs" USING btree ("estado","fecha_venc");CREATE INDEX IF NOT EXISTS "ix_echeqs_compromiso" ON "proveedor_echeqs" USING btree ("compromiso_id");CREATE INDEX IF NOT EXISTS "ix_prov_imput_pago" ON "proveedor_imputaciones" USING btree ("pago_id");CREATE INDEX IF NOT EXISTS "ix_prov_imput_gasto" ON "proveedor_imputaciones" USING btree ("gasto_id");CREATE INDEX IF NOT EXISTS "ix_prov_imput_comprobante" ON "proveedor_imputaciones" USING btree ("comprobante_id");CREATE INDEX IF NOT EXISTS "ix_proveedor_pagos_proveedor" ON "proveedor_pagos" USING btree ("proveedor_id","estado");CREATE INDEX IF NOT EXISTS "ix_proveedor_pagos_fecha" ON "proveedor_pagos" USING btree ("fecha");CREATE INDEX IF NOT EXISTS "ix_proveedor_pagos_caja" ON "proveedor_pagos" USING btree ("caja_sesion_id");CREATE INDEX IF NOT EXISTS "ix_proveedor_percepciones" ON "proveedor_percepciones" USING btree ("proveedor_id");CREATE UNIQUE INDEX IF NOT EXISTS "uq_regla_marca" ON "reglas_marca" USING btree ("marca_id","modalidad_id");CREATE UNIQUE INDEX IF NOT EXISTS "ix_sesiones_token" ON "sesiones" USING btree ("token_hash");CREATE INDEX IF NOT EXISTS "ix_sesiones_usuario" ON "sesiones" USING btree ("usuario_id");CREATE INDEX IF NOT EXISTS "ix_sesiones_expira" ON "sesiones" USING btree ("expira_en");CREATE UNIQUE INDEX IF NOT EXISTS "uq_subcategoria_nombre" ON "subcategorias" USING btree ("categoria_id","nombre");CREATE UNIQUE INDEX IF NOT EXISTS "uq_sucursal_punto_venta" ON "sucursales" USING btree ("punto_venta") WHERE "sucursales"."punto_venta" <> '';CREATE UNIQUE INDEX IF NOT EXISTS "uq_sucursal_distribuidora" ON "sucursales" USING btree ("tipo") WHERE "sucursales"."tipo" = 'distribuidora';CREATE UNIQUE INDEX IF NOT EXISTS "ix_terminales_token" ON "terminales" USING btree ("token_hash");CREATE INDEX IF NOT EXISTS "ix_terminales_sucursal" ON "terminales" USING btree ("sucursal_id");CREATE INDEX IF NOT EXISTS "ix_venc_sesiones_fecha" ON "vencimiento_sesiones" USING btree ("fecha");CREATE INDEX IF NOT EXISTS "ix_vencimientos_fecha" ON "vencimientos" USING btree ("fecha_vencimiento");CREATE INDEX IF NOT EXISTS "ix_vencimientos_sucursal" ON "vencimientos" USING btree ("sucursal_id");CREATE INDEX IF NOT EXISTS "ix_vencimientos_producto" ON "vencimientos" USING btree ("producto_id");CREATE INDEX IF NOT EXISTS "ix_vencimientos_procesado" ON "vencimientos" USING btree ("procesado");CREATE INDEX IF NOT EXISTS "ix_venta_extras_venta" ON "venta_extras" USING btree ("venta_id");CREATE INDEX IF NOT EXISTS "ix_venta_items_venta" ON "venta_items" USING btree ("venta_id");CREATE INDEX IF NOT EXISTS "ix_venta_pagos_venta" ON "venta_pagos" USING btree ("venta_id");CREATE INDEX IF NOT EXISTS "ix_ventas_cliente" ON "ventas" USING btree ("cliente_id");CREATE INDEX IF NOT EXISTS "ix_ventas_fecha" ON "ventas" USING btree ("fecha");CREATE UNIQUE INDEX IF NOT EXISTS "uq_ventas_numero" ON "ventas" USING btree ("tipo","punto_venta","numero") WHERE "ventas"."numero" is not null;CREATE INDEX IF NOT EXISTS "ix_ventas_abiertas" ON "ventas" USING btree ("sucursal_id","estado");CREATE INDEX IF NOT EXISTS "ix_ventas_caja_sesion" ON "ventas" USING btree ("caja_sesion_id");CREATE INDEX IF NOT EXISTS "ix_web_eventos_fecha" ON "web_eventos" USING btree ("fecha");CREATE INDEX IF NOT EXISTS "ix_web_eventos_producto" ON "web_eventos" USING btree ("producto_id");CREATE UNIQUE INDEX IF NOT EXISTS "uq_web_imagen" ON "web_imagenes" USING btree ("tipo","ref_id");