-- La venta recuerda de qué presupuesto nació. Sin FK dura: el vínculo fuerte
-- vive en presupuestos.venta_id; acá es lineage para reportes.
ALTER TABLE "ventas" ADD COLUMN "presupuesto_id" integer;
