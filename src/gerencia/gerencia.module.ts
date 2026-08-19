/**
 * GERENCIA › RENTABILIDAD — el margen de verdad (0072)
 * ============================================================================
 * El tablero que responde las preguntas que las pantallas operativas no pueden:
 * cuánto se ganó DE VERDAD, cuánto IVA está absorbiendo el negocio por la
 * mercadería sin factura, y si el crédito fiscal de lo facturado alcanza a
 * cubrir el débito de lo que se vende con factura.
 *
 * TODO EL MARGEN SALE DEL COSTO CONGELADO en cada renglón de venta
 * (`venta_items.costo_unitario`, 0072). Los renglones anteriores a esa
 * migración no lo tienen (NULL) y acá NO se inventa: se saltean y el payload
 * dice cuántos son (`cobertura`). Un margen calculado con el costo de hoy
 * sobre una venta de hace tres meses es un número plausible y falso.
 *
 * Dos vocabularios, siempre juntos:
 *   margen real     = venta neta − costo real congelado. La plata que quedó.
 *   margen aparente = margen real + IVA absorbido. El que "se ve" si uno mira
 *                     solo el markup — se muestra al lado del real justamente
 *                     para que la diferencia (el IVA absorbido) tenga cara.
 */
import { Controller, Get, Inject, Injectable, Module, Query } from '@nestjs/common';
import { and, asc, eq, gt, gte, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { Permiso } from '../auth/auth.decoradores';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  categorias, comprobantes, gastos, marcas, productoProveedores, productos, proveedores,
  stock, ventaItems, ventas,
} from '../db/schema';
import { costosFormato, formatoActivo } from '../inventario/pricing';

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** 'AAAA-MM-DD' → Date local (T00:00:00: sin la T se corre un día — trampa conocida). */
const dia = (v?: string) => {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
};

@Injectable()
export class RentabilidadService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async rentabilidad(q: { desde?: string; hasta?: string; sucursalId?: number | null }) {
    /* El período: por defecto, del 1° del mes hasta hoy. `hastaEx` es EXCLUSIVO
     * (medianoche del día siguiente): "hasta el 18" tiene que incluir lo vendido
     * el 18 a la tarde. */
    const hoy = new Date();
    const desde = dia(q.desde) ?? new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    const hastaInc = dia(q.hasta) ?? hoy;
    const hastaEx = new Date(hastaInc.getFullYear(), hastaInc.getMonth(), hastaInc.getDate() + 1);
    const suc = q.sucursalId || null;

    const [filasVenta, fiscalVentas, filasCompra, filaGastos, provRows, prods, ms, cs] = await Promise.all([
      this.ventasPorProducto(desde, hastaEx, suc),
      this.fiscalVentas(desde, hastaEx, suc),
      this.comprasPorProveedor(desde, hastaEx),
      this.creditoGastos(desde, hastaEx),
      this.db.select().from(proveedores),
      this.db.select().from(productos).where(ne(productos.estado, 'archivado' as any)),
      this.db.select().from(marcas),
      this.db.select().from(categorias),
    ]);

    /* ---- El formato activo de cada producto: proveedor, % y costos de HOY ---- */
    const provsDe = await this.db.select().from(productoProveedores);
    const porProducto = new Map<number, any>();
    for (const f of provsDe) {
      const arr = porProducto.get(f.productoId);
      if (arr) arr.push(f); else porProducto.set(f.productoId, [f]);
    }
    const nombreProv = new Map(provRows.map((p) => [p.id, p.nombre]));
    const nombreMarca = new Map(ms.map((m) => [m.id, m.nombre]));
    const nombreCat = new Map(cs.map((c) => [c.id, c.nombre]));

    /** productoId → { proveedorId, porcAhora, costoU, ivaAbsU } del formato activo. */
    const hoyDe = new Map<number, { proveedorId: number | null; porcAhora: number; costoU: number; ivaAbsU: number }>();
    for (const p of prods) {
      const activo = formatoActivo(porProducto.get(p.id) ?? []);
      const cf = costosFormato(activo as any, p.iva);
      hoyDe.set(p.id, {
        proveedorId: (activo as any)?.proveedorId ?? null,
        porcAhora: cf.porcSinFactura,
        costoU: cf.costoNetoUnitario,
        ivaAbsU: cf.ivaAbsorbidoUnitario,
      });
    }

