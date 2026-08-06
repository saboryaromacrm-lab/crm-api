-- El presupuesto recuerda si SU confirmación reservó stock: así el cierre o la
-- cancelación liberan exactamente lo reservado, aunque la config haya cambiado.
ALTER TABLE "presupuestos" ADD COLUMN "reservado" boolean NOT NULL DEFAULT false;
