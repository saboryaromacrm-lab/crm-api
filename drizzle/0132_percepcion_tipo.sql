-- ===========================================================================
-- 0132 · DE QUÉ IMPUESTO ES CADA PERCEPCIÓN (3/10/2026)
-- ===========================================================================
-- Pedido del dueño (Resultados IVA): separar las percepciones de IVA (pago a
-- cuenta del IVA, restan en la posición) de las de Ingresos Brutos. Hasta hoy
-- solo tenían un nombre libre. '' = sin marcar: se deduce del nombre («Perc.
-- IVA RG 5329» → iva, «Perc. IIBB Formosa» → iibb). Valores: iva | iibb | otro.
ALTER TABLE "proveedor_percepciones" ADD COLUMN IF NOT EXISTS "tipo" text NOT NULL DEFAULT '';
ALTER TABLE "comprobante_percepciones" ADD COLUMN IF NOT EXISTS "tipo" text NOT NULL DEFAULT '';
