-- 0210 · SESIÓN RECORDADA DEL SUPERADMIN (2/11/2026, pedido del dueño: «que me guarde mi inicio de
-- sesión cuando instalo la app, en el cel o en la PC, pero solo en mi usuario»). Cada sesión lleva
-- su propia ventana de inactividad: 12 h para todos (lo de siempre) y 30 días solo para el
-- superadmin que entra desde la app instalada en un equipo que NO es terminal de sucursal.
ALTER TABLE sesiones ADD COLUMN IF NOT EXISTS vida_horas integer NOT NULL DEFAULT 12;
