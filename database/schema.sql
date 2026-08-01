--
-- PostgreSQL database dump
--

\restrict r9VqnH07hIG05xgSqxRUF9Evrg22Id05ZTQLcY1bdZTCe2O42ONKaStUvCEGqU5

-- Dumped from database version 18.4
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: drizzle; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA drizzle;


--
-- Name: condicion_iva; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.condicion_iva AS ENUM (
    'responsable_inscripto',
    'monotributo',
    'consumidor_final',
    'exento',
    'no_categorizado'
);


--
-- Name: condicion_pago; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.condicion_pago AS ENUM (
    'contado',
    'cuenta_corriente'
);


--
-- Name: estado_caja; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.estado_caja AS ENUM (
    'abierta',
    'cerrada'
);


--
-- Name: estado_cobranza; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.estado_cobranza AS ENUM (
    'confirmada',
    'anulada'
);


--
-- Name: estado_comprobante; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.estado_comprobante AS ENUM (
    'borrador',
    'confirmado',
    'anulado'
);


--
-- Name: estado_incidencia; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.estado_incidencia AS ENUM (
    'pendiente',
    'revision',
    'resuelta'
);


--
-- Name: estado_stock; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.estado_stock AS ENUM (
    'disponible',
    'comprometido',
    'retenido',
    'defectuoso',
    'vencido'
);


--
-- Name: estado_transferencia; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.estado_transferencia AS ENUM (
    'pendiente',
    'preparada',
    'transito',
    'recibida',
    'cancelada'
);


--
-- Name: estado_venta; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.estado_venta AS ENUM (
    'borrador',
    'confirmada',
    'anulada',
    'pendiente_cae'
);


--
-- Name: letra_comprobante; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.letra_comprobante AS ENUM (
    'A',
    'B',
    'C',
    'X'
);


--
-- Name: medio_pago; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.medio_pago AS ENUM (
    'efectivo',
    'transferencia',
    'tarjeta_debito',
    'tarjeta_credito',
    'cheque',
    'qr',
    'otro'
);


--
-- Name: origen_costo; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.origen_costo AS ENUM (
    'alta',
    'manual',
    'masiva',
    'recepcion',
    'reversion'
);


--
-- Name: rol; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.rol AS ENUM (
    'admin',
    'fraccionador',
    'vendedor'
);


--
-- Name: tipo_comprobante; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tipo_comprobante AS ENUM (
    'orden_compra',
    'remito',
    'factura',
    'nota_credito',
    'nota_debito'
);


--
-- Name: tipo_doc; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tipo_doc AS ENUM (
    'cuit',
    'cuil',
    'dni',
    'sin_identificar'
);


--
-- Name: tipo_mov_caja; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tipo_mov_caja AS ENUM (
    'ingreso',
    'egreso'
);


--
-- Name: tipo_movimiento; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tipo_movimiento AS ENUM (
    'compra',
    'fraccionamiento',
    'venta_granel',
    'venta_fraccionada',
    'devolucion',
    'ajuste',
    'merma',
    'vencido',
    'defectuoso',
    'transferencia'
);


--
-- Name: tipo_producto; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tipo_producto AS ENUM (
    'granel',
    'entero'
);


--
-- Name: tipo_sucursal; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tipo_sucursal AS ENUM (
    'distribuidora',
    'express'
);


