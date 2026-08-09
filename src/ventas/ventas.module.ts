/**
 * VENTAS
 * ============================================================================
 * Comprobante de venta: tabla propia, numeración asignada por el sistema y
 * estado que no vuelve atrás (confirmada → anulada, nunca editada).
 *
 * El punto de venta trabaja con **borradores**: una venta puede quedar abierta
 * mientras el cliente va a buscar otra cosa, y el cajero sigue atendiendo. Un
 * borrador vive en esta misma tabla con `estado='borrador'`, y por eso:
 *   - NO consume numeración (el índice único de `numero` es parcial),
 *   - NO descuenta stock ni exige caja ni pagos,
 *   - SÍ se puede editar, delegar a otro vendedor y descartar.
 * Confirmar es el único momento en que la venta toca el inventario y la caja.
 *
 * Convención de importes: los precios son NETOS (sin IVA), igual que en los
 * comprobantes de compra. El IVA se suma aparte. Un solo criterio en todo el
 * sistema evita el clásico descuadre de centavos entre compras y ventas.
 */
import {
  Body, Controller, Delete, Get, Inject, Injectable, Module, BadRequestException,
  NotFoundException, Param, ParseIntPipe, Post, Put, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, ValidateNested,
} from 'class-validator';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  categorias, clientes, clienteListas, cobranzaImputaciones, cobranzas, marcas,
  etiquetas, productoEtiquetas, productoListas, presentaciones, productoProveedores, productos,
  presupuestoItems, presupuestos, proveedores, roles, stock, sucursales, usuarios,
  ventaExtras, ventaItems, ventaPagos, ventas,
} from '../db/schema';
import { ClientesModule, ClientesService } from '../clientes/clientes.module';
import { ConfiguracionModule, ConfiguracionService } from '../configuracion/configuracion.module';
import { CajaModule, CajaService } from '../caja/caja.module';
import { ListasModule, ListasService } from '../listas/listas.module';
import { OfertasModule, OfertasService } from '../ofertas/ofertas.module';
import { InventarioModule } from '../inventario/inventario.module';
import { InventarioService } from '../inventario/inventario.service';
import { costoNetoEntry, formatoActivo, precioLista, precioPresentacion, precioVentaFila } from '../inventario/pricing';

const TIPOS = ['ticket', 'factura_a', 'factura_b', 'factura_c', 'nota_credito', 'nota_debito'] as const;
const MEDIOS = ['efectivo', 'transferencia', 'tarjeta_debito', 'tarjeta_credito', 'cheque', 'qr', 'otro'] as const;

/** Redondeo monetario a 2 decimales (evita el arrastre de flotantes). */
export const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Tipo de comprobante que corresponde emitir. Depende de NUESTRA condición
 * fiscal y de la del cliente; con ARCA apagado siempre es ticket interno.
 */
export function tipoVentaPara(cliente: { condicionIva: string }, config: Record<string, any>) {
  if (!config.arcaHabilitado) return 'ticket';
  return letraFacturaPara(cliente, config);
}

/**
 * Letra que corresponde cuando se decide FACTURAR explícitamente (F7 en la
 * caja). A diferencia de `tipoVentaPara`, no mira `arcaHabilitado`: el cajero
 * pidió factura, así que se emite el comprobante fiscal igual — con ARCA
 * apagado sale sin CAE, que es exactamente la etapa en la que estamos.
 */
export function letraFacturaPara(cliente: { condicionIva: string }, config: Record<string, any>) {
  const empresa = config.condicionIvaEmpresa;
  if (empresa === 'monotributo' || empresa === 'exento') return 'factura_c';
  return cliente.condicionIva === 'responsable_inscripto' ? 'factura_a' : 'factura_b';
}

/* ------------------------------- DTOs ------------------------------- */

const ORIGENES_LISTA = ['base', 'cliente', 'auto', 'manual', 'marca', 'monto'] as const;

class VentaItemDto {
  @IsInt() productoId!: number;
  @IsOptional() @IsInt() presentacionId?: number;
  @IsNumber() cantidad!: number;
  @IsOptional() @IsInt() listaId?: number;
  @IsOptional() @IsString() lista?: string;
  @IsOptional() @IsIn(ORIGENES_LISTA as unknown as string[]) listaOrigen?: string;
  @IsOptional() @IsNumber() precioLista?: number;
  @IsOptional() @IsNumber() precioUnitario?: number;
  @IsOptional() @IsNumber() descuento?: number;
  /** Oferta aplicada por el motor del POS: referencia + nombre + importe neto. */
  @IsOptional() @IsInt() ofertaId?: number;
  @IsOptional() @IsString() oferta?: string;
  @IsOptional() @IsNumber() ofertaDescuento?: number;
  @IsOptional() @IsNumber() iva?: number;
}

class VentaExtraDto {
  @IsString() concepto!: string;
  @IsNumber() importe!: number;
  @IsOptional() @IsNumber() iva?: number;
}

class VentaPagoDto {
  @IsIn(MEDIOS as unknown as string[]) medio!: (typeof MEDIOS)[number];
  @IsNumber() importe!: number;
  @IsOptional() @IsString() referencia?: string;
}

export class CreateVentaDto {
  @IsOptional() @IsInt() clienteId?: number;
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsInt() usuarioId?: number;
  @IsOptional() @IsInt() cajaSesionId?: number;
  @IsOptional() @IsIn(TIPOS as unknown as string[]) tipo?: (typeof TIPOS)[number];
  /** 'borrador' deja la venta abierta en el punto de venta. */
  @IsOptional() @IsIn(['borrador', 'confirmada']) estado?: 'borrador' | 'confirmada';
  @IsOptional() @IsIn(['contado', 'cuenta_corriente']) condicionPago?: 'contado' | 'cuenta_corriente';
  @IsOptional() @IsString() fecha?: string;
  @IsOptional() @IsString() listaPrecio?: string;
  @IsOptional() @IsString() observaciones?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => VentaItemDto)
  items?: VentaItemDto[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => VentaExtraDto)
  extras?: VentaExtraDto[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => VentaPagoDto)
  pagos?: VentaPagoDto[];
  /** Venta que nace de (o cierra) un presupuesto confirmado. */
  @IsOptional() @IsInt() presupuestoId?: number;
}

