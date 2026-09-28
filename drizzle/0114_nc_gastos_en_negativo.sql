-- ===========================================================================
-- 0114 · LA NOTA DE CRÉDITO DE UN GASTO VA EN NEGATIVO (27/9/2026)
-- ===========================================================================
-- Se guardaba con importe positivo y todo la leía como un gasto más: el
-- resumen del mes subía en vez de bajar y la NC aparecía en Cuentas a pagar
-- como deuda. Desde ahora la API la guarda en negativo y "pagada" (no hay nada
-- que pagarle), así resta en todas las sumas que ya existen.
--
-- Acá se dan vuelta las que ya están cargadas. Solo las que NO tienen pagos
-- aplicados: si alguien "pagó" una NC, eso hay que mirarlo a mano y no se
-- toca a ciegas.
-- ===========================================================================

UPDATE "gastos" SET
  "neto" = -"neto",
  "iva" = -"iva",
  "otros" = -"otros",
  "imp_internos" = -"imp_internos",
  "perc_dgi" = -"perc_dgi",
  "perc_dgr" = -"perc_dgr",
  "total" = -"total",
  "estado" = (CASE WHEN "estado" = 'anulado' THEN 'anulado' ELSE 'pagado' END)::estado_gasto
WHERE "tipo_doc" = 'nota_credito' AND "total" > 0 AND "pagado" = 0;
