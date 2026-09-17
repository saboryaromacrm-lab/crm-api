-- VERSIONES DEL INVENTARIO — para que el servidor pueda decir "no cambió nada".
--
-- El snapshot del inventario (lo que bajan Compras y Almacén) se parte en tres
-- partes con tres velocidades de cambio: `base` (sucursales, usuarios, listas,
-- avisos), `catalogo` (los productos con sus precios: 8 MB) y `stock` (las
-- existencias: 3 MB, cambia con cada venta). Cada parte lleva una VERSIÓN, y el
-- CRM manda la que tiene: si coincide, el servidor contesta 304 sin tocar una
-- sola tabla pesada y el navegador reutiliza lo que ya bajó.
--
-- LA VERSIÓN LA LLEVA LA BASE, NO EL CÓDIGO. Un trigger por tabla avanza la
-- secuencia de la parte que alimenta, en cada INSERT/UPDATE/DELETE/TRUNCATE.
-- Así ningún camino de escritura —de hoy o del que se agregue el mes que
-- viene— puede olvidarse de avisar, que es la única forma en que un 304 podría
-- mentir. Es el mismo principio de `despertarArchivado` en `addDelta`: lo que
-- no puede fallar va donde nada lo puede esquivar.
--
-- SON SECUENCIAS Y NO UNA FILA CONTADORA, a propósito: `nextval()` no toma
-- candado de fila y no espera a nadie. Con una fila contadora, cada venta que
-- toca stock quedaría en cola detrás de la anterior por el candado de esa fila,
-- que es exactamente el tipo de traba que este trabajo vino a sacar. La
-- secuencia avanza aunque la transacción se deshaga: eso sobre-invalida (un
-- 200 de más), nunca sub-invalida (un 304 mentiroso).
--
-- Los triggers son POR SENTENCIA, no por fila: una venta de 15 renglones avanza
-- la secuencia 15 veces, no 15×N. Y cubren TRUNCATE porque la limpieza de fin
-- de práctica vacía tablas enteras con TRUNCATE, que no dispara los otros.
CREATE SEQUENCE IF NOT EXISTS "ver_base";
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "ver_catalogo";
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "ver_stock";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION marcar_cambio() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY TG_ARGV LOOP
    PERFORM nextval(s);
  END LOOP;
  RETURN NULL;
