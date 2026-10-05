-- ===========================================================================
-- 0137 · MOVIMIENTOS DE CAJA DESPUÉS DEL CIERRE (5/10/2026, pedido del dueño)
-- ===========================================================================
-- A veces el cajero se olvida de asentar un egreso o un ingreso y avisa
-- después del cierre. El SUPERADMIN lo asienta en ese turno cerrado: queda
-- marcado como posterior, con quién y cuándo, y el cierre (efectivo esperado y
-- diferencia) se recalcula. Si se cargó mal, se ANULA con motivo (no se borra):
-- queda tachado a la vista y deja de sumar.
ALTER TABLE "caja_movimientos" ADD COLUMN IF NOT EXISTS "posterior" boolean NOT NULL DEFAULT false;
ALTER TABLE "caja_movimientos" ADD COLUMN IF NOT EXISTS "anulado_en" timestamp with time zone;
ALTER TABLE "caja_movimientos" ADD COLUMN IF NOT EXISTS "anulado_por" integer REFERENCES "usuarios"("id") ON DELETE SET NULL;
ALTER TABLE "caja_movimientos" ADD COLUMN IF NOT EXISTS "anulado_motivo" text NOT NULL DEFAULT '';
