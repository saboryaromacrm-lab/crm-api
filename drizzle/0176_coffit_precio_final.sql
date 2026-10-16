-- ===========================================================================
-- 0176 · COFFIT PAGA PRECIO FINAL (16/10/2026)
-- ===========================================================================
-- Decisión del dueño: lo que se compra para Coffit, lo que se le manda desde
-- el stock y sus gastos se le cobran CON IVA y percepciones (el total del
-- papel), aunque el crédito fiscal siga siendo de Sabor y Aroma. Desde el
-- principio: lo que ya estaba en meses cerrados se sigue viendo como se firmó
-- y su diferencia —más la del stock que se le cobró al marcar artículos de uso
-- exclusivo— entra como UN ajuste en el mes abierto.
--
-- La regla vive en src/cafeteria/cuenta.ts (`finalCafeteria`,
-- `costoUltimaFactura`, `finalDelFormato`); acá se repite UNA vez para lo que
-- ya estaba cargado.
-- ===========================================================================

-- El precio final sobre el neto de un producto a una fecha: el de su última
-- factura hasta ese día (el renglón con su parte del IVA y de las percepciones
-- del papel); sin factura, el de su formato de compra (la parte facturada con
-- IVA, la parte sin factura sin IVA). Lo que elabora Coffit no lleva IVA.
CREATE FUNCTION pg_temp.coffit_factor_final(p_producto integer, p_hasta timestamptz) RETURNS double precision
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT (ci.subtotal
        + coalesce(c.iva_total * ci.subtotal * ci.iva / nullif(d.base_iva, 0), 0)
        + coalesce(c.percepciones_total * ci.subtotal / nullif(c.subtotal_neto, 0), 0)) / ci.subtotal
      FROM comprobante_items ci
        JOIN comprobantes c ON c.id = ci.comprobante_id
        CROSS JOIN LATERAL (SELECT sum(x.subtotal * x.iva) AS base_iva FROM comprobante_items x WHERE x.comprobante_id = c.id) d
      WHERE ci.producto_id = p_producto AND c.estado = 'confirmado' AND c.tipo IN ('factura', 'liquidacion')
        AND ci.cantidad > 0 AND ci.subtotal > 0 AND c.fecha <= p_hasta
      ORDER BY c.fecha DESC, c.id DESC, ci.id DESC LIMIT 1),
    (SELECT CASE WHEN p.origen_cafeteria THEN 1 ELSE
          (1 - least(greatest(pp.porc_sin_factura, 0), 100) / 100) * (1 + coalesce(p.iva, 0) / 100)
          + least(greatest(pp.porc_sin_factura, 0), 100) / 100 END
      FROM producto_proveedores pp JOIN productos p ON p.id = pp.producto_id
      WHERE pp.producto_id = p_producto
      ORDER BY pp.usar_para_precio DESC, pp.id LIMIT 1),
    1)
$$;
--> statement-breakpoint

-- 1 · Lo que Coffit paga de cada factura: su neto + el IVA de la factura en
--     proporción al IVA de sus renglones + las percepciones en proporción a su
--     neto. Si las marcas de los renglones no cierran con el neto congelado,
--     el IVA va en proporción al neto.
ALTER TABLE "comprobantes" ADD COLUMN IF NOT EXISTS "final_cafeteria" double precision NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE "comprobantes" c SET "final_cafeteria" = round((
    c.neto_cafeteria
    + coalesce(
        CASE WHEN s.neto_cafe IS NOT NULL AND abs(s.neto_cafe - c.neto_cafeteria) < 0.05
          THEN c.iva_total * s.iva_cafe / nullif(s.iva_todo, 0) END,
        c.iva_total * c.neto_cafeteria / nullif(c.subtotal_neto, 0),
        0)
    + coalesce(c.percepciones_total * c.neto_cafeteria / nullif(c.subtotal_neto, 0), 0)
  )::numeric, 2)
FROM "comprobantes" c2
  LEFT JOIN (
    SELECT ci.comprobante_id,
      sum(ci.subtotal * ci.iva) AS iva_todo,
      coalesce(sum(ci.subtotal * ci.iva) FILTER (WHERE ci.para_cafeteria), 0) AS iva_cafe,
      sum(ci.subtotal) FILTER (WHERE ci.para_cafeteria) AS neto_cafe
    FROM "comprobante_items" ci GROUP BY ci.comprobante_id
  ) s ON s.comprobante_id = c2.id
WHERE c2.id = c.id AND c.neto_cafeteria > 0;
--> statement-breakpoint

