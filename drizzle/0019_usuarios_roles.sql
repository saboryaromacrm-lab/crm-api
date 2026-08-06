-- Usuarios y roles dinámicos: el rol deja de ser un enum y pasa a ser una fila
-- con su lista de permisos configurable desde Gerencia. Nace el superadmin
-- (Lucas), que es quien crea roles, permisos y usuarios.
CREATE TABLE "roles" (
  "id" serial PRIMARY KEY NOT NULL,
  "clave" text NOT NULL UNIQUE,
  "nombre" text NOT NULL,
  "descripcion" text NOT NULL DEFAULT '',
  "permisos" jsonb NOT NULL DEFAULT '[]',
  "es_sistema" boolean NOT NULL DEFAULT false
);--> statement-breakpoint
INSERT INTO "roles" ("clave", "nombre", "descripcion", "permisos", "es_sistema") VALUES
  ('superadmin', 'Superadmin', 'Maneja todo el sistema: crea roles, permisos y usuarios.', '["*"]', true),
  ('admin', 'Administrador', 'Cargas de facturas, controles de inventario y almacenes.', '["ventas","devoluciones","diferencias","precios","ofertas","facturas","inventario","merma","defectuoso","incidencia_crear","etiquetas","pedidos","preparar","fraccionar","config","ver"]', true),
  ('fraccionador', 'Fraccionador', 'Fracciona lo a granel y arma su lista en los envíos.', '["fraccionar","etiquetas","merma","defectuoso","incidencia_crear","ver"]', true),
  ('cajero', 'Cajero', 'Cobra en caja y hace pedidos de mercadería entre sucursales.', '["ventas","devoluciones","diferencias","incidencia_crear","pedidos","ver"]', true);--> statement-breakpoint
ALTER TABLE "usuarios" ADD COLUMN "rol_id" integer;--> statement-breakpoint
ALTER TABLE "usuarios" ADD COLUMN "password_hash" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "usuarios" ADD COLUMN "activo" boolean NOT NULL DEFAULT true;--> statement-breakpoint
-- Backfill del enum viejo: vendedor pasa a ser cajero.
UPDATE "usuarios" SET "rol_id" = (
  SELECT r."id" FROM "roles" r WHERE r."clave" = CASE "usuarios"."rol"::text
    WHEN 'admin' THEN 'admin'
    WHEN 'fraccionador' THEN 'fraccionador'
    ELSE 'cajero'
  END
);--> statement-breakpoint
ALTER TABLE "usuarios" ALTER COLUMN "rol_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_rol_id_roles_id_fk" FOREIGN KEY ("rol_id") REFERENCES "roles"("id") ON DELETE restrict;--> statement-breakpoint
-- Lucas, el superadmin, activo desde ya. Contraseña inicial: 1234 (cambiarla desde Gerencia).
INSERT INTO "usuarios" ("nombre", "rol_id", "password_hash", "activo")
SELECT 'Lucas', r."id", 's2:6d5e67b6f6b114f7cebf64b2087b415e:f0d67d23eff2b0534ecef5b2fb4542d62ddc247e179d4db1635ca4d7c676591940b04f96748067667890f133207f4075a302f0ce4e94e08fdf50c2a833786e3c', true
FROM "roles" r WHERE r."clave" = 'superadmin'
AND NOT EXISTS (SELECT 1 FROM "usuarios" u JOIN "roles" rr ON rr."id" = u."rol_id" WHERE rr."clave" = 'superadmin');--> statement-breakpoint
ALTER TABLE "usuarios" DROP COLUMN "rol";--> statement-breakpoint
DROP TYPE "rol";
