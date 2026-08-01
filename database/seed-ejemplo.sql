--
-- PostgreSQL database dump
--

\restrict JhofMXepQj3uHf6yN7lt8vehceFFnQSBPLl0DP1epB0fd0iP0FUKfAfsgcWi7em

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
-- Data for Name: __drizzle_migrations; Type: TABLE DATA; Schema: drizzle; Owner: -
--

COPY drizzle.__drizzle_migrations (id, hash, created_at) FROM stdin;
1	3caa7764d3316a06d8e9732ffd882f8b9a77c03dea543f35b218ad192b8f9670	1785503690606
2	8d3f30d330a22a65e287f71fc4bf5f48d4e3481ad6013194b8215c0e57dd60eb	1785507089728
3	919910ee7ba8d72ee0326edee47ae03a688a714552833f1babb826d47e5eb191	1785529862978
4	18c64f048e1d9e7f03df5bb3b4c729cb4716b38e41006c09c835793610664b81	1785531683188
5	4035aa1070a6b364a12435cd5163c090b81efbfbeb148d431a86207585fe8fb8	1785535082248
6	643d6f6a978cd98cddd7949de6970cf04adfc5dfbef4a2cdc659b16a68debd40	1785538907184
7	ce8250fb6373a9e24ae424a6fa18f16271da17336a23f08bdf10ffd4ab144735	1785541571390
8	9e02301fddb1dfed93e293a98e80c242179814e2096e12ac91f8baffb2ed3754	1785541597691
9	0c1f60acf5839e3d1faf821e711906872bfb1d4f4aeb1288155055abe472772f	1785589940559
\.


--
-- Data for Name: sucursales; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sucursales (id, nombre, tipo) FROM stdin;
1	Distribuidora	distribuidora
2	Express 1	express
3	Express 2	express
4	Express 3	express
\.


--
-- Data for Name: usuarios; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.usuarios (id, nombre, rol) FROM stdin;
1	Ana (Admin)	admin
2	Bruno (Fraccionador)	fraccionador
3	Carla (Vendedora)	vendedor
\.


--
-- Data for Name: caja_sesiones; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.caja_sesiones (id, sucursal_id, usuario_id, apertura, monto_inicial, cierre, declarado_efectivo, sistema_efectivo, diferencia, totales, estado, observaciones) FROM stdin;
1	1	1	2026-08-01 10:48:47.992069-03	35000	\N	0	0	0	{}	abierta	
\.


--
-- Data for Name: caja_movimientos; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.caja_movimientos (id, caja_sesion_id, fecha, tipo, motivo, importe, usuario_id) FROM stdin;
\.


--
-- Data for Name: clientes; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.clientes (id, nombre, nombre_fantasia, tipo_doc, numero_doc, condicion_iva, direccion, localidad, telefono, email, lista_precio, descuento, vendedor_id, sucursal_id, cta_cte_habilitada, limite_credito, dias_plazo, observaciones, activo, es_consumidor_final, created_at) FROM stdin;
1	Consumidor Final		sin_identificar		consumidor_final						0	\N	\N	f	0	0		t	t	2026-08-01 10:22:08.796942-03
2	Kiosco La Esquina	La Esquina	cuit	30712345678	responsable_inscripto	San Martín 450	Pilar	11-4300-1122	compras@laesquina.com	Mayorista	5	3	1	t	150000	30		t	f	2026-08-01 10:22:08.799006-03
3	Dietética Vida Sana		cuit	30709988771	monotributo	Rivadavia 1200	Escobar	348-442-7788		Mayorista	0	3	1	t	80000	15		t	f	2026-08-01 10:22:08.800041-03
4	Pérez, Marcela		dni	28444555	consumidor_final		Pilar	11-6000-4455			0	\N	2	f	0	0		t	f	2026-08-01 10:22:08.801218-03
\.


--
-- Data for Name: cobranzas; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cobranzas (id, punto_venta, numero, fecha, cliente_id, sucursal_id, usuario_id, total, a_cuenta, estado, observaciones, caja_sesion_id) FROM stdin;
1	0001	1	2026-08-01 10:22:08.87-03	2	1	1	10000	0	confirmada	Pago parcial a cuenta del pedido semanal	\N
\.


