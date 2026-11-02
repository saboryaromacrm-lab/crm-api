-- 0211 · PAGO DE UN TERCERO A UNA CUENTA DISPONIBLE (2/11/2026, pedido del dueño: «que pueda hacerlo de
-- una cuenta de tercero, no una propia»). Igual que el pago propio (0151): no pasa por la caja, suma a
-- «Pagado» y baja la deuda con el proveedor; la diferencia es que la plata salió de la cuenta de otra
-- persona, cuyo nombre queda acá. Vacío = la transferencia salió de una cuenta de Sabor y Aroma.
ALTER TABLE "cuenta_disponible_pagos" ADD COLUMN IF NOT EXISTS "tercero" text NOT NULL DEFAULT '';