    /* ---- Margen por producto (congelado) + totales ---- */
    const infoProd = new Map(prods.map((p) => [p.id, p]));
    const porProductoOut = filasVenta.map((f: any) => {
      const p: any = infoProd.get(f.productoId) ?? {};
      const h = hoyDe.get(f.productoId);
      const margenReal = f.costo != null ? r2(f.ventaCosteada - f.costo) : null;
      const margenAparente = margenReal != null ? r2(margenReal + (f.ivaAbsorbido ?? 0)) : null;
      return {
        productoId: f.productoId,
        nombre: p.nombre ?? `#${f.productoId}`,
        marcaId: p.marcaId ?? null,
        marca: nombreMarca.get(p.marcaId) ?? '',
        categoriaId: p.categoriaId ?? null,
        categoria: nombreCat.get(p.categoriaId) ?? '',
        proveedorId: h?.proveedorId ?? null,
        proveedor: nombreProv.get(h?.proveedorId as number) ?? '',
        unidades: r2(f.unidades),
        ventaNeta: r2(f.ventaNeta),
        /** La venta de los renglones CON costo: la única base honesta del margen. */
        ventaCosteada: r2(f.ventaCosteada),
        costo: f.costo != null ? r2(f.costo) : null,
        margenReal,
        margenAparente,
        ivaAbsorbido: r2(f.ivaAbsorbido ?? 0),
        /** % del margen real sobre la venta costeada (la "ganancia real"). */
        margenRealPct: margenReal != null && f.ventaCosteada > 0 ? r2((margenReal / f.ventaCosteada) * 100) : null,
        /** Vendido como sin factura (congelado) — el filtro del panel. */
        sinFactura: !!f.sinFactura,
        /** % del formato activo HOY, para leer la config sin abrir el producto. */
        porcAhora: h?.porcAhora ?? 0,
        renglones: f.renglones,
        conCosto: f.conCosto,
      };
    });

    const sum = (fn: (x: any) => number) => porProductoOut.reduce((a, x) => a + (fn(x) || 0), 0);
    const totales = {
      ventaNeta: r2(sum((x) => x.ventaNeta)),
      ventaCosteada: r2(sum((x) => x.ventaCosteada)),
      costoReal: r2(sum((x) => x.costo ?? 0)),
      margenReal: r2(sum((x) => x.margenReal ?? 0)),
      margenAparente: r2(sum((x) => x.margenAparente ?? 0)),
      ivaAbsorbido: r2(sum((x) => x.ivaAbsorbido)),
    };
    const sf = porProductoOut.filter((x) => x.sinFactura);
    const sinFactura = {
      productos: sf.length,
      ventaNeta: r2(sf.reduce((a, x) => a + x.ventaNeta, 0)),
      margenReal: r2(sf.reduce((a, x) => a + (x.margenReal ?? 0), 0)),
      ivaAbsorbido: r2(sf.reduce((a, x) => a + x.ivaAbsorbido, 0)),
      participacion: totales.ventaNeta > 0
        ? r2((sf.reduce((a, x) => a + x.ventaNeta, 0) / totales.ventaNeta) * 100) : 0,
    };

    /* ---- La posición fiscal del período ---- */
    const creditoCompras = r2(filasCompra.reduce((a: number, c: any) => a + c.ivaCredito, 0));
    const fiscal = {
      /** IVA de las ventas FACTURADAS (las de ticket no generan débito). */
      debitoVentas: r2(fiscalVentas.debito),
      ventasFacturadas: fiscalVentas.cantidad,
      creditoCompras,
      creditoGastos: r2(filaGastos),
      /** > 0 = queda IVA por pagar; el absorbido ya vive adentro del débito. */
      posicion: r2(fiscalVentas.debito - creditoCompras - filaGastos),
    };

    /* ---- Compras del período por proveedor: lo declarado contra lo real ---- */
    const porProveedor = filasCompra
      .map((c: any) => {
        const prov: any = provRows.find((p) => p.id === c.proveedorId) ?? {};
        const base = c.facturadoNeto + c.liquidado;
        const porcReal = base > 0 ? r2((c.liquidado / base) * 100) : 0;
        const declarado = Number(prov.porcSinFactura) || 0;
        return {
          proveedorId: c.proveedorId,
          nombre: prov.nombre ?? `#${c.proveedorId}`,
          facturadoNeto: r2(c.facturadoNeto),
          liquidado: r2(c.liquidado),
          ivaCredito: r2(c.ivaCredito),
          porcReal,
          porcDeclarado: declarado,
          /*
           * EL CONTROL: si lo declarado y lo real difieren en serio, el costo
           * de esos productos está mal partido — y el precio también. 10 puntos
           * de tolerancia: las compras de un mes nunca dan la mitad exacta.
           */
          desvio: (declarado > 0 || c.liquidado > 0) && base > 0 && Math.abs(porcReal - declarado) > 10,
        };
      })
      .filter((c: any) => c.liquidado > 0 || c.porcDeclarado > 0 || c.desvio)
      .sort((a: any, b: any) => b.liquidado - a.liquidado);
    const compras = {
      facturadoNeto: r2(filasCompra.reduce((a: number, c: any) => a + c.facturadoNeto, 0)),
      liquidado: r2(filasCompra.reduce((a: number, c: any) => a + c.liquidado, 0)),
    };