--
-- Data for Name: ventas; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ventas (id, tipo, punto_venta, numero, fecha, cliente_id, sucursal_id, usuario_id, estado, condicion_pago, vencimiento_pago, lista_precio, subtotal_neto, descuento_total, iva_total, total, cae, cae_vencimiento, ref_venta_id, observaciones, caja_sesion_id) FROM stdin;
1	ticket	0001	1	2026-08-01 10:22:08.802-03	2	1	3	confirmada	cuenta_corriente	2026-08-31 10:22:08.802-03	Mayorista	24660	540	5178.6	29838.6		\N	\N	Pedido semanal	\N
2	ticket	0001	2	2026-08-01 10:22:08.85-03	3	1	3	confirmada	cuenta_corriente	2026-08-16 10:22:08.85-03	Mayorista	7200	0	1512	8712		\N	\N		\N
4	ticket	0001	\N	2026-08-01 10:48:50.093-03	1	1	1	borrador	contado	\N	Minorista	0	0	0	0		\N	\N		\N
3	ticket	0001	\N	2026-08-01 10:30:07.728-03	1	1	1	borrador	contado	\N	Minorista	4270.18	0	646.83	4917.01		\N	\N		\N
\.


--
-- Data for Name: cobranza_imputaciones; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cobranza_imputaciones (id, cobranza_id, venta_id, importe) FROM stdin;
1	1	1	10000
\.


--
-- Data for Name: cobranza_pagos; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cobranza_pagos (id, cobranza_id, medio, importe, referencia) FROM stdin;
1	1	transferencia	10000	CBU 0070…
\.


--
-- Data for Name: proveedores; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.proveedores (id, nombre, cuit, direccion, telefono, email, condicion_iva) FROM stdin;
1	Molino Sur	30-71234567-9	Ruta 8 km 45, Pilar	11-4000-0001	ventas@molinosur.com	responsable_inscripto
2	Legumbres del Norte	30-70011223-4	Av. Belgrano 250, Salta	387-500-1122		responsable_inscripto
3	Avena Pampa	30-69988776-1	Parque Ind. Santa Rosa	2954-40-3300		responsable_inscripto
4	Galletera Rosario	30-71120034-7	Bv. Oroño 1200, Rosario	341-455-8899		responsable_inscripto
5	Bebidas SA	30-70567890-2	Panamericana km 32	11-4700-2200		responsable_inscripto
6	Yerbatera Misiones	30-71005566-8	RN 12, Apóstoles	3764-42-7788		responsable_inscripto
\.


--
-- Data for Name: comprobantes; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.comprobantes (id, tipo, letra, punto_venta, numero, fecha, proveedor_id, sucursal_id, estado, condicion_pago, vencimiento_pago, recepcion, subtotal_neto, iva_total, total, ref_comprobante_id, observaciones, usuario_id, fecha_carga) FROM stdin;
1	factura	A	0001	1024	2026-08-01 10:22:08.790573-03	1	1	confirmado	cuenta_corriente	\N	f	36575	3840.375	40415.375	\N	Factura de la compra inicial de harina	1	2026-08-01 10:22:08.790573-03
\.


--
-- Data for Name: productos; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.productos (id, nombre, marca, categoria, iva, tipo, stock_min, proveedor_activo_id, codigo_barras) FROM stdin;
1	Harina Integral	Molienda del Sur	Alimentos	10.5	granel	0	1	7791234000015
2	Lentejas	Del Norte	Alimentos	10.5	granel	0	2	7791234000022
3	Avena	Pampa	Alimentos	10.5	granel	0	3	7791234000039
4	Galletitas Integrales	Rosario	Alimentos	21	entero	0	4	7791234000046
5	Gaseosa Cola 2,25L	ColaCo	Bebidas	21	entero	0	5	7791234000053
6	Yerba Orgánica 1kg	Selva	Alimentos	21	entero	0	6	7791234000060
\.


--
-- Data for Name: presentaciones; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.presentaciones (id, producto_id, tam_kg, codigo_barras, recargo) FROM stdin;
1	1	1	7791234100012	8
2	1	0.5	7791234100029	15
3	1	0.25	7791234100036	25
4	2	1	7791234100043	8
5	2	0.5		15
6	3	1	7791234100050	8
7	3	0.5		15
\.


--
-- Data for Name: comprobante_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.comprobante_items (id, comprobante_id, producto_id, presentacion_id, cantidad, costo_unitario, descuento, iva, subtotal) FROM stdin;
1	1	1	\N	55	700	5	10.5	36575
\.


