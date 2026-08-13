-- 0062 · HAY UNA SOLA DISTRIBUIDORA, Y AHORA LO GARANTIZA LA BASE
--
-- `distribuidoraId()` toma la PRIMERA sucursal con `tipo = 'distribuidora'`, y
-- ese id es el destino por defecto de toda compra que llega sin sucursal y el
-- origen de todo envío a la Cafetería. O sea que el `tipo` no es una etiqueta
-- de pantalla: es una decisión de ruteo del stock.
--
-- Con dos filas marcadas así, "la primera" pasa a depender del orden de los ids
-- y la mercadería empieza a entrar o salir del depósito equivocado **sin que
-- nada avise** — el frontend tampoco lo nota, porque usa el mismo criterio para
-- el valor por defecto. El permiso que se le puso al `PATCH` cierra quién puede
-- provocarlo; este índice cierra que pueda pasar.
--
-- Parcial (`where tipo = 'distribuidora'`) para no tocar a las express, que son
-- todas las que hagan falta.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sucursal_distribuidora"
  ON "sucursales" ("tipo")
  WHERE "tipo" = 'distribuidora';
