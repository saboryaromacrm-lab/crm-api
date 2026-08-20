-- ARCA · EL NÚMERO RESERVADO ANTES DE PEDIR EL CAE (0075)
-- ============================================================================
-- La pieza que evita facturas DUPLICADAS.
--
-- El caso: se manda FECAESolicitar, ARCA lo procesa y emite, y la respuesta se
-- pierde (timeout, corte de luz, el contenedor que se reinicia). Para nosotros
-- falló; para ARCA la factura existe. Sin este rastro, el reintento pediría el
-- número siguiente y emitiría una SEGUNDA factura de la misma venta — y una
-- factura con CAE no se borra: se corrige con nota de crédito.
--
-- Con el número guardado, antes de reintentar se pregunta a ARCA si ese número
-- ya salió (FECompConsultar). Si salió y los importes coinciden, se ADOPTA el
-- CAE en vez de emitir de nuevo.

ALTER TABLE "ventas" ADD COLUMN "facturar_cbte_nro" integer;
ALTER TABLE "ventas" ADD COLUMN "facturar_cbte_tipo" integer;