--
-- Data for Name: configuracion; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.configuracion (id, clave, valor, updated_at) FROM stdin;
1	ventas	{"mediosPago": ["efectivo", "transferencia", "tarjeta_debito", "tarjeta_credito", "qr"], "puntoVenta": "0001", "balanzaModo": "peso", "listasPrecio": ["Minorista", "Mayorista", "Oferta"], "arcaHabilitado": false, "balanzaPrefijo": "20", "redondeoPrecio": 1, "cajaObligatoria": true, "ctaCteDiasPlazo": 30, "ctaCteHabilitada": true, "lectorHabilitado": true, "redondeoEfectivo": 0, "balanzaHabilitada": false, "lectorSufijoEnter": true, "comprobanteDefault": "ticket", "listaPrecioDefault": "Minorista", "condicionIvaEmpresa": "responsable_inscripto", "ctaCteLimiteDefault": 0, "descuentoMaxVendedor": 10, "permitirStockNegativo": false, "ctaCteBloquearSuperado": true, "presupuestoValidezDias": 15, "presupuestoReservaStock": false}	2026-08-01 10:13:05.927-03
\.


--
-- Data for Name: incidencias; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.incidencias (id, codigo, fecha, tipo, estado, responsable_id, motivo, producto_id, sucursal_id, presentacion_id, cantidad, unidad, resolucion, fecha_resolucion, activa) FROM stdin;
1	INC0001	2026-08-01 10:22:08.783701-03	Bolsa rota	pendiente	2	Bolsa dañada en depósito	3	1	\N	2	kg	\N	\N	t
\.


--
-- Data for Name: listas_precio; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.listas_precio (id, producto_id, nombre, ganancia) FROM stdin;
1	1	Minorista	65
2	1	Mayorista	30
3	1	Oferta	12
4	2	Minorista	55
5	2	Mayorista	25
6	4	Minorista	50
7	4	Oferta	20
\.


