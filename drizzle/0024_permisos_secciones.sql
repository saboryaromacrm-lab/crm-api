-- Permisos por sección: cada rol pasa a declarar QUÉ PANTALLAS ve
-- (claves `modulo.seccion`) además de qué acciones puede hacer.
-- Un módulo sin secciones asignadas desaparece entero del menú.
-- El superadmin sigue con '*'. Los tres roles de sistema se migran a su
-- equivalente exacto de lo que ya venían haciendo.

UPDATE "roles" SET "permisos" = '[
  "dashboard", "manual",
  "compras.dashboard", "compras.productos", "compras.catalogos", "compras.proveedores", "compras.facturacion", "compras.historial",
  "ventas.pos", "ventas.presupuestos", "ventas.clientes", "ventas.cobranzas", "ventas.caja", "ventas.listas", "ventas.ofertas", "ventas.cambios", "ventas.configuracion",
  "almacen.existencias", "almacen.fraccionamiento", "almacen.transferencias", "almacen.operaciones", "almacen.incidencias",
  "gerencia.reportes", "gerencia.rentabilidad", "gerencia.valorizacion", "gerencia.auditoria", "gerencia.configuracion",
  "sistema.empresa", "sistema.impresion", "sistema.respaldos",
  "facturas", "precios", "etiquetas",
  "ventas", "presupuestos", "devoluciones", "diferencias", "ofertas",
  "pedidos", "preparar", "fraccionar", "inventario", "merma", "defectuoso", "incidencia_crear"
]'::jsonb WHERE "clave" = 'admin';
--> statement-breakpoint
UPDATE "roles" SET "permisos" = '[
  "dashboard", "manual",
  "ventas.pos", "ventas.clientes", "ventas.caja",
  "almacen.transferencias", "almacen.incidencias",
  "ventas", "devoluciones", "diferencias", "incidencia_crear", "pedidos"
]'::jsonb WHERE "clave" = 'cajero';
--> statement-breakpoint
UPDATE "roles" SET "permisos" = '[
  "manual",
  "almacen.fraccionamiento", "almacen.transferencias",
  "fraccionar"
]'::jsonb WHERE "clave" = 'fraccionador';
