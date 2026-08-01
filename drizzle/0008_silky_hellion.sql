ALTER TABLE "producto_proveedor_costos" ADD COLUMN "activo_anterior" integer;--> statement-breakpoint
ALTER TABLE "producto_proveedor_costos" ADD COLUMN "activo_nuevo" integer;--> statement-breakpoint
ALTER TABLE "proveedores" ADD COLUMN "condicion_iva" "condicion_iva" DEFAULT 'responsable_inscripto' NOT NULL;