-- EL PIE DE LA FACTURA DE GASTO: lo que suma abajo del IVA.
--
-- `gastos.otros` ya existía como UNA bolsa ("percepciones, impuestos internos y
-- todo lo que suma sin ser IVA"), y con el formulario de renglones (0067) ni
-- siquiera se podía cargar: quedaba clavada en 0. Pero una bolsa no sirve para
-- lo único que estos importes tienen que hacer después — cada uno se computa
-- contra un impuesto distinto: la percepción de D.G.R. (Ingresos Brutos
-- provincial) va contra IIBB, la de D.G.I. contra el impuesto nacional, y los
-- impuestos internos no se recuperan: son costo.
--
-- Se abren en tres columnas y `otros` queda como su TOTAL, así todo lo que ya
-- lee `otros` (resumen, totales, listados) sigue andando sin enterarse.
ALTER TABLE "gastos" ADD COLUMN "imp_internos" double precision DEFAULT 0 NOT NULL;
ALTER TABLE "gastos" ADD COLUMN "perc_dgi" double precision DEFAULT 0 NOT NULL;
ALTER TABLE "gastos" ADD COLUMN "perc_dgr" double precision DEFAULT 0 NOT NULL;