END
$$;
--> statement-breakpoint
-- stock: lo que cambia con cada venta, fraccionamiento y remito.
DROP TRIGGER IF EXISTS tg_ver_stock ON "stock";
--> statement-breakpoint
CREATE TRIGGER tg_ver_stock AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "stock" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_stock');
--> statement-breakpoint
-- catalogo: el producto y todo lo que hace a su precio.
DROP TRIGGER IF EXISTS tg_ver_productos ON "productos";
--> statement-breakpoint
CREATE TRIGGER tg_ver_productos AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "productos" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_catalogo');
--> statement-breakpoint
DROP TRIGGER IF EXISTS tg_ver_presentaciones ON "presentaciones";
--> statement-breakpoint
CREATE TRIGGER tg_ver_presentaciones AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "presentaciones" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_catalogo');
--> statement-breakpoint
DROP TRIGGER IF EXISTS tg_ver_producto_listas ON "producto_listas";
--> statement-breakpoint
CREATE TRIGGER tg_ver_producto_listas AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "producto_listas" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_catalogo');
--> statement-breakpoint
DROP TRIGGER IF EXISTS tg_ver_producto_proveedores ON "producto_proveedores";
--> statement-breakpoint
CREATE TRIGGER tg_ver_producto_proveedores AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "producto_proveedores" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_catalogo');
--> statement-breakpoint
DROP TRIGGER IF EXISTS tg_ver_producto_etiquetas ON "producto_etiquetas";
--> statement-breakpoint
CREATE TRIGGER tg_ver_producto_etiquetas AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "producto_etiquetas" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_catalogo');
--> statement-breakpoint
-- catalogo Y base: los nombres viajan adentro de cada producto, y el catálogo
-- entero viaja en la base. Las listas y la configuración deciden el precio.
DROP TRIGGER IF EXISTS tg_ver_marcas ON "marcas";
--> statement-breakpoint
CREATE TRIGGER tg_ver_marcas AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "marcas" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_catalogo', 'ver_base');
--> statement-breakpoint
DROP TRIGGER IF EXISTS tg_ver_categorias ON "categorias";
--> statement-breakpoint
CREATE TRIGGER tg_ver_categorias AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "categorias" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_catalogo', 'ver_base');
--> statement-breakpoint
DROP TRIGGER IF EXISTS tg_ver_subcategorias ON "subcategorias";
--> statement-breakpoint
CREATE TRIGGER tg_ver_subcategorias AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "subcategorias" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_catalogo', 'ver_base');
--> statement-breakpoint
DROP TRIGGER IF EXISTS tg_ver_etiquetas ON "etiquetas";
--> statement-breakpoint
CREATE TRIGGER tg_ver_etiquetas AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "etiquetas" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_catalogo', 'ver_base');
--> statement-breakpoint
DROP TRIGGER IF EXISTS tg_ver_listas_venta ON "listas_venta";
--> statement-breakpoint
CREATE TRIGGER tg_ver_listas_venta AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "listas_venta" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_catalogo', 'ver_base');
--> statement-breakpoint
DROP TRIGGER IF EXISTS tg_ver_modalidades_venta ON "modalidades_venta";
--> statement-breakpoint
CREATE TRIGGER tg_ver_modalidades_venta AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "modalidades_venta" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_catalogo', 'ver_base');
--> statement-breakpoint
DROP TRIGGER IF EXISTS tg_ver_configuracion ON "configuracion";
--> statement-breakpoint
CREATE TRIGGER tg_ver_configuracion AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "configuracion" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_catalogo', 'ver_base');
--> statement-breakpoint
-- base: lo demás que viaja en el snapshot.
DROP TRIGGER IF EXISTS tg_ver_reglas_marca ON "reglas_marca";
--> statement-breakpoint
CREATE TRIGGER tg_ver_reglas_marca AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "reglas_marca" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_base');
--> statement-breakpoint
DROP TRIGGER IF EXISTS tg_ver_sucursales ON "sucursales";
--> statement-breakpoint
CREATE TRIGGER tg_ver_sucursales AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "sucursales" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_base');
--> statement-breakpoint
DROP TRIGGER IF EXISTS tg_ver_proveedores ON "proveedores";
--> statement-breakpoint
CREATE TRIGGER tg_ver_proveedores AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "proveedores" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_base');
--> statement-breakpoint
DROP TRIGGER IF EXISTS tg_ver_usuarios ON "usuarios";
--> statement-breakpoint
CREATE TRIGGER tg_ver_usuarios AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "usuarios" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_base');
--> statement-breakpoint
DROP TRIGGER IF EXISTS tg_ver_roles ON "roles";
--> statement-breakpoint
CREATE TRIGGER tg_ver_roles AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "roles" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_base');
--> statement-breakpoint
DROP TRIGGER IF EXISTS tg_ver_transferencias ON "transferencias";
--> statement-breakpoint
CREATE TRIGGER tg_ver_transferencias AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "transferencias" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_base');
--> statement-breakpoint
DROP TRIGGER IF EXISTS tg_ver_transferencia_items ON "transferencia_items";
--> statement-breakpoint
CREATE TRIGGER tg_ver_transferencia_items AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "transferencia_items" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_base');
--> statement-breakpoint
DROP TRIGGER IF EXISTS tg_ver_transferencia_hist ON "transferencia_hist";
--> statement-breakpoint
CREATE TRIGGER tg_ver_transferencia_hist AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "transferencia_hist" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_base');
--> statement-breakpoint
DROP TRIGGER IF EXISTS tg_ver_incidencias ON "incidencias";
--> statement-breakpoint
CREATE TRIGGER tg_ver_incidencias AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "incidencias" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_base');
--> statement-breakpoint
DROP TRIGGER IF EXISTS tg_ver_factura_lecturas ON "factura_lecturas";
--> statement-breakpoint
CREATE TRIGGER tg_ver_factura_lecturas AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "factura_lecturas" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_base');
--> statement-breakpoint
DROP TRIGGER IF EXISTS tg_ver_pedidos_cafeteria ON "pedidos_cafeteria";
--> statement-breakpoint
CREATE TRIGGER tg_ver_pedidos_cafeteria AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "pedidos_cafeteria" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_base');
--> statement-breakpoint
DROP TRIGGER IF EXISTS tg_ver_vencimientos ON "vencimientos";
--> statement-breakpoint
CREATE TRIGGER tg_ver_vencimientos AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "vencimientos" FOR EACH STATEMENT EXECUTE FUNCTION marcar_cambio('ver_base');