class ConfirmarVentaDto {
  /**
   * Cómo se cierra: 'ticket' = liquidar (comprobante interno), 'factura' =
   * facturar (la letra la resuelve el backend según las dos condiciones de
   * IVA). Si no viene, se respeta el tipo con el que nació el borrador.
   */
  @IsOptional() @IsIn(['ticket', 'factura']) tipo?: 'ticket' | 'factura';
  @IsOptional() @IsIn(['contado', 'cuenta_corriente']) condicionPago?: 'contado' | 'cuenta_corriente';
  @IsOptional() @IsInt() cajaSesionId?: number;
  @IsOptional() @IsInt() usuarioId?: number;
  @IsOptional() @IsString() observaciones?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => VentaPagoDto)
  pagos?: VentaPagoDto[];
}

class DelegarVentaDto {
  @IsInt() usuarioId!: number;
}

@Injectable()
export class VentasService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly inv: InventarioService,
    private readonly cfg: ConfiguracionService,
    private readonly cli: ClientesService,
    private readonly caja: CajaService,
    private readonly listas: ListasService,
    private readonly ofertas: OfertasService,
  ) {}

  /* ------------------------------ Lectura ------------------------------ */

  /**
   * Importe ya cobrado de cada venta (solo cobranzas confirmadas). Se resuelve
   * en UNA consulta agrupada en vez de una por documento.
   */
  private async imputadoPorVenta(ventaIds: number[]) {
    const mapa = new Map<number, number>();
    if (!ventaIds.length) return mapa;
    const filas = await this.db
      .select({
        ventaId: cobranzaImputaciones.ventaId,
        importe: sql<number>`coalesce(sum(${cobranzaImputaciones.importe}), 0)`,
      })
      .from(cobranzaImputaciones)
      .innerJoin(cobranzas, eq(cobranzas.id, cobranzaImputaciones.cobranzaId))
      .where(and(eq(cobranzas.estado, 'confirmada'), inArray(cobranzaImputaciones.ventaId, ventaIds)))
      .groupBy(cobranzaImputaciones.ventaId);
    for (const f of filas) mapa.set(f.ventaId, Number(f.importe) || 0);
    return mapa;
  }

  async list(q: {
    clienteId?: number; sucursalId?: number; estado?: string;
    desde?: string; hasta?: string; limit?: number; incluirItems?: boolean;
  }) {
    const conds: any[] = [];
    if (q.clienteId) conds.push(eq(ventas.clienteId, Number(q.clienteId)));
    if (q.sucursalId) conds.push(eq(ventas.sucursalId, Number(q.sucursalId)));
    if (q.estado) conds.push(eq(ventas.estado, q.estado as any));
    if (q.desde) conds.push(gte(ventas.fecha, new Date(q.desde)));
    if (q.hasta) conds.push(lte(ventas.fecha, new Date(q.hasta)));

    // Límite por defecto: el listado nunca trae la tabla entera.
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    const rows = await this.db.select().from(ventas)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(ventas.id))
      .limit(limit);
    if (!rows.length) return [];

    const ids = rows.map((v) => v.id);
    const imput = await this.imputadoPorVenta(ids);

    // Los ítems se piden solo si el llamador los necesita (la lista de ventas
    // abiertas los usa para mostrar el último producto cargado); una consulta
    // para todo el lote, no una por venta.
    const items = q.incluirItems
      ? await this.db.select().from(ventaItems).where(inArray(ventaItems.ventaId, ids))
      : null;

    return rows.map((v) => {
      const cobrado = imput.get(v.id) ?? 0;
      const base = { ...v, cobrado, saldo: money(v.total - cobrado) };
      return items ? { ...base, items: items.filter((i) => i.ventaId === v.id) } : base;
    });
  }

  async get(id: number) {
    const [v] = await this.db.select().from(ventas).where(eq(ventas.id, id)).limit(1);
    if (!v) throw new NotFoundException('Venta inexistente.');
    const [items, extras, pagos, imput] = await Promise.all([
      this.db.select().from(ventaItems).where(eq(ventaItems.ventaId, id)).orderBy(ventaItems.id),
      this.db.select().from(ventaExtras).where(eq(ventaExtras.ventaId, id)).orderBy(ventaExtras.id),
      this.db.select().from(ventaPagos).where(eq(ventaPagos.ventaId, id)),
      this.imputadoPorVenta([id]),
    ]);
    const cobrado = imput.get(id) ?? 0;
    return { ...v, items, extras, pagos, cobrado, saldo: money(v.total - cobrado) };
  }

  /**
   * Cuenta corriente del cliente: saldo global + los comprobantes que todavía
   * deben algo. Es lo que consume la pantalla de cobranzas para imputar.
   */
  async cuenta(clienteId: number) {
    const cliente = await this.cli.get(clienteId);

    const pendientes = await this.db.select().from(ventas)
      .where(and(
        eq(ventas.clienteId, clienteId),
        eq(ventas.estado, 'confirmada'),
        eq(ventas.condicionPago, 'cuenta_corriente'),
      ))
      .orderBy(ventas.fecha, ventas.id);

    const imput = await this.imputadoPorVenta(pendientes.map((v) => v.id));

    const comprobantes = pendientes.map((v) => {
      const cobrado = imput.get(v.id) ?? 0;
      return { ...v, cobrado, saldo: money(v.total - cobrado) };
    });

    // El saldo global incluye lo cobrado "a cuenta" (no imputado a un documento),
    // por eso se calcula sobre los totales y no sumando los saldos de arriba.
    const [agg] = await this.db
      .select({ t: sql<number>`coalesce(sum(${cobranzas.total}), 0)` })
      .from(cobranzas)
      .where(and(eq(cobranzas.clienteId, clienteId), eq(cobranzas.estado, 'confirmada')));

    const facturado = pendientes.reduce((a, v) => a + v.total, 0);
    const cobradoTotal = Number(agg?.t) || 0;
    const saldo = money(facturado - cobradoTotal);
    const disponible = cliente.limiteCredito > 0 ? money(cliente.limiteCredito - saldo) : null;

    return {
      clienteId,
      saldo,
      facturado: money(facturado),
      cobrado: money(cobradoTotal),
      limiteCredito: cliente.limiteCredito,
      disponible,
      comprobantes: comprobantes.filter((c) => c.saldo > 0.009),
    };
  }

  /* ------------------------------ Catálogo POS ------------------------------ */

  /**
   * Todo lo VENDIBLE, con precios y stock ya resueltos.
   *
   * Devuelve una fila por cosa que se puede tipear en la caja: el producto
   * entero, el granel suelto (por kg) y cada presentación fraccionada. El punto
   * de venta lo pide UNA vez al abrir y busca en memoria — a 200 tickets por
   * día no se puede pagar un viaje a la API por tecla.
   *
   * Cada fila trae el stock de la sucursal (`stock`), el de todas
   * (`stockSucursales`) y su FORMATO DE VENTA: el precio en cada lista que el
   * producto tenga cargada, con el mínimo de unidades que la habilita
   * (`precios: [{listaId, precio, unidadesMinimas}]`).
   *
   * La condición viaja con el ARTÍCULO, no con la lista: la misma "Mayorista 1"
   * puede pedir 12 unidades en un producto y ninguna en otro. Lo que viaja una
   * sola vez en `listas` es la identidad (modalidad, número, nombre, orden),
   * que sí es común — repetirla por artículo multiplicaría la respuesta sin
   * aportar nada. El frontend cruza por `listaId`.
   *
   * Se arma con 7 consultas y se cruza en memoria; no hay N+1.
   */
  async catalogo(sucursalId: number) {
    const [prods, provs, formatos, cat, press, existencias, sucs, cfg, ms, cs, etiqs, ofs, etiqCat, provCat] = await Promise.all([
      this.db.select().from(productos).orderBy(productos.nombre),
      this.db.select().from(productoProveedores),
      this.db.select().from(productoListas),
      this.listas.catalogo(),
      this.db.select().from(presentaciones),
      this.db.select().from(stock).where(eq(stock.estado, 'disponible')),
      this.db.select().from(sucursales).orderBy(sucursales.nombre),
      this.cfg.get('ventas'),
      this.db.select({ id: marcas.id, nombre: marcas.nombre }).from(marcas),
      this.db.select({ id: categorias.id, nombre: categorias.nombre }).from(categorias),
      this.db.select().from(productoEtiquetas),
      this.ofertas.activas(),
      this.db.select({ id: etiquetas.id, nombre: etiquetas.nombre }).from(etiquetas),
      this.db.select({ id: proveedores.id, nombre: proveedores.nombre }).from(proveedores).orderBy(proveedores.nombre),
    ]);
    // Proveedores por producto: es lo que permite filtrar la consulta de
    // existencias por proveedor (un producto puede venir de varios).
    const proveedoresDe = new Map<number, number[]>();
    for (const f of provs) {
      const arr = proveedoresDe.get(f.productoId);
      if (arr) { if (!arr.includes(f.proveedorId)) arr.push(f.proveedorId); }
      else proveedoresDe.set(f.productoId, [f.proveedorId]);
    }
    // Etiquetas por producto: el motor de ofertas matchea el alcance por id.
    const etiquetasDe = new Map<number, number[]>();
    for (const e of etiqs) {
      const arr = etiquetasDe.get(e.productoId);
      if (arr) arr.push(e.etiquetaId); else etiquetasDe.set(e.productoId, [e.etiquetaId]);
    }
    // Nombres resueltos una vez: los filtros de la búsqueda masiva los muestran
    // y el motor de listas compara por id, así que viajan los dos.
    const nombreMarca = new Map(ms.map((m) => [m.id, m.nombre]));
    const nombreCategoria = new Map(cs.map((c) => [c.id, c.nombre]));
    const redondeo = cfg.redondeoPrecio;
    const activas = cat.listas.filter((l: any) => l.activa);
    const porLista = new Map<number, any>(activas.map((l: any) => [l.id, l]));
    const listaBase = activas.find((l: any) => l.id === cfg.listaBaseId) || activas[0] || null;

    const costoPorProd = new Map<number, number>();
    for (const p of prods) {
      const suyos = provs.filter((x) => x.productoId === p.id);
      costoPorProd.set(p.id, costoNetoEntry(formatoActivo(suyos), p.iva));
    }

    /** Stock por (producto, presentación, sucursal); presentación `null` = suelto. */
    const clave = (prodId: number, presId: number | null, sucId: number) => `${prodId}:${presId ?? ''}:${sucId}`;
    const stockDe = new Map<string, number>();
    for (const e of existencias) {
      const k = clave(e.productoId, e.presentacionId, e.sucursalId);
      stockDe.set(k, (stockDe.get(k) ?? 0) + e.cantidad);
    }
    const desglose = (prodId: number, presId: number | null) =>
      sucs.map((su) => ({
        sucursalId: su.id,
        nombre: su.nombre,
        cantidad: money(stockDe.get(clave(prodId, presId, su.id)) ?? 0),
      }));

    const items: any[] = [];
    for (const p of prods) {
      const costoNeto = costoPorProd.get(p.id) ?? 0;
      const opts = { iva: p.iva, redondeo };

      // El formato de venta del producto, ordenado por preferencia de lista.
      // Solo esto llega al POS: lo que no está cargado, no se vende. Cada fila
      // resuelve su precio con el MISMO helper que la ficha del producto
      // (markup o precio definido): un solo lugar donde se deriva.
      const efectivas = formatos
        .filter((f) => f.productoId === p.id && porLista.has(f.listaId))
        .map((f) => {
          const pv = precioVentaFila(costoNeto, f, opts);
          return {
            ...f,
            orden: porLista.get(f.listaId)!.orden,
            netoUnitario: pv.netoUnitario,
            // Markup EQUIVALENTE: las presentaciones derivan su precio de acá,
            // venga de un % o de un precio fijado a mano.
            markupEf: costoNeto > 0 ? ((pv.netoUnitario / costoNeto) - 1) * 100 : f.markup,
          };
        })
        .sort((a, b) => a.orden - b.orden);

      // El precio "de vidriera" es el del piso: lo que se paga sin habilitar
      // nada. Si el producto no tiene el piso cargado, la más cara de las suyas.
      const filaBase = efectivas.find((ef) => ef.listaId === listaBase?.id)
        ?? efectivas[efectivas.length - 1] ?? null;
      const markupBase = filaBase?.markupEf ?? 0;

      /*
       * El "solo para fraccionar" (la Pimienta de Jamaica que llega 1 kg y se
       * fracciona entera en paquetes) NO viaja suelto al POS: no está a la
       * venta por kg. Sus paquetes, abajo, van normal. Esto es solo lo que se
       * OFRECE — el candado que vale está en la venta (validarSoloFraccionar).
       */
      if (!p.soloFraccionar) items.push({
        key: `p${p.id}`,
        productoId: p.id,
        presentacionId: null,
        codigo: p.codigoBarras || p.codigoPropio,
        /** Código INTERNO del producto: es el que se muestra en las búsquedas. */
        codigoPropio: p.codigoPropio,
        nombre: p.nombre,
        marcaId: p.marcaId,
        marca: nombreMarca.get(p.marcaId as number) ?? '',
        categoriaId: p.categoriaId,
        categoria: nombreCategoria.get(p.categoriaId as number) ?? '',
        etiquetas: etiquetasDe.get(p.id) ?? [],
        proveedorIds: proveedoresDe.get(p.id) ?? [],
        detalle: p.tipo === 'granel' ? 'Suelto (por kg)' : 'Unidad',
        tipo: p.tipo,
        unidad: p.tipo === 'granel' ? 'kg' : 'u',
        fraccionable: p.tipo === 'granel',   // admite cantidad decimal
        iva: p.iva,
        codigoBarras: p.codigoBarras,
        precio: money(filaBase?.netoUnitario ?? 0),
        precios: efectivas.map((ef) => ({
          listaId: ef.listaId,
          precio: money(ef.netoUnitario),
          unidadesMinimas: ef.unidadesMinimas,
          unidades: ef.unidades,
        })),
        /**
         * Formatos con identidad propia (código de caja o venta por N): al
         * escanear el código de la caja, la caja registradora carga las N
         * unidades de una — y el motor de listas hace el resto.
         */
        formatosVenta: efectivas
          .filter((ef) => ef.codigoBarras || ef.unidades > 1)
          .map((ef) => ({ listaId: ef.listaId, codigoBarras: ef.codigoBarras, unidades: ef.unidades })),
        stock: money(stockDe.get(clave(p.id, null, sucursalId)) ?? 0),
        stockSucursales: desglose(p.id, null),
      });

      for (const pres of press.filter((x) => x.productoId === p.id)) {
        // La presentación SÍ respeta la lista: parte del precio por kg de esa
        // lista y le suma el recargo de fraccionamiento. Un mayorista paga la
        // bolsa de 1 kg a precio mayorista.
        items.push({
          key: `s${pres.id}`,
          productoId: p.id,
          presentacionId: pres.id,
          codigo: pres.codigoBarras,
          codigoPropio: p.codigoPropio,
          nombre: p.nombre,
          marcaId: p.marcaId,
          marca: nombreMarca.get(p.marcaId as number) ?? '',
          categoriaId: p.categoriaId,
          categoria: nombreCategoria.get(p.categoriaId as number) ?? '',
          etiquetas: etiquetasDe.get(p.id) ?? [],
          proveedorIds: proveedoresDe.get(p.id) ?? [],
          detalle: pres.tamKg < 1 ? `${Math.round(pres.tamKg * 1000)} g` : `${pres.tamKg} kg`,
          tipo: p.tipo,
          unidad: 'u',
          fraccionable: false,
          iva: p.iva,
          codigoBarras: pres.codigoBarras,
          precio: money(precioPresentacion(costoNeto, pres, markupBase, opts)),
          precios: efectivas.map((ef) => ({
            listaId: ef.listaId,
            precio: money(precioPresentacion(costoNeto, pres, ef.markupEf, opts)),
            unidadesMinimas: ef.unidadesMinimas,
          })),
          stock: money(stockDe.get(clave(p.id, pres.id, sucursalId)) ?? 0),
          stockSucursales: desglose(p.id, pres.id),
        });
      }
    }

    /**
     * Las listas viajan solo con su IDENTIDAD: markup y mínimos son del
     * artículo y ya están en `items[].precios`. Acá van las dos reglas que
     * SÍ son globales — las de marca y la de monto — para que el motor del POS
     * pueda evaluarlas sin recorrer el catálogo.
     */
    return {
      listas: activas.map((l: any) => ({
        listaId: l.id,
        modalidadId: l.modalidadId,
        modalidad: l.modalidad,
        numero: l.numero,
        nombre: l.nombre,
        etiqueta: l.etiqueta,
        orden: l.orden,
        esBase: l.id === listaBase?.id,
      })),
      /** "12 unidades de Coca-Cola habilitan Mayorista." Desbloquean la MODALIDAD. */
      reglasMarca: (cat.reglasMarca ?? [])
        .filter((r: any) => r.activa && r.unidadesMinimas > 0)
        .map((r: any) => ({
          // El motor compara por id (inmune a acentos y renombres); el nombre
          // viaja solo para que el cartel del POS diga de qué marca habla.
          marcaId: r.marcaId,
          marca: r.marca,
          unidadesMinimas: r.unidadesMinimas,
          modalidadId: r.modalidadId,
          modalidad: r.modalidad,
        })),
      /**
       * Acceso por monto de ticket. Se SUGIERE, nunca se aplica solo: se mide
       * sobre precios y aplicarlo baja el total, así que auto-aplicarlo podría
       * dejar el ticket bajo el umbral y revertirse en un ciclo.
       */
      montoMayorista: cfg.montoMinimoMayorista > 0 && cfg.modalidadMontoId
        ? {
            monto: cfg.montoMinimoMayorista,
            modalidadId: cfg.modalidadMontoId,
            modalidad: cat.modalidades.find((m: any) => m.id === cfg.modalidadMontoId)?.nombre ?? '',
            mediosPago: cfg.mediosPagoMonto ?? [],
          }
        : null,
      /**
       * Ofertas ACTIVAS con alcances y componentes. La vigencia fina (fecha,
       * día, sucursal) la evalúa el motor del POS con su reloj: el catálogo se
       * cachea al abrir la caja y una promo puede arrancar o vencer en medio
       * del turno.
       */
      ofertas: ofs,
      /** Nombres de las etiquetas, para el buscador de alcance del panel. */
      etiquetasCatalogo: etiqCat,
      /** Para el filtro por proveedor de la consulta de existencias. */
      proveedoresCatalogo: provCat,
      items,
    };
  }

  /* ------------------------------ Cálculo ------------------------------ */

  /**
   * Neto, descuento, IVA y total de ítems + extras. Un único lugar para que el
   * borrador, la edición y la confirmación no puedan descuadrar entre sí.
   */
  private calcularTotales(itemsDto: VentaItemDto[] = [], extrasDto: VentaExtraDto[] = []) {
    let subtotalNeto = 0;
    let descuentoTotal = 0;
    let ivaTotal = 0;

    const items = itemsDto.map((it) => {
      const cantidad = Number(it.cantidad) || 0;
      if (cantidad <= 0) throw new BadRequestException('Todas las cantidades deben ser mayores a 0.');
      const precioUnitario = Number(it.precioUnitario ?? it.precioLista) || 0;
      const precioListaItem = Number(it.precioLista ?? it.precioUnitario) || 0;
      const desc = Number(it.descuento) || 0;
      const ivaP = it.iva != null ? Number(it.iva) : 21;

      const bruto = cantidad * precioUnitario;
      // La oferta resta un IMPORTE neto después del descuento porcentual; el
      // tope en 0 evita que una promo mal calculada deje un renglón negativo.
      const ofertaDesc = Math.min(Math.max(0, Number(it.ofertaDescuento) || 0), bruto * (1 - desc / 100));
      const neto = bruto * (1 - desc / 100) - ofertaDesc;
      subtotalNeto += neto;
      descuentoTotal += bruto - neto;
      ivaTotal += (neto * ivaP) / 100;

      return {
        productoId: it.productoId,
        presentacionId: it.presentacionId ?? null,
        listaId: it.listaId ?? null,
        lista: (it.lista ?? '').trim(),
        listaOrigen: (it.listaOrigen ?? 'base') as any,
        cantidad,
        precioLista: precioListaItem,
        descuento: desc,
        precioUnitario,
        ofertaId: it.ofertaId ?? null,
        oferta: (it.oferta ?? '').trim(),
        ofertaDescuento: money(ofertaDesc),
        iva: ivaP,
        subtotal: money(neto),
      };
    });

    const extras = (extrasDto ?? [])
      .filter((e) => Number(e.importe) > 0)
      .map((e) => {
        const importe = money(e.importe);
        const ivaP = e.iva != null ? Number(e.iva) : 21;
        subtotalNeto += importe;
        ivaTotal += (importe * ivaP) / 100;
        return { concepto: (e.concepto || 'Extra').trim(), importe, iva: ivaP };
      });

    subtotalNeto = money(subtotalNeto);
    ivaTotal = money(ivaTotal);
    return {
      items, extras, subtotalNeto,
      descuentoTotal: money(descuentoTotal),
      ivaTotal,
      total: money(subtotalNeto + ivaTotal),
    };
  }

  /* ------------------------------ Validaciones ------------------------------ */

  /** Al contado los pagos cubren el total exacto; en cta. cte. no hay pagos. */
  private validarPagos(condicionPago: string, pagos: VentaPagoDto[], total: number) {
    const validos = (pagos ?? []).filter((p) => Number(p.importe) > 0);
    if (condicionPago === 'contado') {
      if (!validos.length) throw new BadRequestException('Indicá con qué se paga la venta.');
      const pagado = money(validos.reduce((a, p) => a + Number(p.importe), 0));
      if (Math.abs(pagado - total) > 0.01) {
        throw new BadRequestException(`Los pagos suman $${pagado.toFixed(2)} y el total es $${total.toFixed(2)}.`);
      }
    } else if (validos.length) {
      throw new BadRequestException('Una venta en cuenta corriente no lleva pagos: se cobra con un recibo.');
    }
    return validos;
  }

  /**
   * El precio desbloqueado POR MONTO puede exigir un medio de pago ("mayorista
   * solo en efectivo"). No se puede chequear al cargar el ticket —el medio se
   * elige al cobrar, después de que el precio ya se armó— así que se valida
   * acá, que es el último momento en que todavía se puede rechazar.
   *
   * Solo mira los renglones con `listaOrigen: 'monto'`: los que llegaron por
   * cantidad o por regla de marca se ganaron el precio con volumen y no dependen
   * de cómo se pague.
   */
  private validarMediosPagoMonto(items: any[], condicionPago: string, pagos: VentaPagoDto[], config: any) {
    const permitidos: string[] = config.mediosPagoMonto ?? [];
    if (!permitidos.length) return;                                  // sin restricción
    if (!items.some((it) => it.listaOrigen === 'monto')) return;     // nada que proteger

    const legibles = permitidos.join(' / ');
    if (condicionPago !== 'contado') {
      throw new BadRequestException(
        `El precio por monto de compra solo vale pagando al contado (${legibles}). Quitá el beneficio o cambiá la condición de pago.`,
      );
    }
    const usados = (pagos ?? []).filter((p) => Number(p.importe) > 0).map((p) => p.medio);
    const invalido = usados.find((m) => !permitidos.includes(m));
    if (invalido) {
      throw new BadRequestException(
        `El precio por monto de compra solo vale pagando con ${legibles}. Se está usando "${invalido}".`,
      );
    }
  }

  /**
   * Igual que el precio por monto, una oferta de ticket puede exigir medio de
   * pago ("10% pagando en efectivo"). Se valida al confirmar, que es cuando el
   * medio existe. Las ofertas por cantidad no dependen de cómo se pague.
   */
  private async validarMediosPagoOfertas(items: any[], condicionPago: string, pagos: VentaPagoDto[]) {
    const ids = [...new Set(items.map((it: any) => it.ofertaId).filter(Boolean))] as number[];
    const exigentes = await this.ofertas.ticketConMedios(ids);
    for (const o of exigentes) {
      const permitidos = o.mediosPago.split(',').map((m: string) => m.trim()).filter(Boolean);
      const legibles = permitidos.join(' / ');
      if (condicionPago !== 'contado') {
        throw new BadRequestException(
          `La oferta "${o.nombre}" solo vale pagando al contado (${legibles}). Quitala o cambiá la condición de pago.`,
        );
      }
      const usados = (pagos ?? []).filter((p) => Number(p.importe) > 0).map((p) => p.medio);
      const invalido = usados.find((m) => !permitidos.includes(m));
      if (invalido) {
        throw new BadRequestException(
          `La oferta "${o.nombre}" solo vale pagando con ${legibles}. Se está usando "${invalido}".`,
        );
      }
    }
  }

  private async validarCredito(cliente: any, config: any, condicionPago: string, total: number) {
    if (condicionPago !== 'cuenta_corriente') return;
    if (!config.ctaCteHabilitada) throw new BadRequestException('La venta en cuenta corriente está deshabilitada en la configuración.');
    if (!cliente.ctaCteHabilitada) throw new BadRequestException(`${cliente.nombre} no tiene cuenta corriente habilitada.`);
    if (config.ctaCteBloquearSuperado && cliente.limiteCredito > 0) {
      const { saldo } = await this.cuenta(cliente.id);
      if (saldo + total > cliente.limiteCredito + 1e-9) {
        throw new BadRequestException(
          `Supera el límite de crédito. Saldo $${saldo.toFixed(2)} + $${total.toFixed(2)} > límite $${cliente.limiteCredito.toFixed(2)}.`,
        );
      }
    }
  }

  /**
   * Turno de caja. Se exige solo al CONTADO: es la venta que mueve dinero
   * físico y por lo tanto la que hay que arquear. Una venta en cuenta corriente
   * no toca el cajón (el efectivo entra después, con el recibo), así que no
   * debería frenarse por no haber abierto caja — igual se cuelga del turno
   * abierto si lo hay, para que aparezca en el arqueo.
   */
  private async resolverTurno(cajaSesionId: number | undefined, sucursalId: number, condicionPago: string, config: any) {
    // El id que manda el punto de venta es solo una PISTA: pudo quedar viejo
    // (se cerró la caja en otra pantalla, se resembró la base). Si no sirve, se
    // resuelve por sucursal en vez de hacer fracasar el cobro con un
    // "turno inexistente" que el cajero no puede interpretar.
    if (cajaSesionId) {
      const sugerido = await this.caja.getOpcional(cajaSesionId);
      if (sugerido && sugerido.estado === 'abierta' && sugerido.sucursalId === sucursalId) return sugerido;
    }
    return this.caja.exigirTurno(sucursalId, condicionPago === 'contado' && !!config.cajaObligatoria);
  }

  /** Correlativo siguiente para ese tipo y punto de venta. */
  private async siguienteNumero(tx: any, tipo: string, puntoVenta: string) {
    const [r] = await tx
      .select({ max: sql<number>`coalesce(max(${ventas.numero}), 0)` })
      .from(ventas)
      .where(and(eq(ventas.tipo, tipo as any), eq(ventas.puntoVenta, puntoVenta)));
    return (Number(r?.max) || 0) + 1;
  }

  /* ------------------------------ Escritura ------------------------------ */

  /**
   * "SOLO PARA FRACCIONAR": el granel marcado así no se vende suelto — existe
   * únicamente para convertirse en paquetes (la Pimienta de Jamaica llega 1 kg
   * y se fracciona entera). El POS ya no lo ofrece suelto; este es el candado
   * de verdad, porque lo que se acepta no puede depender de lo que se ofrece.
   * Sus presentaciones se venden normal (llevan presentacionId).
   */
  private async validarSoloFraccionar(items: Array<{ productoId: number; presentacionId?: number | null }>) {
    const sueltos = [...new Set((items ?? []).filter((it) => !it.presentacionId).map((it) => it.productoId))];
    if (!sueltos.length) return;
    const [prohibido] = await this.db.select({ nombre: productos.nombre }).from(productos)
      .where(and(inArray(productos.id, sueltos), eq(productos.soloFraccionar, true))).limit(1);
    if (prohibido) {
      throw new BadRequestException(
        `${prohibido.nombre} no se vende suelto: es solo para fraccionar. Vendé sus paquetes.`,
      );
    }
  }

  async create(dto: CreateVentaDto) {
    const config = await this.cfg.get('ventas');
    const cliente = dto.clienteId ? await this.cli.get(dto.clienteId) : await this.cli.consumidorFinal();
    if (!cliente.activo) throw new BadRequestException('El cliente está desactivado.');

    const esBorrador = dto.estado === 'borrador';
    if (!esBorrador && !dto.items?.length) throw new BadRequestException('Agregá al menos un ítem.');

    // También en el borrador: un ticket que nunca va a poder confirmarse no
    // tiene por qué poder armarse.
    await this.validarSoloFraccionar(dto.items ?? []);

    const tot = this.calcularTotales(dto.items ?? [], dto.extras ?? []);
    const condicionPago = dto.condicionPago ?? 'contado';
    const sucursalId = dto.sucursalId ?? cliente.sucursalId ?? null;
    if (!sucursalId) throw new BadRequestException('Indicá la sucursal de la venta.');

    const tipo = dto.tipo ?? (tipoVentaPara(cliente, config) as (typeof TIPOS)[number]);
    const puntoVenta = String(config.puntoVenta || '0001');
    const fecha = dto.fecha ? new Date(dto.fecha) : new Date();

    /* -- Borrador: queda abierto, sin número, sin stock, sin caja -- */
    if (esBorrador) {
      const [v] = await this.db.insert(ventas).values({
        tipo, puntoVenta, numero: null, fecha, clienteId: cliente.id, sucursalId,
        usuarioId: dto.usuarioId ?? null, cajaSesionId: null,
        estado: 'borrador', condicionPago, vencimientoPago: null,
        presupuestoId: dto.presupuestoId ?? null,
        listaPrecio: dto.listaPrecio ?? '',
        subtotalNeto: tot.subtotalNeto, descuentoTotal: tot.descuentoTotal,
        ivaTotal: tot.ivaTotal, total: tot.total,
        observaciones: dto.observaciones ?? '',
      }).returning();

      if (tot.items.length) await this.db.insert(ventaItems).values(tot.items.map((it) => ({ ...it, ventaId: v.id })));
      if (tot.extras.length) await this.db.insert(ventaExtras).values(tot.extras.map((e) => ({ ...e, ventaId: v.id })));
      return this.get(v.id);
    }

    /* -- Confirmada de una: el camino de la API y del seed -- */
    const pagos = this.validarPagos(condicionPago, dto.pagos ?? [], tot.total);
    this.validarMediosPagoMonto(tot.items, condicionPago, pagos, config);
    await this.validarMediosPagoOfertas(tot.items, condicionPago, pagos);
    await this.validarCredito(cliente, config, condicionPago, tot.total);
    const turno = await this.resolverTurno(dto.cajaSesionId, sucursalId, condicionPago, config);

    const vencimientoPago = condicionPago === 'cuenta_corriente' && cliente.diasPlazo > 0
      ? new Date(fecha.getTime() + cliente.diasPlazo * 86400000)
      : null;

    const id = await this.db.transaction(async (tx) => {
      const numero = await this.siguienteNumero(tx, tipo, puntoVenta);
      const [v] = await tx.insert(ventas).values({
        tipo, puntoVenta, numero, fecha, clienteId: cliente.id, sucursalId,
        usuarioId: dto.usuarioId ?? null, cajaSesionId: turno?.id ?? null,
        estado: 'confirmada', condicionPago, vencimientoPago,
        presupuestoId: dto.presupuestoId ?? null,
        listaPrecio: dto.listaPrecio ?? '',
        subtotalNeto: tot.subtotalNeto, descuentoTotal: tot.descuentoTotal,
        ivaTotal: tot.ivaTotal, total: tot.total,
        observaciones: dto.observaciones ?? '',
      }).returning();

      await tx.insert(ventaItems).values(tot.items.map((it) => ({ ...it, ventaId: v.id })));
      if (tot.extras.length) await tx.insert(ventaExtras).values(tot.extras.map((e) => ({ ...e, ventaId: v.id })));
      if (pagos.length) {
        await tx.insert(ventaPagos).values(pagos.map((p) => ({
          ventaId: v.id, medio: p.medio, importe: money(p.importe), referencia: p.referencia ?? '',
        })));
      }

      if (dto.presupuestoId) {
        await this.cerrarPresupuesto(tx, Number(dto.presupuestoId), v.id, sucursalId, dto.usuarioId);
      }

      await this.inv.egresarStockItems(tx, {
        sucursalId,
        usuarioId: dto.usuarioId,
        permitirNegativo: !!config.permitirStockNegativo,
        descripcion: `Venta ${puntoVenta}-${String(numero).padStart(8, '0')} · ${cliente.nombre}`,
        items: tot.items,
      });
      return v.id;
    });

    return this.get(id);
  }

  /**
   * Venta que CIERRA un presupuesto (dentro de la transacción de la venta):
   * reclama el estado — dos cierres simultáneos → uno gana — y LIBERA la
   * reserva ANTES del egreso, así la mercadería apartada vuelve a disponible
   * y sale por la venta, aunque el cajero haya agregado o sacado renglones
   * respecto de lo cotizado.
   */
  private async cerrarPresupuesto(tx: any, presupuestoId: number, ventaId: number, sucursalId: number, usuarioId?: number | null) {
    const [pre] = await tx.select().from(presupuestos).where(eq(presupuestos.id, presupuestoId)).limit(1);
    if (!pre) throw new BadRequestException('El presupuesto ya no existe.');
    if (pre.estado !== 'confirmado') throw new BadRequestException('Solo se cierra un presupuesto confirmado — actualizá la pantalla.');
    const gano = await tx.update(presupuestos)
      .set({ estado: 'cerrado', ventaId })
      .where(and(eq(presupuestos.id, pre.id), eq(presupuestos.estado, 'confirmado')))
      .returning({ id: presupuestos.id });
    if (!gano.length) throw new BadRequestException('El presupuesto cambió de estado — actualizá la pantalla.');
    if (pre.reservado) {
      const preItems = await tx.select().from(presupuestoItems)
        .where(eq(presupuestoItems.presupuestoId, pre.id));
      await this.inv.reservarItems(tx, {
        sucursalId, usuarioId: usuarioId ?? null, liberar: true,
        descripcion: `${pre.codigo}: cerrado en venta`,
        items: preItems,
      });
    }
  }

  /** Solo un borrador se edita: una venta emitida se anula o se corrige por NC. */
  private async exigirBorrador(id: number) {
    const v = await this.get(id);
    if (v.estado !== 'borrador') {
      throw new BadRequestException('La venta ya está emitida: no se puede modificar.');
    }
    return v;
  }

  /**
   * Reemplaza el contenido del borrador. El punto de venta lo llama con el
   * ticket completo (no con un delta): así el estado del servidor siempre es
   * exactamente lo que el cajero ve en pantalla.
   */
  async actualizar(id: number, dto: CreateVentaDto) {
    const actual = await this.exigirBorrador(id);
    const config = await this.cfg.get('ventas');
    const cliente = dto.clienteId ? await this.cli.get(dto.clienteId) : await this.cli.get(actual.clienteId);
    const tot = this.calcularTotales(dto.items ?? [], dto.extras ?? []);

    await this.db.transaction(async (tx) => {
      await tx.update(ventas).set({
        clienteId: cliente.id,
        usuarioId: dto.usuarioId ?? actual.usuarioId,
        condicionPago: dto.condicionPago ?? actual.condicionPago,
        listaPrecio: dto.listaPrecio ?? '',
        observaciones: dto.observaciones ?? actual.observaciones,
        subtotalNeto: tot.subtotalNeto, descuentoTotal: tot.descuentoTotal,
        ivaTotal: tot.ivaTotal, total: tot.total,
      }).where(eq(ventas.id, id));

      await tx.delete(ventaItems).where(eq(ventaItems.ventaId, id));
      await tx.delete(ventaExtras).where(eq(ventaExtras.ventaId, id));
      if (tot.items.length) await tx.insert(ventaItems).values(tot.items.map((it) => ({ ...it, ventaId: id })));
      if (tot.extras.length) await tx.insert(ventaExtras).values(tot.extras.map((e) => ({ ...e, ventaId: id })));
    });

    return this.get(id);
  }

  /**
   * Cierra el borrador: recién acá se asigna número, se descuenta stock y se
   * registran los pagos. Los ítems son los que ya están guardados, para que lo
   * que se confirma sea exactamente lo último que se guardó.
   */
  async confirmar(id: number, dto: ConfirmarVentaDto) {
    const borrador = await this.exigirBorrador(id);
    if (!borrador.items.length) throw new BadRequestException('El ticket está vacío.');
    // El borrador pudo nacer antes de que el producto se marcara "solo para
    // fraccionar": se re-valida acá, que es donde el stock de verdad sale.
    await this.validarSoloFraccionar(borrador.items);

    const config = await this.cfg.get('ventas');
    const cliente = await this.cli.get(borrador.clienteId);
    const condicionPago = dto.condicionPago ?? borrador.condicionPago;
    const sucursalId = borrador.sucursalId!;

    const pagos = this.validarPagos(condicionPago, dto.pagos ?? [], borrador.total);
    this.validarMediosPagoMonto(borrador.items, condicionPago, pagos, config);
    await this.validarMediosPagoOfertas(borrador.items, condicionPago, pagos);
    await this.validarCredito(cliente, config, condicionPago, borrador.total);
    const turno = await this.resolverTurno(dto.cajaSesionId, sucursalId, condicionPago, config);

    const fecha = new Date();
    const vencimientoPago = condicionPago === 'cuenta_corriente' && cliente.diasPlazo > 0
      ? new Date(fecha.getTime() + cliente.diasPlazo * 86400000)
      : null;

    // Liquidar o facturar. Cada tipo lleva su propio correlativo (el índice
    // único es por tipo + punto de venta), que es como debe ser fiscalmente.
    const tipo = dto.tipo === 'factura'
      ? (letraFacturaPara(cliente, config) as any)
      : dto.tipo === 'ticket' ? 'ticket' : borrador.tipo;

    await this.db.transaction(async (tx) => {
      const numero = await this.siguienteNumero(tx, tipo, borrador.puntoVenta);
      await tx.update(ventas).set({
        tipo, numero, fecha, estado: 'confirmada', condicionPago, vencimientoPago,
        cajaSesionId: turno?.id ?? null,
        usuarioId: dto.usuarioId ?? borrador.usuarioId,
        observaciones: dto.observaciones ?? borrador.observaciones,
      }).where(eq(ventas.id, id));

      if (pagos.length) {
        await tx.insert(ventaPagos).values(pagos.map((p) => ({
          ventaId: id, medio: p.medio, importe: money(p.importe), referencia: p.referencia ?? '',
        })));
      }

      // El borrador nació de un presupuesto: este cobro lo cierra.
      if (borrador.presupuestoId) {
        await this.cerrarPresupuesto(tx, borrador.presupuestoId, id, sucursalId, dto.usuarioId ?? borrador.usuarioId);
      }

      await this.inv.egresarStockItems(tx, {
        sucursalId,
        usuarioId: dto.usuarioId ?? borrador.usuarioId,
        permitirNegativo: !!config.permitirStockNegativo,
        descripcion: `Venta ${borrador.puntoVenta}-${String(numero).padStart(8, '0')} · ${cliente.nombre}`,
        items: borrador.items,
      });
    });

    return this.get(id);
  }

  /** Pasa la venta abierta a otro vendedor (cambio de turno, mostrador ocupado). */
  async delegar(id: number, usuarioId: number) {
    await this.exigirBorrador(id);
    const [u] = await this.db.select().from(usuarios).where(eq(usuarios.id, usuarioId)).limit(1);
    if (!u) throw new BadRequestException('Usuario inexistente.');
    await this.db.update(ventas).set({ usuarioId }).where(eq(ventas.id, id));
    return this.get(id);
  }

  /** Descarta un borrador. No dejó rastro en stock ni en numeración. */
  async descartar(id: number) {
    await this.exigirBorrador(id);
    await this.db.delete(ventas).where(eq(ventas.id, id));
    return { ok: true };
  }

  /**
   * Anulación: devuelve la mercadería al stock. Se bloquea si ya hay una
   * cobranza imputada — primero se anula la cobranza, si no el saldo del
   * cliente queda inconsistente.
   */
  async anular(id: number, usuarioId?: number) {
    const v = await this.get(id);
    if (v.estado === 'anulada') throw new BadRequestException('La venta ya está anulada.');
    if (v.estado === 'borrador') throw new BadRequestException('Es una venta abierta: descartala en vez de anularla.');
    if (v.cobrado > 0.009) throw new BadRequestException('Tiene cobranzas imputadas. Anulá primero la cobranza.');

    await this.db.transaction(async (tx) => {
      await tx.update(ventas).set({ estado: 'anulada' }).where(eq(ventas.id, id));
      if (v.sucursalId) {
        await this.inv.reingresarStockItems(tx, {
          sucursalId: v.sucursalId,
          usuarioId,
          descripcion: `Anulación venta ${v.puntoVenta}-${String(v.numero ?? 0).padStart(8, '0')}`,
          items: v.items,
        });
      }
    });
    return this.get(id);
  }

  /**
   * Snapshot del módulo Ventas: SOLO catálogos chicos. Deliberadamente no trae
   * ventas ni cobranzas (crecen sin techo) — esas se piden paginadas por panel.
   */
  async bootstrap() {
    await this.cli.consumidorFinal(); // garantiza el cliente genérico
    const [cls, cfg, sucs, usrsRaw, rolesCat, asignaciones, cat, marcasCat] = await Promise.all([
      this.db.select().from(clientes).orderBy(clientes.nombre),
      this.cfg.get('ventas'),
      this.db.select().from(sucursales).orderBy(sucursales.nombre),
      this.db.select().from(usuarios).orderBy(usuarios.nombre),
      this.db.select().from(roles),
      this.db.select().from(clienteListas),
      this.listas.catalogo(),
      // Las marcas del catálogo, para cargar una regla eligiéndola de la lista.
      this.db.select({ id: marcas.id, nombre: marcas.nombre })
        .from(marcas).where(eq(marcas.activa, true)).orderBy(marcas.nombre),
    ]);
    // Usuarios SIN hash y con su rol dinámico resuelto (clave + permisos).
    const rolDe = new Map(rolesCat.map((r) => [r.id, r]));
    const usrs = usrsRaw.map((u) => {
      const r = rolDe.get(u.rolId);
      return {
        id: u.id, nombre: u.nombre, activo: u.activo, rolId: u.rolId,
        rolClave: r?.clave ?? '', rolNombre: r?.nombre ?? '', permisos: r?.permisos ?? [],
      };
    });
    // Las listas predeterminadas de cada cliente en UNA consulta, no una por
    // cliente: el POS las necesita para cotizar y cambia de cliente en vivo.
    return {
      clientes: cls.map((c) => ({
        ...c,
        listas: asignaciones.filter((a) => a.clienteId === c.id).map((a) => a.listaId),
      })),
      config: cfg,
      sucursales: sucs,
      usuarios: usrs,
      listasCatalogo: cat,
      marcas: marcasCat,
    };
  }
}