--
-- Name: tipo_venta; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tipo_venta AS ENUM (
    'ticket',
    'factura_a',
    'factura_b',
    'factura_c',
    'nota_credito',
    'nota_debito'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: __drizzle_migrations; Type: TABLE; Schema: drizzle; Owner: -
--

CREATE TABLE drizzle.__drizzle_migrations (
    id integer NOT NULL,
    hash text NOT NULL,
    created_at bigint
);


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE; Schema: drizzle; Owner: -
--

CREATE SEQUENCE drizzle.__drizzle_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: drizzle; Owner: -
--

ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNED BY drizzle.__drizzle_migrations.id;


--
-- Name: caja_movimientos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.caja_movimientos (
    id integer NOT NULL,
    caja_sesion_id integer NOT NULL,
    fecha timestamp with time zone DEFAULT now() NOT NULL,
    tipo public.tipo_mov_caja NOT NULL,
    motivo text DEFAULT ''::text NOT NULL,
    importe double precision DEFAULT 0 NOT NULL,
    usuario_id integer
);


--
-- Name: caja_movimientos_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.caja_movimientos_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: caja_movimientos_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.caja_movimientos_id_seq OWNED BY public.caja_movimientos.id;


--
-- Name: caja_sesiones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.caja_sesiones (
    id integer NOT NULL,
    sucursal_id integer NOT NULL,
    usuario_id integer,
    apertura timestamp with time zone DEFAULT now() NOT NULL,
    monto_inicial double precision DEFAULT 0 NOT NULL,
    cierre timestamp with time zone,
    declarado_efectivo double precision DEFAULT 0 NOT NULL,
    sistema_efectivo double precision DEFAULT 0 NOT NULL,
    diferencia double precision DEFAULT 0 NOT NULL,
    totales jsonb DEFAULT '{}'::jsonb NOT NULL,
    estado public.estado_caja DEFAULT 'abierta'::public.estado_caja NOT NULL,
    observaciones text DEFAULT ''::text NOT NULL
);


--
-- Name: caja_sesiones_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.caja_sesiones_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: caja_sesiones_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.caja_sesiones_id_seq OWNED BY public.caja_sesiones.id;


--
-- Name: clientes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clientes (
    id integer NOT NULL,
    nombre text NOT NULL,
    nombre_fantasia text DEFAULT ''::text NOT NULL,
    tipo_doc public.tipo_doc DEFAULT 'dni'::public.tipo_doc NOT NULL,
    numero_doc text DEFAULT ''::text NOT NULL,
    condicion_iva public.condicion_iva DEFAULT 'consumidor_final'::public.condicion_iva NOT NULL,
    direccion text DEFAULT ''::text NOT NULL,
    localidad text DEFAULT ''::text NOT NULL,
    telefono text DEFAULT ''::text NOT NULL,
    email text DEFAULT ''::text NOT NULL,
    lista_precio text DEFAULT ''::text NOT NULL,
    descuento double precision DEFAULT 0 NOT NULL,
    vendedor_id integer,
    sucursal_id integer,
    cta_cte_habilitada boolean DEFAULT false NOT NULL,
    limite_credito double precision DEFAULT 0 NOT NULL,
    dias_plazo integer DEFAULT 0 NOT NULL,
    observaciones text DEFAULT ''::text NOT NULL,
    activo boolean DEFAULT true NOT NULL,
    es_consumidor_final boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: clientes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.clientes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: clientes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.clientes_id_seq OWNED BY public.clientes.id;


--
-- Name: cobranza_imputaciones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cobranza_imputaciones (
    id integer NOT NULL,
    cobranza_id integer NOT NULL,
    venta_id integer NOT NULL,
    importe double precision DEFAULT 0 NOT NULL
);


--
-- Name: cobranza_imputaciones_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cobranza_imputaciones_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cobranza_imputaciones_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cobranza_imputaciones_id_seq OWNED BY public.cobranza_imputaciones.id;


--
-- Name: cobranza_pagos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cobranza_pagos (
    id integer NOT NULL,
    cobranza_id integer NOT NULL,
    medio public.medio_pago DEFAULT 'efectivo'::public.medio_pago NOT NULL,
    importe double precision DEFAULT 0 NOT NULL,
    referencia text DEFAULT ''::text NOT NULL
);


--
-- Name: cobranza_pagos_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cobranza_pagos_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cobranza_pagos_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cobranza_pagos_id_seq OWNED BY public.cobranza_pagos.id;


--
-- Name: cobranzas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cobranzas (
    id integer NOT NULL,
    punto_venta text DEFAULT '0001'::text NOT NULL,
    numero integer DEFAULT 0 NOT NULL,
    fecha timestamp with time zone DEFAULT now() NOT NULL,
    cliente_id integer NOT NULL,
    sucursal_id integer,
    usuario_id integer,
    total double precision DEFAULT 0 NOT NULL,
    a_cuenta double precision DEFAULT 0 NOT NULL,
    estado public.estado_cobranza DEFAULT 'confirmada'::public.estado_cobranza NOT NULL,
    observaciones text DEFAULT ''::text NOT NULL,
    caja_sesion_id integer
);


--
-- Name: cobranzas_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cobranzas_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cobranzas_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cobranzas_id_seq OWNED BY public.cobranzas.id;


--
-- Name: comprobante_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comprobante_items (
    id integer NOT NULL,
    comprobante_id integer NOT NULL,
    producto_id integer NOT NULL,
    presentacion_id integer,
    cantidad double precision DEFAULT 0 NOT NULL,
    costo_unitario double precision DEFAULT 0 NOT NULL,
    descuento double precision DEFAULT 0 NOT NULL,
    iva double precision DEFAULT 21 NOT NULL,
    subtotal double precision DEFAULT 0 NOT NULL
);


--
-- Name: comprobante_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.comprobante_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: comprobante_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.comprobante_items_id_seq OWNED BY public.comprobante_items.id;


--
-- Name: comprobantes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comprobantes (
    id integer NOT NULL,
    tipo public.tipo_comprobante NOT NULL,
    letra public.letra_comprobante DEFAULT 'A'::public.letra_comprobante NOT NULL,
    punto_venta text DEFAULT '0001'::text NOT NULL,
    numero integer,
    fecha timestamp with time zone DEFAULT now() NOT NULL,
    proveedor_id integer NOT NULL,
    sucursal_id integer,
    estado public.estado_comprobante DEFAULT 'confirmado'::public.estado_comprobante NOT NULL,
    condicion_pago public.condicion_pago DEFAULT 'cuenta_corriente'::public.condicion_pago NOT NULL,
    vencimiento_pago timestamp with time zone,
    recepcion boolean DEFAULT false NOT NULL,
    subtotal_neto double precision DEFAULT 0 NOT NULL,
    iva_total double precision DEFAULT 0 NOT NULL,
    total double precision DEFAULT 0 NOT NULL,
    ref_comprobante_id integer,
    observaciones text DEFAULT ''::text NOT NULL,
    usuario_id integer,
    fecha_carga timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: comprobantes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.comprobantes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: comprobantes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.comprobantes_id_seq OWNED BY public.comprobantes.id;


--
-- Name: configuracion; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.configuracion (
    id integer NOT NULL,
    clave text NOT NULL,
    valor jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: configuracion_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.configuracion_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: configuracion_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.configuracion_id_seq OWNED BY public.configuracion.id;


--
-- Name: incidencias; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.incidencias (
    id integer NOT NULL,
    codigo text DEFAULT ''::text NOT NULL,
    fecha timestamp with time zone DEFAULT now() NOT NULL,
    tipo text NOT NULL,
    estado public.estado_incidencia DEFAULT 'pendiente'::public.estado_incidencia NOT NULL,
    responsable_id integer,
    motivo text DEFAULT ''::text NOT NULL,
    producto_id integer NOT NULL,
    sucursal_id integer NOT NULL,
    presentacion_id integer,
    cantidad double precision DEFAULT 0 NOT NULL,
    unidad text DEFAULT ''::text NOT NULL,
    resolucion text,
    fecha_resolucion timestamp with time zone,
    activa boolean DEFAULT true NOT NULL
);


--
-- Name: incidencias_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.incidencias_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: incidencias_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.incidencias_id_seq OWNED BY public.incidencias.id;


--
-- Name: listas_precio; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.listas_precio (
    id integer NOT NULL,
    producto_id integer NOT NULL,
    nombre text NOT NULL,
    ganancia double precision DEFAULT 0 NOT NULL
);


--
-- Name: listas_precio_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.listas_precio_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: listas_precio_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.listas_precio_id_seq OWNED BY public.listas_precio.id;


--
-- Name: movimientos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.movimientos (
    id integer NOT NULL,
    fecha timestamp with time zone DEFAULT now() NOT NULL,
    tipo public.tipo_movimiento NOT NULL,
    producto_id integer,
    sucursal_id integer,
    presentacion_id integer,
    signo integer DEFAULT 0 NOT NULL,
    cantidad double precision DEFAULT 0 NOT NULL,
    unidad text DEFAULT ''::text NOT NULL,
    motivo text DEFAULT ''::text NOT NULL,
    pres_label text DEFAULT ''::text NOT NULL,
    estado_desde public.estado_stock,
    estado_hacia public.estado_stock,
    sucursal_destino_id integer,
    vencimiento timestamp with time zone,
    proveedor_nombre text DEFAULT ''::text NOT NULL,
    usuario_id integer,
    ref_transferencia_id integer,
    ref_incidencia_id integer,
    descripcion text DEFAULT ''::text NOT NULL
);


--
-- Name: movimientos_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.movimientos_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: movimientos_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.movimientos_id_seq OWNED BY public.movimientos.id;


--
-- Name: presentaciones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.presentaciones (
    id integer NOT NULL,
    producto_id integer NOT NULL,
    tam_kg double precision NOT NULL,
    codigo_barras text DEFAULT ''::text NOT NULL,
    recargo double precision DEFAULT 0 NOT NULL
);


--
-- Name: presentaciones_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.presentaciones_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: presentaciones_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.presentaciones_id_seq OWNED BY public.presentaciones.id;


--
-- Name: producto_proveedor_costos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.producto_proveedor_costos (
    id integer NOT NULL,
    producto_proveedor_id integer NOT NULL,
    fecha timestamp with time zone DEFAULT now() NOT NULL,
    costo_anterior double precision DEFAULT 0 NOT NULL,
    descuento_anterior double precision DEFAULT 0 NOT NULL,
    flete_anterior double precision DEFAULT 0 NOT NULL,
    costo double precision DEFAULT 0 NOT NULL,
    descuento double precision DEFAULT 0 NOT NULL,
    flete double precision DEFAULT 0 NOT NULL,
    origen public.origen_costo DEFAULT 'manual'::public.origen_costo NOT NULL,
    motivo text DEFAULT ''::text NOT NULL,
    lote text DEFAULT ''::text NOT NULL,
    usuario_id integer,
    comprobante_id integer,
    activo_anterior integer,
    activo_nuevo integer
);


--
-- Name: producto_proveedor_costos_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.producto_proveedor_costos_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: producto_proveedor_costos_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.producto_proveedor_costos_id_seq OWNED BY public.producto_proveedor_costos.id;


--
-- Name: producto_proveedores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.producto_proveedores (
    id integer NOT NULL,
    producto_id integer NOT NULL,
    proveedor_id integer NOT NULL,
    costo double precision DEFAULT 0 NOT NULL,
    descuento double precision DEFAULT 0 NOT NULL,
    flete double precision DEFAULT 0 NOT NULL
);


--
-- Name: producto_proveedores_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.producto_proveedores_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: producto_proveedores_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.producto_proveedores_id_seq OWNED BY public.producto_proveedores.id;


--
-- Name: productos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.productos (
    id integer NOT NULL,
    nombre text NOT NULL,
    marca text DEFAULT ''::text NOT NULL,
    categoria text DEFAULT 'General'::text NOT NULL,
    iva double precision DEFAULT 21 NOT NULL,
    tipo public.tipo_producto DEFAULT 'entero'::public.tipo_producto NOT NULL,
    stock_min double precision DEFAULT 0 NOT NULL,
    proveedor_activo_id integer,
    codigo_barras text DEFAULT ''::text NOT NULL
);


--
-- Name: productos_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.productos_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: productos_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.productos_id_seq OWNED BY public.productos.id;


--
-- Name: proveedores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.proveedores (
    id integer NOT NULL,
    nombre text NOT NULL,
    cuit text DEFAULT ''::text NOT NULL,
    direccion text DEFAULT ''::text NOT NULL,
    telefono text DEFAULT ''::text NOT NULL,
    email text DEFAULT ''::text NOT NULL,
    condicion_iva public.condicion_iva DEFAULT 'responsable_inscripto'::public.condicion_iva NOT NULL
);


--
-- Name: proveedores_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.proveedores_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: proveedores_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.proveedores_id_seq OWNED BY public.proveedores.id;


--
-- Name: stock; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock (
    id integer NOT NULL,
    producto_id integer NOT NULL,
    sucursal_id integer NOT NULL,
    presentacion_id integer,
    estado public.estado_stock DEFAULT 'disponible'::public.estado_stock NOT NULL,
    cantidad double precision DEFAULT 0 NOT NULL
);


--
-- Name: stock_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stock_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stock_id_seq OWNED BY public.stock.id;


--
-- Name: sucursales; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sucursales (
    id integer NOT NULL,
    nombre text NOT NULL,
    tipo public.tipo_sucursal DEFAULT 'express'::public.tipo_sucursal NOT NULL
);


--
-- Name: sucursales_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sucursales_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sucursales_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sucursales_id_seq OWNED BY public.sucursales.id;


--
-- Name: transferencia_hist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transferencia_hist (
    id integer NOT NULL,
    transferencia_id integer NOT NULL,
    estado public.estado_transferencia NOT NULL,
    fecha timestamp with time zone DEFAULT now() NOT NULL,
    usuario_id integer
);


--
-- Name: transferencia_hist_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.transferencia_hist_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: transferencia_hist_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.transferencia_hist_id_seq OWNED BY public.transferencia_hist.id;


--
-- Name: transferencia_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transferencia_items (
    id integer NOT NULL,
    transferencia_id integer NOT NULL,
    producto_id integer NOT NULL,
    presentacion_id integer,
    cantidad double precision DEFAULT 0 NOT NULL
);


--
-- Name: transferencia_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.transferencia_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: transferencia_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.transferencia_items_id_seq OWNED BY public.transferencia_items.id;


--
-- Name: transferencias; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transferencias (
    id integer NOT NULL,
    codigo text DEFAULT ''::text NOT NULL,
    fecha timestamp with time zone DEFAULT now() NOT NULL,
    origen_id integer NOT NULL,
    destino_id integer NOT NULL,
    usuario_id integer,
    estado public.estado_transferencia DEFAULT 'pendiente'::public.estado_transferencia NOT NULL
);


--
-- Name: transferencias_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.transferencias_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: transferencias_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.transferencias_id_seq OWNED BY public.transferencias.id;


--
-- Name: usuarios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usuarios (
    id integer NOT NULL,
    nombre text NOT NULL,
    rol public.rol DEFAULT 'vendedor'::public.rol NOT NULL
);


--
-- Name: usuarios_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.usuarios_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: usuarios_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.usuarios_id_seq OWNED BY public.usuarios.id;


--
-- Name: venta_extras; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.venta_extras (
    id integer NOT NULL,
    venta_id integer NOT NULL,
    concepto text DEFAULT ''::text NOT NULL,
    importe double precision DEFAULT 0 NOT NULL,
    iva double precision DEFAULT 21 NOT NULL
);


--
-- Name: venta_extras_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.venta_extras_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: venta_extras_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.venta_extras_id_seq OWNED BY public.venta_extras.id;


--
-- Name: venta_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.venta_items (
    id integer NOT NULL,
    venta_id integer NOT NULL,
    producto_id integer NOT NULL,
    presentacion_id integer,
    cantidad double precision DEFAULT 0 NOT NULL,
    precio_lista double precision DEFAULT 0 NOT NULL,
    descuento double precision DEFAULT 0 NOT NULL,
    precio_unitario double precision DEFAULT 0 NOT NULL,
    iva double precision DEFAULT 21 NOT NULL,
    subtotal double precision DEFAULT 0 NOT NULL,
    ref_item_id integer
);


--
-- Name: venta_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.venta_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: venta_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.venta_items_id_seq OWNED BY public.venta_items.id;


--
-- Name: venta_pagos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.venta_pagos (
    id integer NOT NULL,
    venta_id integer NOT NULL,
    medio public.medio_pago DEFAULT 'efectivo'::public.medio_pago NOT NULL,
    importe double precision DEFAULT 0 NOT NULL,
    referencia text DEFAULT ''::text NOT NULL
);


--
-- Name: venta_pagos_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.venta_pagos_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: venta_pagos_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.venta_pagos_id_seq OWNED BY public.venta_pagos.id;


--
-- Name: ventas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ventas (
    id integer NOT NULL,
    tipo public.tipo_venta DEFAULT 'ticket'::public.tipo_venta NOT NULL,
    punto_venta text DEFAULT '0001'::text NOT NULL,
    numero integer,
    fecha timestamp with time zone DEFAULT now() NOT NULL,
    cliente_id integer NOT NULL,
    sucursal_id integer,
    usuario_id integer,
    estado public.estado_venta DEFAULT 'confirmada'::public.estado_venta NOT NULL,
    condicion_pago public.condicion_pago DEFAULT 'contado'::public.condicion_pago NOT NULL,
    vencimiento_pago timestamp with time zone,
    lista_precio text DEFAULT ''::text NOT NULL,
    subtotal_neto double precision DEFAULT 0 NOT NULL,
    descuento_total double precision DEFAULT 0 NOT NULL,
    iva_total double precision DEFAULT 0 NOT NULL,
    total double precision DEFAULT 0 NOT NULL,
    cae text DEFAULT ''::text NOT NULL,
    cae_vencimiento timestamp with time zone,
    ref_venta_id integer,
    observaciones text DEFAULT ''::text NOT NULL,
    caja_sesion_id integer
);


--
-- Name: ventas_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ventas_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ventas_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ventas_id_seq OWNED BY public.ventas.id;


--
-- Name: __drizzle_migrations id; Type: DEFAULT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations ALTER COLUMN id SET DEFAULT nextval('drizzle.__drizzle_migrations_id_seq'::regclass);


--
-- Name: caja_movimientos id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caja_movimientos ALTER COLUMN id SET DEFAULT nextval('public.caja_movimientos_id_seq'::regclass);


--
-- Name: caja_sesiones id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caja_sesiones ALTER COLUMN id SET DEFAULT nextval('public.caja_sesiones_id_seq'::regclass);


--
-- Name: clientes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clientes ALTER COLUMN id SET DEFAULT nextval('public.clientes_id_seq'::regclass);


--
-- Name: cobranza_imputaciones id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cobranza_imputaciones ALTER COLUMN id SET DEFAULT nextval('public.cobranza_imputaciones_id_seq'::regclass);


--
-- Name: cobranza_pagos id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cobranza_pagos ALTER COLUMN id SET DEFAULT nextval('public.cobranza_pagos_id_seq'::regclass);


--
-- Name: cobranzas id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cobranzas ALTER COLUMN id SET DEFAULT nextval('public.cobranzas_id_seq'::regclass);


--
-- Name: comprobante_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comprobante_items ALTER COLUMN id SET DEFAULT nextval('public.comprobante_items_id_seq'::regclass);


--
-- Name: comprobantes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comprobantes ALTER COLUMN id SET DEFAULT nextval('public.comprobantes_id_seq'::regclass);


--
-- Name: configuracion id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.configuracion ALTER COLUMN id SET DEFAULT nextval('public.configuracion_id_seq'::regclass);


--
-- Name: incidencias id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incidencias ALTER COLUMN id SET DEFAULT nextval('public.incidencias_id_seq'::regclass);


--
-- Name: listas_precio id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listas_precio ALTER COLUMN id SET DEFAULT nextval('public.listas_precio_id_seq'::regclass);


--
-- Name: movimientos id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos ALTER COLUMN id SET DEFAULT nextval('public.movimientos_id_seq'::regclass);


--
-- Name: presentaciones id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.presentaciones ALTER COLUMN id SET DEFAULT nextval('public.presentaciones_id_seq'::regclass);


--
-- Name: producto_proveedor_costos id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.producto_proveedor_costos ALTER COLUMN id SET DEFAULT nextval('public.producto_proveedor_costos_id_seq'::regclass);


--
-- Name: producto_proveedores id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.producto_proveedores ALTER COLUMN id SET DEFAULT nextval('public.producto_proveedores_id_seq'::regclass);


--
-- Name: productos id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.productos ALTER COLUMN id SET DEFAULT nextval('public.productos_id_seq'::regclass);


--
-- Name: proveedores id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proveedores ALTER COLUMN id SET DEFAULT nextval('public.proveedores_id_seq'::regclass);


--
-- Name: stock id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock ALTER COLUMN id SET DEFAULT nextval('public.stock_id_seq'::regclass);


--
-- Name: sucursales id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sucursales ALTER COLUMN id SET DEFAULT nextval('public.sucursales_id_seq'::regclass);


--
-- Name: transferencia_hist id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transferencia_hist ALTER COLUMN id SET DEFAULT nextval('public.transferencia_hist_id_seq'::regclass);


--
-- Name: transferencia_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transferencia_items ALTER COLUMN id SET DEFAULT nextval('public.transferencia_items_id_seq'::regclass);


--
-- Name: transferencias id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transferencias ALTER COLUMN id SET DEFAULT nextval('public.transferencias_id_seq'::regclass);


--
-- Name: usuarios id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios ALTER COLUMN id SET DEFAULT nextval('public.usuarios_id_seq'::regclass);


--
-- Name: venta_extras id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venta_extras ALTER COLUMN id SET DEFAULT nextval('public.venta_extras_id_seq'::regclass);


--
-- Name: venta_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venta_items ALTER COLUMN id SET DEFAULT nextval('public.venta_items_id_seq'::regclass);


--
-- Name: venta_pagos id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venta_pagos ALTER COLUMN id SET DEFAULT nextval('public.venta_pagos_id_seq'::regclass);


--
-- Name: ventas id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ventas ALTER COLUMN id SET DEFAULT nextval('public.ventas_id_seq'::regclass);


--
-- Name: __drizzle_migrations __drizzle_migrations_pkey; Type: CONSTRAINT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations
    ADD CONSTRAINT __drizzle_migrations_pkey PRIMARY KEY (id);


--
-- Name: caja_movimientos caja_movimientos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caja_movimientos
    ADD CONSTRAINT caja_movimientos_pkey PRIMARY KEY (id);


--
-- Name: caja_sesiones caja_sesiones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caja_sesiones
    ADD CONSTRAINT caja_sesiones_pkey PRIMARY KEY (id);


--
-- Name: clientes clientes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clientes
    ADD CONSTRAINT clientes_pkey PRIMARY KEY (id);


--
-- Name: cobranza_imputaciones cobranza_imputaciones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cobranza_imputaciones
    ADD CONSTRAINT cobranza_imputaciones_pkey PRIMARY KEY (id);


--
-- Name: cobranza_pagos cobranza_pagos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cobranza_pagos
    ADD CONSTRAINT cobranza_pagos_pkey PRIMARY KEY (id);


--
-- Name: cobranzas cobranzas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cobranzas
    ADD CONSTRAINT cobranzas_pkey PRIMARY KEY (id);


--
-- Name: comprobante_items comprobante_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comprobante_items
    ADD CONSTRAINT comprobante_items_pkey PRIMARY KEY (id);


--
-- Name: comprobantes comprobantes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comprobantes
    ADD CONSTRAINT comprobantes_pkey PRIMARY KEY (id);


--
-- Name: configuracion configuracion_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.configuracion
    ADD CONSTRAINT configuracion_pkey PRIMARY KEY (id);


--
-- Name: incidencias incidencias_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incidencias
    ADD CONSTRAINT incidencias_pkey PRIMARY KEY (id);


--
-- Name: listas_precio listas_precio_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listas_precio
    ADD CONSTRAINT listas_precio_pkey PRIMARY KEY (id);


--
-- Name: movimientos movimientos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos
    ADD CONSTRAINT movimientos_pkey PRIMARY KEY (id);


--
-- Name: presentaciones presentaciones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.presentaciones
    ADD CONSTRAINT presentaciones_pkey PRIMARY KEY (id);


--
-- Name: producto_proveedor_costos producto_proveedor_costos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.producto_proveedor_costos
    ADD CONSTRAINT producto_proveedor_costos_pkey PRIMARY KEY (id);


--
-- Name: producto_proveedores producto_proveedores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.producto_proveedores
    ADD CONSTRAINT producto_proveedores_pkey PRIMARY KEY (id);


--
-- Name: productos productos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.productos
    ADD CONSTRAINT productos_pkey PRIMARY KEY (id);


--
-- Name: proveedores proveedores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proveedores
    ADD CONSTRAINT proveedores_pkey PRIMARY KEY (id);


--
-- Name: stock stock_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock
    ADD CONSTRAINT stock_pkey PRIMARY KEY (id);


--
-- Name: sucursales sucursales_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sucursales
    ADD CONSTRAINT sucursales_pkey PRIMARY KEY (id);


--
-- Name: transferencia_hist transferencia_hist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transferencia_hist
    ADD CONSTRAINT transferencia_hist_pkey PRIMARY KEY (id);


--
-- Name: transferencia_items transferencia_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transferencia_items
    ADD CONSTRAINT transferencia_items_pkey PRIMARY KEY (id);


--
-- Name: transferencias transferencias_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transferencias
    ADD CONSTRAINT transferencias_pkey PRIMARY KEY (id);


--
-- Name: usuarios usuarios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios
    ADD CONSTRAINT usuarios_pkey PRIMARY KEY (id);


--
-- Name: venta_extras venta_extras_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venta_extras
    ADD CONSTRAINT venta_extras_pkey PRIMARY KEY (id);


--
-- Name: venta_items venta_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venta_items
    ADD CONSTRAINT venta_items_pkey PRIMARY KEY (id);


--
-- Name: venta_pagos venta_pagos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venta_pagos
    ADD CONSTRAINT venta_pagos_pkey PRIMARY KEY (id);


--
-- Name: ventas ventas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ventas
    ADD CONSTRAINT ventas_pkey PRIMARY KEY (id);


--
-- Name: ix_caja_mov_sesion; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_caja_mov_sesion ON public.caja_movimientos USING btree (caja_sesion_id);


--
-- Name: ix_caja_sesiones_sucursal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_caja_sesiones_sucursal ON public.caja_sesiones USING btree (sucursal_id, estado);


--
-- Name: ix_clientes_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_clientes_doc ON public.clientes USING btree (tipo_doc, numero_doc);


--
-- Name: ix_clientes_nombre; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_clientes_nombre ON public.clientes USING btree (nombre);


--
-- Name: ix_cobranza_imput_cobranza; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_cobranza_imput_cobranza ON public.cobranza_imputaciones USING btree (cobranza_id);


--
-- Name: ix_cobranza_imput_venta; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_cobranza_imput_venta ON public.cobranza_imputaciones USING btree (venta_id);


--
-- Name: ix_cobranza_pagos_cobranza; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_cobranza_pagos_cobranza ON public.cobranza_pagos USING btree (cobranza_id);


--
-- Name: ix_cobranzas_cliente; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_cobranzas_cliente ON public.cobranzas USING btree (cliente_id);


--
-- Name: ix_ppc_entrada; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ppc_entrada ON public.producto_proveedor_costos USING btree (producto_proveedor_id, fecha);


--
-- Name: ix_ppc_lote; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ppc_lote ON public.producto_proveedor_costos USING btree (lote);


--
-- Name: ix_presentaciones_codigo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_presentaciones_codigo ON public.presentaciones USING btree (codigo_barras);


--
-- Name: ix_productos_codigo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_productos_codigo ON public.productos USING btree (codigo_barras);


--
-- Name: ix_venta_extras_venta; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_venta_extras_venta ON public.venta_extras USING btree (venta_id);


--
-- Name: ix_venta_items_venta; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_venta_items_venta ON public.venta_items USING btree (venta_id);


--
-- Name: ix_venta_pagos_venta; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_venta_pagos_venta ON public.venta_pagos USING btree (venta_id);


--
-- Name: ix_ventas_abiertas; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ventas_abiertas ON public.ventas USING btree (sucursal_id, estado);


--
-- Name: ix_ventas_cliente; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ventas_cliente ON public.ventas USING btree (cliente_id);


--
-- Name: ix_ventas_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ventas_fecha ON public.ventas USING btree (fecha);


--
-- Name: uq_cobranzas_numero; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_cobranzas_numero ON public.cobranzas USING btree (punto_venta, numero);


--
-- Name: uq_configuracion_clave; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_configuracion_clave ON public.configuracion USING btree (clave);


--
-- Name: uq_producto_proveedor; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_producto_proveedor ON public.producto_proveedores USING btree (producto_id, proveedor_id);


--
-- Name: uq_ventas_numero; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_ventas_numero ON public.ventas USING btree (tipo, punto_venta, numero) WHERE (numero IS NOT NULL);


--
-- Name: caja_movimientos caja_movimientos_caja_sesion_id_caja_sesiones_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caja_movimientos
    ADD CONSTRAINT caja_movimientos_caja_sesion_id_caja_sesiones_id_fk FOREIGN KEY (caja_sesion_id) REFERENCES public.caja_sesiones(id) ON DELETE CASCADE;


--
-- Name: caja_movimientos caja_movimientos_usuario_id_usuarios_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caja_movimientos
    ADD CONSTRAINT caja_movimientos_usuario_id_usuarios_id_fk FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE SET NULL;


--
-- Name: caja_sesiones caja_sesiones_sucursal_id_sucursales_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caja_sesiones
    ADD CONSTRAINT caja_sesiones_sucursal_id_sucursales_id_fk FOREIGN KEY (sucursal_id) REFERENCES public.sucursales(id) ON DELETE RESTRICT;


--
-- Name: caja_sesiones caja_sesiones_usuario_id_usuarios_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caja_sesiones
    ADD CONSTRAINT caja_sesiones_usuario_id_usuarios_id_fk FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE SET NULL;


--
-- Name: clientes clientes_sucursal_id_sucursales_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clientes
    ADD CONSTRAINT clientes_sucursal_id_sucursales_id_fk FOREIGN KEY (sucursal_id) REFERENCES public.sucursales(id) ON DELETE SET NULL;


--
-- Name: clientes clientes_vendedor_id_usuarios_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clientes
    ADD CONSTRAINT clientes_vendedor_id_usuarios_id_fk FOREIGN KEY (vendedor_id) REFERENCES public.usuarios(id) ON DELETE SET NULL;


--
-- Name: cobranza_imputaciones cobranza_imputaciones_cobranza_id_cobranzas_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cobranza_imputaciones
    ADD CONSTRAINT cobranza_imputaciones_cobranza_id_cobranzas_id_fk FOREIGN KEY (cobranza_id) REFERENCES public.cobranzas(id) ON DELETE CASCADE;


--
-- Name: cobranza_imputaciones cobranza_imputaciones_venta_id_ventas_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cobranza_imputaciones
    ADD CONSTRAINT cobranza_imputaciones_venta_id_ventas_id_fk FOREIGN KEY (venta_id) REFERENCES public.ventas(id) ON DELETE RESTRICT;


--
-- Name: cobranza_pagos cobranza_pagos_cobranza_id_cobranzas_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cobranza_pagos
    ADD CONSTRAINT cobranza_pagos_cobranza_id_cobranzas_id_fk FOREIGN KEY (cobranza_id) REFERENCES public.cobranzas(id) ON DELETE CASCADE;


--
-- Name: cobranzas cobranzas_caja_sesion_id_caja_sesiones_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cobranzas
    ADD CONSTRAINT cobranzas_caja_sesion_id_caja_sesiones_id_fk FOREIGN KEY (caja_sesion_id) REFERENCES public.caja_sesiones(id) ON DELETE SET NULL;


--
-- Name: cobranzas cobranzas_cliente_id_clientes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cobranzas
    ADD CONSTRAINT cobranzas_cliente_id_clientes_id_fk FOREIGN KEY (cliente_id) REFERENCES public.clientes(id) ON DELETE RESTRICT;


--
-- Name: cobranzas cobranzas_sucursal_id_sucursales_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cobranzas
    ADD CONSTRAINT cobranzas_sucursal_id_sucursales_id_fk FOREIGN KEY (sucursal_id) REFERENCES public.sucursales(id) ON DELETE SET NULL;


--
-- Name: cobranzas cobranzas_usuario_id_usuarios_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cobranzas
    ADD CONSTRAINT cobranzas_usuario_id_usuarios_id_fk FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE SET NULL;


--
-- Name: comprobante_items comprobante_items_comprobante_id_comprobantes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comprobante_items
    ADD CONSTRAINT comprobante_items_comprobante_id_comprobantes_id_fk FOREIGN KEY (comprobante_id) REFERENCES public.comprobantes(id) ON DELETE CASCADE;


--
-- Name: comprobante_items comprobante_items_presentacion_id_presentaciones_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comprobante_items
    ADD CONSTRAINT comprobante_items_presentacion_id_presentaciones_id_fk FOREIGN KEY (presentacion_id) REFERENCES public.presentaciones(id) ON DELETE SET NULL;


--
-- Name: comprobante_items comprobante_items_producto_id_productos_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comprobante_items
    ADD CONSTRAINT comprobante_items_producto_id_productos_id_fk FOREIGN KEY (producto_id) REFERENCES public.productos(id) ON DELETE RESTRICT;


--
-- Name: comprobantes comprobantes_proveedor_id_proveedores_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comprobantes
    ADD CONSTRAINT comprobantes_proveedor_id_proveedores_id_fk FOREIGN KEY (proveedor_id) REFERENCES public.proveedores(id) ON DELETE RESTRICT;


--
-- Name: comprobantes comprobantes_sucursal_id_sucursales_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comprobantes
    ADD CONSTRAINT comprobantes_sucursal_id_sucursales_id_fk FOREIGN KEY (sucursal_id) REFERENCES public.sucursales(id) ON DELETE SET NULL;


--
-- Name: comprobantes comprobantes_usuario_id_usuarios_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comprobantes
    ADD CONSTRAINT comprobantes_usuario_id_usuarios_id_fk FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE SET NULL;


--
-- Name: incidencias incidencias_presentacion_id_presentaciones_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incidencias
    ADD CONSTRAINT incidencias_presentacion_id_presentaciones_id_fk FOREIGN KEY (presentacion_id) REFERENCES public.presentaciones(id) ON DELETE SET NULL;


--
-- Name: incidencias incidencias_producto_id_productos_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incidencias
    ADD CONSTRAINT incidencias_producto_id_productos_id_fk FOREIGN KEY (producto_id) REFERENCES public.productos(id) ON DELETE CASCADE;


--
-- Name: incidencias incidencias_responsable_id_usuarios_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incidencias
    ADD CONSTRAINT incidencias_responsable_id_usuarios_id_fk FOREIGN KEY (responsable_id) REFERENCES public.usuarios(id) ON DELETE SET NULL;


--
-- Name: incidencias incidencias_sucursal_id_sucursales_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incidencias
    ADD CONSTRAINT incidencias_sucursal_id_sucursales_id_fk FOREIGN KEY (sucursal_id) REFERENCES public.sucursales(id) ON DELETE CASCADE;


--
-- Name: listas_precio listas_precio_producto_id_productos_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listas_precio
    ADD CONSTRAINT listas_precio_producto_id_productos_id_fk FOREIGN KEY (producto_id) REFERENCES public.productos(id) ON DELETE CASCADE;


--
-- Name: movimientos movimientos_presentacion_id_presentaciones_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos
    ADD CONSTRAINT movimientos_presentacion_id_presentaciones_id_fk FOREIGN KEY (presentacion_id) REFERENCES public.presentaciones(id) ON DELETE SET NULL;


--
-- Name: movimientos movimientos_producto_id_productos_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos
    ADD CONSTRAINT movimientos_producto_id_productos_id_fk FOREIGN KEY (producto_id) REFERENCES public.productos(id) ON DELETE SET NULL;


--
-- Name: movimientos movimientos_sucursal_destino_id_sucursales_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos
    ADD CONSTRAINT movimientos_sucursal_destino_id_sucursales_id_fk FOREIGN KEY (sucursal_destino_id) REFERENCES public.sucursales(id) ON DELETE SET NULL;


--
-- Name: movimientos movimientos_sucursal_id_sucursales_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos
    ADD CONSTRAINT movimientos_sucursal_id_sucursales_id_fk FOREIGN KEY (sucursal_id) REFERENCES public.sucursales(id) ON DELETE SET NULL;


--
-- Name: movimientos movimientos_usuario_id_usuarios_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientos
    ADD CONSTRAINT movimientos_usuario_id_usuarios_id_fk FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE SET NULL;


--
-- Name: presentaciones presentaciones_producto_id_productos_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.presentaciones
    ADD CONSTRAINT presentaciones_producto_id_productos_id_fk FOREIGN KEY (producto_id) REFERENCES public.productos(id) ON DELETE CASCADE;


--
-- Name: producto_proveedor_costos producto_proveedor_costos_producto_proveedor_id_producto_provee; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.producto_proveedor_costos
    ADD CONSTRAINT producto_proveedor_costos_producto_proveedor_id_producto_provee FOREIGN KEY (producto_proveedor_id) REFERENCES public.producto_proveedores(id) ON DELETE CASCADE;


--
-- Name: producto_proveedor_costos producto_proveedor_costos_usuario_id_usuarios_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.producto_proveedor_costos
    ADD CONSTRAINT producto_proveedor_costos_usuario_id_usuarios_id_fk FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE SET NULL;


--
-- Name: producto_proveedores producto_proveedores_producto_id_productos_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.producto_proveedores
    ADD CONSTRAINT producto_proveedores_producto_id_productos_id_fk FOREIGN KEY (producto_id) REFERENCES public.productos(id) ON DELETE CASCADE;


--
-- Name: producto_proveedores producto_proveedores_proveedor_id_proveedores_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.producto_proveedores
    ADD CONSTRAINT producto_proveedores_proveedor_id_proveedores_id_fk FOREIGN KEY (proveedor_id) REFERENCES public.proveedores(id) ON DELETE CASCADE;


--
-- Name: productos productos_proveedor_activo_id_proveedores_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.productos
    ADD CONSTRAINT productos_proveedor_activo_id_proveedores_id_fk FOREIGN KEY (proveedor_activo_id) REFERENCES public.proveedores(id) ON DELETE SET NULL;


--
-- Name: stock stock_presentacion_id_presentaciones_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock
    ADD CONSTRAINT stock_presentacion_id_presentaciones_id_fk FOREIGN KEY (presentacion_id) REFERENCES public.presentaciones(id) ON DELETE CASCADE;


--
-- Name: stock stock_producto_id_productos_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock
    ADD CONSTRAINT stock_producto_id_productos_id_fk FOREIGN KEY (producto_id) REFERENCES public.productos(id) ON DELETE CASCADE;


--
-- Name: stock stock_sucursal_id_sucursales_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock
    ADD CONSTRAINT stock_sucursal_id_sucursales_id_fk FOREIGN KEY (sucursal_id) REFERENCES public.sucursales(id) ON DELETE CASCADE;


--
-- Name: transferencia_hist transferencia_hist_transferencia_id_transferencias_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transferencia_hist
    ADD CONSTRAINT transferencia_hist_transferencia_id_transferencias_id_fk FOREIGN KEY (transferencia_id) REFERENCES public.transferencias(id) ON DELETE CASCADE;


--
-- Name: transferencia_hist transferencia_hist_usuario_id_usuarios_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transferencia_hist
    ADD CONSTRAINT transferencia_hist_usuario_id_usuarios_id_fk FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE SET NULL;


--
-- Name: transferencia_items transferencia_items_presentacion_id_presentaciones_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transferencia_items
    ADD CONSTRAINT transferencia_items_presentacion_id_presentaciones_id_fk FOREIGN KEY (presentacion_id) REFERENCES public.presentaciones(id) ON DELETE SET NULL;


--
-- Name: transferencia_items transferencia_items_producto_id_productos_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transferencia_items
    ADD CONSTRAINT transferencia_items_producto_id_productos_id_fk FOREIGN KEY (producto_id) REFERENCES public.productos(id) ON DELETE CASCADE;


--
-- Name: transferencia_items transferencia_items_transferencia_id_transferencias_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transferencia_items
    ADD CONSTRAINT transferencia_items_transferencia_id_transferencias_id_fk FOREIGN KEY (transferencia_id) REFERENCES public.transferencias(id) ON DELETE CASCADE;


--
-- Name: transferencias transferencias_destino_id_sucursales_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transferencias
    ADD CONSTRAINT transferencias_destino_id_sucursales_id_fk FOREIGN KEY (destino_id) REFERENCES public.sucursales(id) ON DELETE RESTRICT;


--
-- Name: transferencias transferencias_origen_id_sucursales_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transferencias
    ADD CONSTRAINT transferencias_origen_id_sucursales_id_fk FOREIGN KEY (origen_id) REFERENCES public.sucursales(id) ON DELETE RESTRICT;


--
-- Name: transferencias transferencias_usuario_id_usuarios_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transferencias
    ADD CONSTRAINT transferencias_usuario_id_usuarios_id_fk FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE SET NULL;


--
-- Name: venta_extras venta_extras_venta_id_ventas_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venta_extras
    ADD CONSTRAINT venta_extras_venta_id_ventas_id_fk FOREIGN KEY (venta_id) REFERENCES public.ventas(id) ON DELETE CASCADE;


--
-- Name: venta_items venta_items_presentacion_id_presentaciones_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venta_items
    ADD CONSTRAINT venta_items_presentacion_id_presentaciones_id_fk FOREIGN KEY (presentacion_id) REFERENCES public.presentaciones(id) ON DELETE SET NULL;


--
-- Name: venta_items venta_items_producto_id_productos_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venta_items
    ADD CONSTRAINT venta_items_producto_id_productos_id_fk FOREIGN KEY (producto_id) REFERENCES public.productos(id) ON DELETE RESTRICT;


--
-- Name: venta_items venta_items_venta_id_ventas_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venta_items
    ADD CONSTRAINT venta_items_venta_id_ventas_id_fk FOREIGN KEY (venta_id) REFERENCES public.ventas(id) ON DELETE CASCADE;


--
-- Name: venta_pagos venta_pagos_venta_id_ventas_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venta_pagos
    ADD CONSTRAINT venta_pagos_venta_id_ventas_id_fk FOREIGN KEY (venta_id) REFERENCES public.ventas(id) ON DELETE CASCADE;


--
-- Name: ventas ventas_caja_sesion_id_caja_sesiones_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ventas
    ADD CONSTRAINT ventas_caja_sesion_id_caja_sesiones_id_fk FOREIGN KEY (caja_sesion_id) REFERENCES public.caja_sesiones(id) ON DELETE SET NULL;


--
-- Name: ventas ventas_cliente_id_clientes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ventas
    ADD CONSTRAINT ventas_cliente_id_clientes_id_fk FOREIGN KEY (cliente_id) REFERENCES public.clientes(id) ON DELETE RESTRICT;


--
-- Name: ventas ventas_sucursal_id_sucursales_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ventas
    ADD CONSTRAINT ventas_sucursal_id_sucursales_id_fk FOREIGN KEY (sucursal_id) REFERENCES public.sucursales(id) ON DELETE SET NULL;


--
-- Name: ventas ventas_usuario_id_usuarios_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ventas
    ADD CONSTRAINT ventas_usuario_id_usuarios_id_fk FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

\unrestrict r9VqnH07hIG05xgSqxRUF9Evrg22Id05ZTQLcY1bdZTCe2O42ONKaStUvCEGqU5

