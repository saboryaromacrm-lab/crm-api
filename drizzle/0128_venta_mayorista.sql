-- LA VENTA MAYORISTA, CONGELADA AL CONFIRMAR (1/10/2026).
-- Una factura con renglones a precio mayorista se cobra (a cuenta corriente)
-- solo con los medios del mayorista. La marca se escribe al confirmar y NO se
-- deduce después de la configuración de hoy: cambiar una lista de modalidad o
-- la configuración no puede cambiarle las reglas de cobro a una deuda vieja.
-- Las ventas anteriores quedan en false: se cobran como se cobraban.
ALTER TABLE "ventas" ADD COLUMN IF NOT EXISTS "mayorista" boolean DEFAULT false NOT NULL;