--
-- Data for Name: movimientos; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.movimientos (id, fecha, tipo, producto_id, sucursal_id, presentacion_id, signo, cantidad, unidad, motivo, pres_label, estado_desde, estado_hacia, sucursal_destino_id, vencimiento, proveedor_nombre, usuario_id, ref_transferencia_id, ref_incidencia_id, descripcion) FROM stdin;
1	2026-08-01 10:22:08.654616-03	compra	1	1	\N	1	55	kg	Prov: Molino Sur		\N	disponible	\N	\N	Molino Sur	1	\N	\N	Compra +55 kg · Molino Sur
2	2026-08-01 10:22:08.664162-03	compra	2	1	\N	1	20	kg	Prov: Legumbres del Norte		\N	disponible	\N	\N	Legumbres del Norte	1	\N	\N	Compra +20 kg · Legumbres del Norte
3	2026-08-01 10:22:08.669373-03	compra	3	1	\N	1	15	kg	Prov: Avena Pampa		\N	disponible	\N	\N	Avena Pampa	1	\N	\N	Compra +15 kg · Avena Pampa
4	2026-08-01 10:22:08.674933-03	compra	4	1	\N	1	60	u	Prov: Galletera Rosario		\N	disponible	\N	\N	Galletera Rosario	1	\N	\N	Compra +60 u. · Galletera Rosario
5	2026-08-01 10:22:08.680313-03	compra	5	1	\N	1	48	u	Prov: Bebidas SA		\N	disponible	\N	\N	Bebidas SA	1	\N	\N	Compra +48 u. · Bebidas SA
6	2026-08-01 10:22:08.685066-03	compra	6	1	\N	1	40	u	Prov: Yerbatera Misiones		\N	disponible	\N	\N	Yerbatera Misiones	1	\N	\N	Compra +40 u. · Yerbatera Misiones
7	2026-08-01 10:22:08.690086-03	fraccionamiento	1	1	\N	0	10	kg		Granel → paquetes	\N	\N	\N	\N		2	\N	\N	Fraccionó 10 kg en 5×1 kg, 10×500 g
8	2026-08-01 10:22:08.697844-03	transferencia	1	1	1	0	3	u			disponible	comprometido	2	\N		1	1	\N	TR0001: reserva 3 paq. para Express 1
9	2026-08-01 10:22:08.697844-03	transferencia	4	1	\N	0	12	u			disponible	comprometido	2	\N		1	1	\N	TR0001: reserva 12 u. para Express 1
10	2026-08-01 10:22:08.715218-03	transferencia	1	1	1	-1	3	u			comprometido	\N	2	\N		\N	1	\N	TR0001: salida de Distribuidora
11	2026-08-01 10:22:08.715218-03	transferencia	4	1	\N	-1	12	u			comprometido	\N	2	\N		\N	1	\N	TR0001: salida de Distribuidora
12	2026-08-01 10:22:08.723397-03	transferencia	1	2	1	1	3	u			\N	disponible	\N	\N		\N	1	\N	TR0001: recepción en Express 1
13	2026-08-01 10:22:08.723397-03	transferencia	4	2	\N	1	12	u			\N	disponible	\N	\N		\N	1	\N	TR0001: recepción en Express 1
14	2026-08-01 10:22:08.732235-03	transferencia	3	1	\N	0	5	kg			disponible	comprometido	3	\N		1	2	\N	TR0002: reserva 5 kg para Express 2
15	2026-08-01 10:22:08.73887-03	venta_granel	1	1	\N	-1	2.5	kg			disponible	\N	\N	\N		3	\N	\N	Venta suelta 2.5 kg · $2825.80
16	2026-08-01 10:22:08.773645-03	venta_fraccionada	1	2	1	-1	1	u			disponible	\N	\N	\N		3	\N	\N	Venta 1 paq. · $1220.81
17	2026-08-01 10:22:08.778396-03	venta_fraccionada	4	2	\N	-1	5	u			disponible	\N	\N	\N		3	\N	\N	Venta 5 u. · $9450.40
18	2026-08-01 10:22:08.783701-03	ajuste	3	1	\N	0	2	kg			disponible	comprometido	\N	\N		2	\N	1	INC0001 (Bolsa rota): 2 kg a comprometido
19	2026-08-01 10:22:08.810314-03	venta_fraccionada	4	1	\N	-1	12	u			disponible	\N	\N	\N		3	\N	\N	Venta 0001-00000001 · Kiosco La Esquina
20	2026-08-01 10:22:08.810314-03	venta_fraccionada	6	1	\N	-1	6	u			disponible	\N	\N	\N		3	\N	\N	Venta 0001-00000001 · Kiosco La Esquina
21	2026-08-01 10:22:08.856411-03	venta_granel	3	1	\N	-1	4	kg			disponible	\N	\N	\N		3	\N	\N	Venta 0001-00000002 · Dietética Vida Sana
\.


--
-- Data for Name: producto_proveedores; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.producto_proveedores (id, producto_id, proveedor_id, costo, descuento, flete) FROM stdin;
2	1	2	760	0	2
3	2	2	1300	8	4
4	4	4	1200	0	5
5	3	3	0	0	0
6	5	5	0	0	0
7	6	6	0	0	0
1	1	1	700	0	3
\.


--
-- Data for Name: producto_proveedor_costos; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.producto_proveedor_costos (id, producto_proveedor_id, fecha, costo_anterior, descuento_anterior, flete_anterior, costo, descuento, flete, origen, motivo, lote, usuario_id, comprobante_id, activo_anterior, activo_nuevo) FROM stdin;
1	1	2026-08-01 10:27:33.91339-03	700	5	3	700	0	3	masiva	Actualización de costos · Molino Sur	Lmsaeowm4ca1i4	1	\N	\N	\N
\.


--
-- Data for Name: stock; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stock (id, producto_id, sucursal_id, presentacion_id, estado, cantidad) FROM stdin;
2	2	1	\N	disponible	20
5	5	1	\N	disponible	48
8	1	1	2	disponible	10
7	1	1	1	disponible	2
9	1	1	1	comprometido	0
10	4	1	\N	comprometido	0
1	1	1	\N	disponible	42.5
11	1	2	1	disponible	2
12	4	2	\N	disponible	7
13	3	1	\N	comprometido	7
4	4	1	\N	disponible	36
6	6	1	\N	disponible	34
3	3	1	\N	disponible	4
\.


--
-- Data for Name: transferencias; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.transferencias (id, codigo, fecha, origen_id, destino_id, usuario_id, estado) FROM stdin;
1	TR0001	2026-08-01 10:22:08.697844-03	1	2	1	recibida
2	TR0002	2026-08-01 10:22:08.732235-03	1	3	1	pendiente
\.