-- 2 · Los envíos: `costo_neto` guarda el costo de siempre y, en la salida,
--     `costo_unitario` pasa a ser el precio final (con el factor del día del
--     envío). La entrada no cambia: es lo que declara Coffit.
ALTER TABLE "envio_cafeteria_items" ADD COLUMN IF NOT EXISTS "costo_neto" double precision NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE "envio_cafeteria_items" SET "costo_neto" = "costo_unitario";
--> statement-breakpoint
UPDATE "envio_cafeteria_items" i SET "costo_unitario" = round((i.costo_neto * f.factor)::numeric, 4)
FROM (
  SELECT i2.id, pg_temp.coffit_factor_final(i2.producto_id, e.fecha) AS factor
  FROM "envio_cafeteria_items" i2 JOIN "envios_cafeteria" e ON e.id = i2.envio_id
  WHERE e.sentido = 'salida'
) f
WHERE f.id = i.id AND abs(f.factor - 1) > 1e-9;
--> statement-breakpoint
-- El total del envío y su versión: Coffit se entera del costo nuevo en el próximo sync.
UPDATE "envios_cafeteria" e SET
  "total_costo" = t.total, "version" = e.version + 1, "actualizado_en" = now()
FROM (
  SELECT i.envio_id, round(sum(i.cantidad * i.costo_unitario)::numeric, 2)::double precision AS total
  FROM "envio_cafeteria_items" i GROUP BY i.envio_id
) t
WHERE t.envio_id = e.id AND e.sentido = 'salida' AND abs(t.total - e.total_costo) > 0.004;
--> statement-breakpoint

-- 3 · Hasta dónde la cuenta se firmó sin IVA: el fin del último mes cerrado.
INSERT INTO "configuracion" ("clave", "valor")
SELECT 'coffit_sin_iva_hasta', to_jsonb((max(hasta) + time '23:59:59.999') AT TIME ZONE 'America/Argentina/Buenos_Aires')
FROM "coffit_cierres" WHERE NOT anulado
HAVING count(*) > 0
ON CONFLICT ("clave") DO NOTHING;
--> statement-breakpoint

-- 4 · La diferencia en UN ajuste a favor de Sabor y Aroma en el mes abierto
--     (la misma cuenta que src/cafeteria/cuenta.ts): lo de los meses cerrados,
--     que se siguen viendo como se firmaron, y el stock que se le cobró sin IVA
--     al marcar artículos de uso exclusivo (un movimiento ya cargado).
WITH corte AS (
  SELECT ("valor" #>> '{}')::timestamptz AS t FROM "configuracion" WHERE "clave" = 'coffit_sin_iva_hasta'
), cerrado AS (
  SELECT
    coalesce((SELECT sum((c.final_cafeteria - c.neto_cafeteria) * (CASE WHEN c.tipo = 'nota_credito' THEN -1 ELSE 1 END))
      FROM "comprobantes" c, corte
      WHERE c.estado = 'confirmado' AND c.neto_cafeteria > 0
        AND c.tipo IN ('factura', 'liquidacion', 'nota_debito', 'nota_credito')
        AND coalesce(c.cuenta_fecha, c.fecha) <= corte.t), 0)
    + coalesce((SELECT sum((i.cantidad - i.cantidad_exclusiva) * (i.costo_unitario - i.costo_neto))
      FROM "envios_cafeteria" e JOIN "envio_cafeteria_items" i ON i.envio_id = e.id, corte
      WHERE e.estado = 'enviado' AND e.sentido = 'salida' AND e.fecha <= corte.t), 0)
    + coalesce((SELECT sum((coalesce(i.cantidad_recibida, i.cantidad) - i.cantidad) * (i.costo_unitario - i.costo_neto))
      FROM "envios_cafeteria" e JOIN "envio_cafeteria_items" i ON i.envio_id = e.id, corte
      WHERE e.estado = 'enviado' AND e.sentido = 'salida' AND e.recepcion <> 'pendiente'
        AND e.recibido_en IS NOT NULL AND e.recibido_en <= corte.t), 0)
    + coalesce((SELECT sum(g.iva + g.perc_dgi + g.perc_dgr)
      FROM "gastos" g, corte
      WHERE g.negocio = 'cafeteria' AND g.estado <> 'anulado' AND coalesce(g.cuenta_fecha, g.fecha) <= corte.t), 0) AS v
), exclusivo AS (
  SELECT coalesce(sum(m.importe * (pg_temp.coffit_factor_final(m.producto_id, m.fecha) - 1)), 0) AS v
  FROM "coffit_movimientos" m
  WHERE m.tipo = 'marca_exclusivo' AND NOT m.anulado AND m.producto_id IS NOT NULL
), dif AS (
  SELECT (SELECT v FROM cerrado) + (SELECT v FROM exclusivo) AS v,
    (SELECT to_char(t AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY') FROM corte) AS hasta
)
INSERT INTO "coffit_movimientos" ("fecha", "tipo", "a_favor", "importe", "descripcion")
SELECT now(), 'ajuste', CASE WHEN v > 0 THEN 'sya' ELSE 'coffit' END, round(abs(v)::numeric, 2)::double precision,
  'Coffit paga precio final desde el principio (16/10/2026): el IVA y las percepciones de lo que ya se le había cobrado sin IVA'
    || coalesce(' (meses cerrados hasta el ' || hasta || ' y stock cobrado al pasar artículos a uso exclusivo)', ' (stock cobrado al pasar artículos a uso exclusivo)')
FROM dif WHERE abs(v) >= 0.005;
