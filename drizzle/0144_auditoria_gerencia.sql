-- ===========================================================================
-- 0144 · GERENCIA › AUDITORÍA (8/10/2026, pedido del dueño)
-- ===========================================================================
-- 1. Gerencia se ordena: «Reportes de ventas», «Valorización de stock» y
--    «Configuración» nunca se construyeron porque Métricas, Almacén › Sin
--    movimiento y Sistema ya hacen ese trabajo. Sus llaves salen de los roles.
--    «Auditoría» se construye y queda SOLO para el superadmin (como Métricas y
--    Cash Flow): controla a todos, administradores incluidos.
-- 2. Auditoría lee lo que ya está firmado en cada tabla (anulaciones, notas de
--    crédito, precios y descuentos a mano, ajustes de stock, diferencias de
--    caja, cambios). Estos índices hacen que cada una de esas lecturas toque
--    solo lo del período: abrir la pantalla no frena a ninguna caja.
-- ===========================================================================
UPDATE "roles"
   SET "permisos" = (
     SELECT coalesce(jsonb_agg(p), '[]'::jsonb)
       FROM jsonb_array_elements("permisos") p
      WHERE p #>> '{}' NOT IN ('gerencia.reportes', 'gerencia.valorizacion', 'gerencia.configuracion', 'gerencia.auditoria'))
 WHERE "permisos" ?| array['gerencia.reportes', 'gerencia.valorizacion', 'gerencia.configuracion', 'gerencia.auditoria'];
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_ventas_anuladas" ON "ventas" ("anulado_en") WHERE "estado" = 'anulada';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_venta_items_a_mano" ON "venta_items" ("venta_id")
  WHERE "lista_origen" = 'manual' OR ("descuento" > 0 AND "descuento_id" IS NULL AND "oferta_descuento" = 0);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_mov_ajustes" ON "movimientos" ("fecha" DESC)
  WHERE "tipo" IN ('ajuste', 'merma', 'vencido', 'defectuoso') AND "signo" <> 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_auditoria_fecha" ON "auditoria" ("fecha" DESC);