@Controller('ventas')
export class VentasController {
  constructor(private readonly svc: VentasService) {}

  // Las rutas literales van ANTES de ':id' para que Nest no las tome como id.
  @Get('bootstrap') bootstrap() { return this.svc.bootstrap(); }

  @Get('catalogo')
  catalogo(@Query('sucursalId', ParseIntPipe) sucursalId: number) {
    return this.svc.catalogo(sucursalId);
  }

  @Get('cuenta/:clienteId')
  cuenta(@Param('clienteId', ParseIntPipe) clienteId: number) { return this.svc.cuenta(clienteId); }

  @Get()
  list(
    @Query('clienteId') clienteId?: string,
    @Query('sucursalId') sucursalId?: string,
    @Query('estado') estado?: string,
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('limit') limit?: string,
    @Query('incluirItems') incluirItems?: string,
  ) {
    return this.svc.list({
      clienteId: clienteId ? Number(clienteId) : undefined,
      sucursalId: sucursalId ? Number(sucursalId) : undefined,
      estado, desde, hasta,
      limit: limit ? Number(limit) : undefined,
      incluirItems: incluirItems === 'true',
    });
  }

  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }
  @Post() create(@Body() dto: CreateVentaDto) { return this.svc.create(dto); }
  @Put(':id') actualizar(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateVentaDto) { return this.svc.actualizar(id, dto); }
  @Post(':id/confirmar') confirmar(@Param('id', ParseIntPipe) id: number, @Body() dto: ConfirmarVentaDto) { return this.svc.confirmar(id, dto); }
  @Post(':id/delegar') delegar(@Param('id', ParseIntPipe) id: number, @Body() dto: DelegarVentaDto) { return this.svc.delegar(id, dto.usuarioId); }
  @Post(':id/anular') anular(@Param('id', ParseIntPipe) id: number) { return this.svc.anular(id); }
  @Delete(':id') descartar(@Param('id', ParseIntPipe) id: number) { return this.svc.descartar(id); }
}

@Module({
  imports: [InventarioModule, ConfiguracionModule, ClientesModule, CajaModule, ListasModule, OfertasModule],
  controllers: [VentasController],
  providers: [VentasService],
  exports: [VentasService],
})
export class VentasModule {}