--
-- Data for Name: transferencia_hist; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.transferencia_hist (id, transferencia_id, estado, fecha, usuario_id) FROM stdin;
1	1	pendiente	2026-08-01 10:22:08.697844-03	1
2	1	preparada	2026-08-01 10:22:08.712152-03	\N
3	1	transito	2026-08-01 10:22:08.715218-03	\N
4	1	recibida	2026-08-01 10:22:08.723397-03	\N
5	2	pendiente	2026-08-01 10:22:08.732235-03	1
\.


--
-- Data for Name: transferencia_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.transferencia_items (id, transferencia_id, producto_id, presentacion_id, cantidad) FROM stdin;
1	1	1	1	3
2	1	4	\N	12
3	2	3	\N	5
\.


--
-- Data for Name: venta_extras; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.venta_extras (id, venta_id, concepto, importe, iva) FROM stdin;
\.


--
-- Data for Name: venta_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.venta_items (id, venta_id, producto_id, presentacion_id, cantidad, precio_lista, descuento, precio_unitario, iva, subtotal, ref_item_id) FROM stdin;
1	1	4	\N	12	900	5	900	21	10260	\N
2	1	6	\N	6	2400	0	2400	21	14400	\N
3	2	3	\N	4	1800	0	1800	21	7200	\N
14	3	1	\N	2	1190.05	0	1190.05	10.5	2380.1	\N
15	3	4	\N	1	1890.08	0	1890.08	21	1890.08	\N
\.


--
-- Data for Name: venta_pagos; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.venta_pagos (id, venta_id, medio, importe, referencia) FROM stdin;
\.


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE SET; Schema: drizzle; Owner: -
--

SELECT pg_catalog.setval('drizzle.__drizzle_migrations_id_seq', 9, true);


--
-- Name: caja_movimientos_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.caja_movimientos_id_seq', 1, false);


--
-- Name: caja_sesiones_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.caja_sesiones_id_seq', 1, true);


--
-- Name: clientes_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.clientes_id_seq', 4, true);


--
-- Name: cobranza_imputaciones_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.cobranza_imputaciones_id_seq', 1, true);


--
-- Name: cobranza_pagos_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.cobranza_pagos_id_seq', 1, true);


--
-- Name: cobranzas_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.cobranzas_id_seq', 1, true);


--
-- Name: comprobante_items_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.comprobante_items_id_seq', 1, true);


--
-- Name: comprobantes_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.comprobantes_id_seq', 1, true);


--
-- Name: configuracion_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.configuracion_id_seq', 5, true);


--
-- Name: incidencias_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.incidencias_id_seq', 1, true);


--
-- Name: listas_precio_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.listas_precio_id_seq', 7, true);


--
-- Name: movimientos_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.movimientos_id_seq', 21, true);


--
-- Name: presentaciones_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.presentaciones_id_seq', 7, true);


--
-- Name: producto_proveedor_costos_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.producto_proveedor_costos_id_seq', 1, true);


--
-- Name: producto_proveedores_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.producto_proveedores_id_seq', 7, true);


--
-- Name: productos_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.productos_id_seq', 6, true);


--
-- Name: proveedores_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.proveedores_id_seq', 6, true);


--
-- Name: stock_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.stock_id_seq', 13, true);


--
-- Name: sucursales_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.sucursales_id_seq', 4, true);


--
-- Name: transferencia_hist_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.transferencia_hist_id_seq', 5, true);


--
-- Name: transferencia_items_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.transferencia_items_id_seq', 3, true);


--
-- Name: transferencias_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.transferencias_id_seq', 2, true);


--
-- Name: usuarios_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.usuarios_id_seq', 3, true);


--
-- Name: venta_extras_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.venta_extras_id_seq', 1, false);


--
-- Name: venta_items_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.venta_items_id_seq', 15, true);


--
-- Name: venta_pagos_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.venta_pagos_id_seq', 1, false);


--
-- Name: ventas_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.ventas_id_seq', 4, true);


--
-- PostgreSQL database dump complete
--

\unrestrict JhofMXepQj3uHf6yN7lt8vehceFFnQSBPLl0DP1epB0fd0iP0FUKfAfsgcWi7em