    /* ---- El stock sin factura que espera en el depósito ---- */
    const stockSinFactura = await this.stockSinFactura(prods, hoyDe);

    return {
      periodo: { desde: desde.toISOString(), hasta: hastaEx.toISOString() },
      cobertura: {
        renglones: filasVenta.reduce((a: number, f: any) => a + f.renglones, 0),
        conCosto: filasVenta.reduce((a: number, f: any) => a + f.conCosto, 0),
      },
      totales,
      sinFactura,
      fiscal,
      compras,
      porProveedor,
      stockSinFactura,
      /* Ordenado por venta y con techo: el panel agrupa y filtra sobre esto.
       * 500 productos con venta en un período es más de lo que una pantalla
       * puede decir — y sin techo el payload crece con el catálogo. */
      porProducto: porProductoOut.sort((a, b) => b.ventaNeta - a.ventaNeta).slice(0, 500),
      productosRecortados: Math.max(0, porProductoOut.length - 500),
    };
  }

  /** Venta neta, costo congelado e IVA absorbido, agrupados por producto. */
  private async ventasPorProducto(desde: Date, hastaEx: Date, sucursalId: number | null) {
    const conds = [
      gte(ventas.fecha, desde), lt(ventas.fecha, hastaEx),
      // Ni borradores ni anuladas: lo primero no es una venta todavía, lo
      // segundo dejó de serlo. Mismo criterio que el listado de Ventas.
      inArray(ventas.estado, ['confirmada', 'pendiente_cae'] as any),
    ];
    if (sucursalId) conds.push(eq(ventas.sucursalId, sucursalId));
    return this.db.select({
      productoId: ventaItems.productoId,
      unidades: sql<number>`sum(${ventaItems.cantidad})`,
      ventaNeta: sql<number>`sum(${ventaItems.subtotal})`,
      /* El margen solo puede medirse donde hay costo congelado: la venta de
       * ESOS renglones va aparte para que el % no mezcle peras con nada. */
      ventaCosteada: sql<number>`coalesce(sum(${ventaItems.subtotal}) filter (where ${ventaItems.costoUnitario} is not null), 0)`,
      costo: sql<number | null>`sum(${ventaItems.cantidad} * ${ventaItems.costoUnitario})`,
      ivaAbsorbido: sql<number>`coalesce(sum(${ventaItems.cantidad} * ${ventaItems.ivaAbsorbidoUnitario}), 0)`,
      renglones: sql<number>`count(*)::int`,
      conCosto: sql<number>`count(${ventaItems.costoUnitario})::int`,
      sinFactura: sql<boolean>`bool_or(coalesce(${ventaItems.porcSinFactura}, 0) > 0)`,
    }).from(ventaItems)
      .innerJoin(ventas, eq(ventaItems.ventaId, ventas.id))
      .where(and(...conds))
      .groupBy(ventaItems.productoId);
  }

  /** El débito fiscal: IVA de las ventas con factura (el ticket no declara). */
  private async fiscalVentas(desde: Date, hastaEx: Date, sucursalId: number | null) {
    const conds = [
      gte(ventas.fecha, desde), lt(ventas.fecha, hastaEx),
      inArray(ventas.estado, ['confirmada', 'pendiente_cae'] as any),
      inArray(ventas.tipo, ['factura_a', 'factura_b', 'factura_c'] as any),
    ];
    if (sucursalId) conds.push(eq(ventas.sucursalId, sucursalId));
    const [r] = await this.db.select({
      debito: sql<number>`coalesce(sum(${ventas.ivaTotal}), 0)`,
      cantidad: sql<number>`count(*)::int`,
    }).from(ventas).where(and(...conds));
    return r ?? { debito: 0, cantidad: 0 };
  }

  /**
   * Las compras del período, por proveedor: el neto facturado (con su IVA, que
   * es crédito) contra lo liquidado (sin nada). Las notas de crédito restan de
   * lo facturado — una devolución grande sin restar diría que se compró de más.
   */
  private async comprasPorProveedor(desde: Date, hastaEx: Date) {
    return this.db.select({
      proveedorId: comprobantes.proveedorId,
      /* Cada `filter` con su propio coalesce: un proveedor sin notas de débito
       * da NULL en esa pata, y NULL + número = NULL — el neto entero se
       * esfumaría con un solo coalesce alrededor de la suma. */
      facturadoNeto: sql<number>`coalesce(sum(${comprobantes.subtotalNeto}) filter (where ${comprobantes.tipo} = 'factura'), 0)
        + coalesce(sum(${comprobantes.subtotalNeto}) filter (where ${comprobantes.tipo} = 'nota_debito'), 0)
        - coalesce(sum(${comprobantes.subtotalNeto}) filter (where ${comprobantes.tipo} = 'nota_credito'), 0)`,
      liquidado: sql<number>`coalesce(sum(${comprobantes.subtotalNeto}) filter (where ${comprobantes.tipo} = 'liquidacion'), 0)`,
      ivaCredito: sql<number>`coalesce(sum(${comprobantes.ivaTotal}) filter (where ${comprobantes.tipo} = 'factura'), 0)
        + coalesce(sum(${comprobantes.ivaTotal}) filter (where ${comprobantes.tipo} = 'nota_debito'), 0)
        - coalesce(sum(${comprobantes.ivaTotal}) filter (where ${comprobantes.tipo} = 'nota_credito'), 0)`,
    }).from(comprobantes)
      .where(and(
        gte(comprobantes.fecha, desde), lt(comprobantes.fecha, hastaEx),
        eq(comprobantes.estado, 'confirmado' as any),
      ))
      .groupBy(comprobantes.proveedorId);
  }

  /** El IVA de los gastos facturados: también es crédito, también cubre. */
  private async creditoGastos(desde: Date, hastaEx: Date) {
    const [r] = await this.db.select({
      iva: sql<number>`coalesce(sum(${gastos.iva}), 0)`,
    }).from(gastos).where(and(
      gte(gastos.fecha, desde), lt(gastos.fecha, hastaEx),
      ne(gastos.estado, 'anulado' as any),
    ));
    return r?.iva ?? 0;
  }

  /**
   * Lo sin factura PARADO en el depósito: valor real y el IVA que el negocio
   * va a absorber si lo vende todo. Global (todas las sucursales): la
   * exposición es del negocio, no de un local.
   */
  private async stockSinFactura(
    prods: any[],
    hoyDe: Map<number, { porcAhora: number; costoU: number; ivaAbsU: number; proveedorId: number | null }>,
  ) {
    const ids = prods.filter((p) => (hoyDe.get(p.id)?.porcAhora ?? 0) > 0).map((p) => p.id);
    if (!ids.length) return { productos: 0, valorReal: 0, ivaAbsorber: 0 };
    const filas = await this.db.select().from(stock).where(and(
      inArray(stock.productoId, ids), eq(stock.estado, 'disponible' as any), gt(stock.cantidad, 1e-9),
    ));
    // El costo del paquete es el del kilo × su tamaño: hace falta el tamaño.
    const presIds = [...new Set(filas.map((f) => f.presentacionId).filter(Boolean))] as number[];
    const press = presIds.length
      ? await this.db.execute(sql`SELECT id, tam_kg FROM presentaciones WHERE id IN (${sql.join(presIds.map((i) => sql`${i}`), sql`, `)})`)
      : { rows: [] as any[] };
    const tamDe = new Map<number, number>(
      (((press as any).rows ?? []) as any[]).map((r: any) => [Number(r.id), Number(r.tam_kg)]),
    );

    let valorReal = 0; let ivaAbsorber = 0;
    const conStock = new Set<number>();
    for (const f of filas) {
      const h = hoyDe.get(f.productoId); if (!h) continue;
      const escala = f.presentacionId ? (tamDe.get(f.presentacionId) ?? 0) : 1;
      valorReal += f.cantidad * h.costoU * escala;
      ivaAbsorber += f.cantidad * h.ivaAbsU * escala;
      conStock.add(f.productoId);
    }
    return { productos: conStock.size, valorReal: r2(valorReal), ivaAbsorber: r2(ivaAbsorber) };
  }
}

@Controller('gerencia')
@Permiso('gerencia.rentabilidad')
export class GerenciaController {
  constructor(private readonly svc: RentabilidadService) {}

  @Get('rentabilidad')
  rentabilidad(
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('sucursalId') sucursalId?: string,
  ) {
    return this.svc.rentabilidad({ desde, hasta, sucursalId: sucursalId ? Number(sucursalId) : null });
  }
}

@Module({
  controllers: [GerenciaController],
  providers: [RentabilidadService],
})
export class GerenciaModule {}
