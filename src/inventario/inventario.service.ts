import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, lte, or, desc, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  productos, presentaciones, productoProveedores, productoListas, listasVenta, proveedores, roles, sucursales, usuarios,
  stock, movimientos, transferencias, transferenciaItems, transferenciaHist, incidencias,
  comprobantes, comprobanteItems, facturaLecturas,
  marcas, categorias, subcategorias, etiquetas, productoEtiquetas,
} from '../db/schema';
import { ConfiguracionService } from '../configuracion/configuracion.module';
import { ListasService } from '../listas/listas.module';
import { costoNetoEntry, costosFormato, formatoActivo, precioLista, precioPresentacion, precioVentaFila } from './pricing';

/** Metadatos de tipos de movimiento (dir: +1 entrada, −1 salida, 0 contextual). */
const TIPOS_MOV: Record<string, { label: string; dir: number }> = {
  compra: { label: 'Compra', dir: 1 },
  fraccionamiento: { label: 'Fraccionamiento', dir: 0 },
  venta_granel: { label: 'Venta a granel', dir: -1 },
  venta_fraccionada: { label: 'Venta fraccionada', dir: -1 },
  devolucion: { label: 'Devolución', dir: 1 },
  ajuste: { label: 'Ajuste', dir: 0 },
  merma: { label: 'Merma', dir: -1 },
  vencido: { label: 'Producto vencido', dir: -1 },
  defectuoso: { label: 'Producto defectuoso', dir: -1 },
  transferencia: { label: 'Transferencia', dir: 0 },
  envio_cafeteria: { label: 'Envío a Cafetería', dir: -1 },
};

type EstadoStock = 'disponible' | 'comprometido' | 'retenido' | 'defectuoso' | 'vencido' | 'en_transito';
type Coord = { productoId: number; sucursalId: number; presentacionId: number | null; estado: EstadoStock };

/**
 * Motor de inventario. Toda la lógica de stock, operaciones, transferencias e
 * incidencias. Cada operación que muta stock corre dentro de una transacción y
 * registra un movimiento. Los errores de validación lanzan BadRequestException.
 */
@Injectable()
export class InventarioService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly cfg: ConfiguracionService,
    private readonly listas: ListasService,
  ) {}

  /* ------------------------- Utilidades de dominio ------------------------- */
  private fmtTam(kg: number): string {
    return kg < 1 ? `${Math.round(kg * 1000)} g` : `${kg} kg`;
  }
  private unidadDe(tipo: string, presId: number | null): 'kg' | 'u' {
    return tipo === 'granel' && !presId ? 'kg' : 'u';
  }
  private fmtCant(tipo: string, presId: number | null, cant: number): string {
    if (this.unidadDe(tipo, presId) === 'kg') return `${cant} kg`;
    return `${Math.round(cant)} ${presId ? 'paq.' : 'u.'}`;
  }

  /* ------------------------- Núcleo de stock ------------------------- */
  private coordWhere(c: Coord) {
    return and(
      eq(stock.productoId, c.productoId),
      eq(stock.sucursalId, c.sucursalId),
      c.presentacionId == null ? isNull(stock.presentacionId) : eq(stock.presentacionId, c.presentacionId),
      eq(stock.estado, c.estado),
    );
  }
  private async getEntry(tx: any, c: Coord) {
    const rows = await tx.select().from(stock).where(this.coordWhere(c)).limit(1);
    return rows[0];
  }
  private async getOrCreate(tx: any, c: Coord) {
    const found = await this.getEntry(tx, c);
    if (found) return found;
    const [created] = await tx.insert(stock).values({
      productoId: c.productoId, sucursalId: c.sucursalId, presentacionId: c.presentacionId, estado: c.estado, cantidad: 0,
    }).returning();
    return created;
  }
  /**
   * Los deltas de stock son RELATIVOS en SQL (`cantidad = cantidad + δ`), nunca
   * un valor absoluto calculado en memoria. Con el valor absoluto, dos
   * operaciones concurrentes sobre la misma fila leían el mismo número y una
   * pisaba a la otra en silencio — el clásico lost update, y en el stock eso
   * es plata. El delta relativo lo resuelve la base, que para eso está.
   */
  private async addDelta(tx: any, c: Coord, delta: number) {
    const e = await this.getOrCreate(tx, c);
    await tx.execute(sql`UPDATE stock SET cantidad = cantidad + ${delta} WHERE id = ${e.id}`);
  }
  private async cant(tx: any, productoId: number, sucursalId: number, presentacionId: number | null, estado: EstadoStock) {
    const e = await this.getEntry(tx, { productoId, sucursalId, presentacionId, estado });
    return e ? e.cantidad : 0;
  }
  private async move(tx: any, base: Omit<Coord, 'estado'>, desde: EstadoStock, hacia: EstadoStock, c: number) {
    const from = await this.getOrCreate(tx, { ...base, estado: desde });
    if (from.cantidad + 1e-9 < c) return false;
    // El WHERE re-verifica el saldo EN el UPDATE: si otra transacción se llevó
    // el stock entre la lectura y acá, esto no descuenta de más — devuelve
    // false y el llamador aborta.
    const res: any = await tx.execute(
      sql`UPDATE stock SET cantidad = cantidad - ${c} WHERE id = ${from.id} AND cantidad >= ${c} - 1e-9`,
    );
    if (!res.rowCount) return false;
    const to = await this.getOrCreate(tx, { ...base, estado: hacia });
    await tx.execute(sql`UPDATE stock SET cantidad = cantidad + ${c} WHERE id = ${to.id}`);
    return true;
  }

  /* ------------------------- Costos / precios ------------------------- */

  /**
   * Contexto para cotizar un producto con la lista BASE (el piso del sistema).
   * Los movimientos internos —fraccionamiento, mermas, valuaciones— no tienen
   * cliente ni ticket, así que no hay condición que evaluar: van siempre al
   * piso. El precio por cliente lo resuelve el punto de venta.
   */
  private async ctxPrecio(tx: any, productoId: number) {
    const [prod] = await tx.select().from(productos).where(eq(productos.id, productoId)).limit(1);
    if (!prod) return { cn: 0, iva: 0, markup: 0, tieneLista: false, redondeo: 0 };
    const [provs, formato, cfg, listas] = await Promise.all([
      tx.select().from(productoProveedores).where(eq(productoProveedores.productoId, productoId)),
      tx.select().from(productoListas).where(eq(productoListas.productoId, productoId)),
      this.cfg.get('ventas'),
      tx.select().from(listasVenta).where(eq(listasVenta.activa, true))
        .orderBy(asc(listasVenta.orden), asc(listasVenta.id)),
    ]);
    const activas = new Set(listas.map((l: any) => l.id));
    const suyas = formato.filter((f: any) => activas.has(f.listaId));
    const base = listas.find((l: any) => l.id === cfg.listaBaseId) || listas[0] || null;
    // La del piso si el producto la tiene; si no, la de peor orden entre las
    // suyas (la más cara), que es lo que se cobra sin habilitar nada.
    const fila = suyas.find((f: any) => f.listaId === base?.id)
      ?? [...suyas].sort((a: any, b: any) => {
        const oa = listas.findIndex((l: any) => l.id === a.listaId);
        const ob = listas.findIndex((l: any) => l.id === b.listaId);
        return ob - oa;
      })[0] ?? null;
    const active = formatoActivo(provs as any[]);
    const cn = costoNetoEntry(active, prod.iva);
    // Markup EQUIVALENTE de la fila: con precio definido el markup no manda,
    // así que se deriva desde el neto unitario del formato.
    const pv = fila ? precioVentaFila(cn, fila as any, { iva: prod.iva, redondeo: cfg.redondeoPrecio }) : null;
    return {
      cn,
      iva: prod.iva,
      markup: pv && cn > 0 ? ((pv.netoUnitario / cn) - 1) * 100 : (fila?.markup ?? 0),
      tieneLista: !!fila,
      redondeo: cfg.redondeoPrecio,
    };
  }

  private async precioBase(tx: any, productoId: number): Promise<number> {
    const { cn, iva, markup, tieneLista, redondeo } = await this.ctxPrecio(tx, productoId);
    return tieneLista ? precioLista(cn, markup, { iva, redondeo }) : cn;
  }

  private async precioPres(tx: any, presentacionId: number): Promise<number> {
    const [pres] = await tx.select().from(presentaciones).where(eq(presentaciones.id, presentacionId)).limit(1);
    if (!pres) return 0;
    // El markup lo pone la lista; la presentación solo agrega su recargo.
    const { cn, iva, markup, redondeo } = await this.ctxPrecio(tx, pres.productoId);
    return precioPresentacion(cn, pres, markup, { iva, redondeo });
  }

  /* ------------------------- Movimiento ------------------------- */
  private async mov(tx: any, campos: any) {
    const [m] = await tx.insert(movimientos).values(campos).returning();
    return m;
  }

  private async getProducto(tx: any, id: number) {
    const [p] = await tx.select().from(productos).where(eq(productos.id, id)).limit(1);
    return p;
  }
  private async distribuidoraId(tx: any): Promise<number | null> {
    const [s] = await tx.select().from(sucursales).where(eq(sucursales.tipo, 'distribuidora')).limit(1);
    return s ? s.id : null;
  }

  /* ============================ OPERACIONES ============================ */

  /** Compra: ingresa mercadería, suma stock disponible y marca el proveedor activo. */
  async opCompra(o: any) {
    return this.db.transaction(async (tx) => {
      const prod = await this.getProducto(tx, o.productoId);
      if (!prod) throw new BadRequestException('Producto inválido.');
      const c = Number(o.cantidad);
      if (!(c > 0)) throw new BadRequestException('Ingresá una cantidad mayor a 0.');
      const sucId = o.sucursalId || (await this.distribuidoraId(tx));
      if (!sucId) throw new BadRequestException('No hay sucursal de ingreso.');

      await this.addDelta(tx, { productoId: prod.id, sucursalId: sucId, presentacionId: null, estado: 'disponible' }, c);

      let provNombre = '';
      if (o.proveedorId) {
        const [prov] = await tx.select().from(proveedores).where(eq(proveedores.id, o.proveedorId)).limit(1);
        if (prov) {
          provNombre = prov.nombre;
          const formato = await this.formatoDeProveedor(tx, prod.id, prov.id);
          await this.marcarFormatoActivo(tx, prod.id, formato.id);
        }
      }
      const venc = o.fechaVencimiento ? new Date(o.fechaVencimiento) : null;
      const m = await this.mov(tx, {
        tipo: 'compra', productoId: prod.id, sucursalId: sucId, signo: 1, cantidad: c,
        unidad: this.unidadDe(prod.tipo, null), estadoHacia: 'disponible', usuarioId: o.usuarioId ?? null,
        vencimiento: venc, proveedorNombre: provNombre, motivo: o.motivo || (provNombre ? `Prov: ${provNombre}` : ''),
        descripcion: `Compra +${this.fmtCant(prod.tipo, null, c)}${provNombre ? ' · ' + provNombre : ''}`,
      });
      return { ok: true, movimiento: m };
    });
  }

  /** Venta (granel / fraccionada / unidad). Precio computado del proveedor activo. */
  async opVenta(o: any) {
    return this.db.transaction(async (tx) => {
      const prod = await this.getProducto(tx, o.productoId);
      if (!prod) throw new BadRequestException('Producto inválido.');
      const presId = o.presId || null;
      const sucId = o.sucursalId;
      const c = Number(o.cantidad);
      if (!(c > 0)) throw new BadRequestException('Ingresá la cantidad.');
      const disp = await this.cant(tx, prod.id, sucId, presId, 'disponible');
      if (c > disp + 1e-9) throw new BadRequestException(`Stock insuficiente. Disponible: ${this.fmtCant(prod.tipo, presId, disp)}.`);
      await this.addDelta(tx, { productoId: prod.id, sucursalId: sucId, presentacionId: presId, estado: 'disponible' }, -c);
      const precioU = presId ? await this.precioPres(tx, presId) : await this.precioBase(tx, prod.id);
      const importe = c * precioU;
      const esGranelSuelto = prod.tipo === 'granel' && !presId;
      const tipo = esGranelSuelto ? 'venta_granel' : 'venta_fraccionada';
      const m = await this.mov(tx, {
        tipo, productoId: prod.id, sucursalId: sucId, presentacionId: presId, signo: -1, cantidad: c,
        unidad: this.unidadDe(prod.tipo, presId), estadoDesde: 'disponible', usuarioId: o.usuarioId ?? null,
        descripcion: `${esGranelSuelto ? 'Venta suelta ' : 'Venta '}${this.fmtCant(prod.tipo, presId, c)} · $${importe.toFixed(2)}`,
      });
      return { ok: true, importe, movimiento: m };
    });
  }

  /** Fraccionamiento: descuenta granel y crea paquetes (misma sucursal). */
  async opFraccionar(o: any) {
    return this.db.transaction(async (tx) => {
      const prod = await this.getProducto(tx, o.productoId);
      if (!prod || prod.tipo !== 'granel') throw new BadRequestException('Solo productos a granel se fraccionan.');
      const sucId = o.sucursalId;
      const presList = await tx.select().from(presentaciones).where(eq(presentaciones.productoId, prod.id));
      const byId = new Map<number, any>(presList.map((p: any) => [p.id, p]));
      let total = 0;
      const asign: { pres: any; q: number }[] = [];
      for (const a of o.asignaciones || []) {
        const pres = byId.get(Number(a.presId));
        const q = Math.round(Number(a.cant) || 0);
        if (pres && q > 0) { total += q * pres.tamKg; asign.push({ pres, q }); }
      }
      if (total <= 0) throw new BadRequestException('Indicá al menos un paquete a fraccionar.');
      const disp = await this.cant(tx, prod.id, sucId, null, 'disponible');
      if (total > disp + 1e-9) throw new BadRequestException(`No alcanza el granel disponible. Disponible: ${disp} kg, necesario: ${total} kg.`);
      await this.addDelta(tx, { productoId: prod.id, sucursalId: sucId, presentacionId: null, estado: 'disponible' }, -total);
      for (const { pres, q } of asign) {
        await this.addDelta(tx, { productoId: prod.id, sucursalId: sucId, presentacionId: pres.id, estado: 'disponible' }, q);
      }
      const detalle = asign.map(({ pres, q }) => `${q}×${this.fmtTam(pres.tamKg)}`).join(', ');
      const m = await this.mov(tx, {
        tipo: 'fraccionamiento', productoId: prod.id, sucursalId: sucId, signo: 0, cantidad: total, unidad: 'kg',
        presLabel: 'Granel → paquetes', usuarioId: o.usuarioId ?? null,
        descripcion: `Fraccionó ${total} kg en ${detalle}`,
      });
      return { ok: true, movimiento: m };
    });
  }

  /** Movimiento simple: devolución (+), ajuste (±), merma/vencido/defectuoso (−). */
  async opSimple(o: any) {
    return this.db.transaction(async (tx) => {
      const prod = await this.getProducto(tx, o.productoId);
      if (!prod) throw new BadRequestException('Producto inválido.');
      const meta = TIPOS_MOV[o.tipo];
      if (!meta) throw new BadRequestException('Tipo inválido.');
      const presId = o.presId || null;
      const sucId = o.sucursalId;
      const c = Number(o.cantidad);
      if (!(c > 0)) throw new BadRequestException('Ingresá una cantidad mayor a 0.');
      let signo = meta.dir;
      if (signo === 0) signo = Number(o.signo) === 1 ? 1 : -1;
      if (signo < 0) {
        const disp = await this.cant(tx, prod.id, sucId, presId, 'disponible');
        if (c > disp + 1e-9) throw new BadRequestException(`Stock disponible insuficiente. Disponible: ${this.fmtCant(prod.tipo, presId, disp)}.`);
      }
      await this.addDelta(tx, { productoId: prod.id, sucursalId: sucId, presentacionId: presId, estado: 'disponible' }, signo * c);
      let estadoHacia: EstadoStock | null = signo > 0 ? 'disponible' : null;
      if (o.tipo === 'vencido') { await this.addDelta(tx, { productoId: prod.id, sucursalId: sucId, presentacionId: presId, estado: 'vencido' }, c); estadoHacia = 'vencido'; }
      else if (o.tipo === 'defectuoso') { await this.addDelta(tx, { productoId: prod.id, sucursalId: sucId, presentacionId: presId, estado: 'defectuoso' }, c); estadoHacia = 'defectuoso'; }
      const m = await this.mov(tx, {
        tipo: o.tipo, productoId: prod.id, sucursalId: sucId, presentacionId: presId, signo, cantidad: c,
        unidad: this.unidadDe(prod.tipo, presId), estadoDesde: signo < 0 ? 'disponible' : null, estadoHacia,
        usuarioId: o.usuarioId ?? null, motivo: o.motivo || '',
        descripcion: `${meta.label} ${signo > 0 ? '+' : '−'}${this.fmtCant(prod.tipo, presId, c)}${o.motivo ? ' · ' + o.motivo : ''}`,
      });
      return { ok: true, movimiento: m };
    });
  }

  /**
   * Ingreso de stock por los ítems de un comprobante de recepción (remito o
   * factura con recepción). Corre dentro de la transacción `tx` del comprobante.
   * Marca el proveedor como activo y crea el costo si aún no existía.
   */
  async ingresarStockItems(tx: any, o: any) {
    const distinct = new Set<number>();
    for (const it of o.items || []) {
      const presId = it.presentacionId || null;
      const cantidad = Number(it.cantidad) || 0;
      if (cantidad <= 0) continue;
      await this.addDelta(tx, { productoId: it.productoId, sucursalId: o.sucursalId, presentacionId: presId, estado: 'disponible' }, cantidad);
      const prod = await this.getProducto(tx, it.productoId);
      await this.mov(tx, {
        tipo: 'compra', productoId: it.productoId, sucursalId: o.sucursalId, presentacionId: presId, signo: 1,
        cantidad, unidad: this.unidadDe(prod.tipo, presId), estadoHacia: 'disponible', usuarioId: o.usuarioId ?? null,
        proveedorNombre: o.proveedorNombre || '', descripcion: o.descripcion || 'Ingreso por comprobante',
      });
      distinct.add(it.productoId);
    }
    /**
     * Se asegura la entrada producto/proveedor (para poder cargarle costo), pero
     * NO se toca el proveedor activo.
     *
     * El proveedor activo define el costo que manda el PRECIO DE VENTA. Hacerlo
     * automático significaba que una compra ocasional a un proveedor alternativo
     * repriceaba la góndola sin que nadie lo decidiera, y los precios oscilaban
     * según quién había entregado. Ahora esa decisión se toma explícitamente en
     * la recepción (ver `activarProveedor` en comprobantes), y queda auditada.
     *
     * Excepción razonable: si el producto todavía no tiene ningún activo, el
     * primero que entrega lo pasa a ser — no hay alternativa que elegir.
     */
    if (o.proveedorId) {
      for (const productoId of distinct) {
        const it = (o.items || []).find((x: any) => x.productoId === productoId);
        const formato = await this.formatoDeProveedor(tx, productoId, o.proveedorId, Number(it?.costoUnitario) || 0);
        // Solo si el producto todavía no tiene formato que fije el precio: si
        // ya lo tiene, cambiarlo es una decisión y se toma explícitamente
        // (`PreciosService.activarProveedor`, que además lo audita).
        const [conActivo] = await tx.select({ id: productoProveedores.id })
          .from(productoProveedores)
          .where(and(eq(productoProveedores.productoId, productoId), eq(productoProveedores.usarParaPrecio, true)))
          .limit(1);
        if (!conActivo) await this.marcarFormatoActivo(tx, productoId, formato.id);
      }
    }
  }

  /**
   * El formato de compra de un proveedor para un producto; lo crea vacío si no
   * existe. Con varios formatos del mismo proveedor devuelve el primero: la
   * recepción no sabe en qué bulto vino, y elegirlo es trabajo del usuario.
   */
  private async formatoDeProveedor(tx: any, productoId: number, proveedorId: number, costo = 0) {
    const [existente] = await tx.select().from(productoProveedores)
      .where(and(eq(productoProveedores.productoId, productoId), eq(productoProveedores.proveedorId, proveedorId)))
      .orderBy(asc(productoProveedores.id))
      .limit(1);
    if (existente) return existente;
    const [creado] = await tx.insert(productoProveedores)
      .values({ productoId, proveedorId, costo })
      .returning();
    return creado;
  }

  /**
   * Deja UN solo formato marcado como el que fija el precio. Apagar todos antes
   * de encender el elegido es lo que garantiza la unicidad sin necesitar un
   * índice parcial que después haya que sortear en cada alta.
   */
  private async marcarFormatoActivo(tx: any, productoId: number, formatoId: number) {
    await tx.update(productoProveedores).set({ usarParaPrecio: false })
      .where(eq(productoProveedores.productoId, productoId));
    await tx.update(productoProveedores).set({ usarParaPrecio: true })
      .where(eq(productoProveedores.id, formatoId));
  }

  /**
   * Egreso de stock por los ítems de un documento (venta, o devolución a
   * proveedor). Es la operación inversa de `ingresarStockItems` y corre dentro
   * de la transacción del documento, así un faltante aborta el documento entero.
   *
   * `permitirNegativo` viene de la configuración: por defecto se rechaza, porque
   * un inventario en negativo no se recupera más.
   */
  async egresarStockItems(tx: any, o: any) {
    const tipoMov = o.tipoMovimiento || null;
    // Por defecto egresa lo DISPONIBLE; un documento puede egresar otro estado
    // (el envío a Cafetería cierra sacando lo que viajaba en_transito).
    const estado: EstadoStock = o.estado || 'disponible';
    for (const it of o.items || []) {
      const presId = it.presentacionId || null;
      const cantidad = Number(it.cantidad) || 0;
      if (cantidad <= 0) continue;
      const prod = await this.getProducto(tx, it.productoId);
      if (!prod) throw new BadRequestException('Producto inválido en el detalle.');
      const disp = await this.cant(tx, it.productoId, o.sucursalId, presId, estado);
      if (!o.permitirNegativo && cantidad > disp + 1e-9) {
        throw new BadRequestException(
          `Stock insuficiente de ${prod.nombre}. Disponible: ${this.fmtCant(prod.tipo, presId, disp)}.`,
        );
      }
      await this.addDelta(tx, { productoId: it.productoId, sucursalId: o.sucursalId, presentacionId: presId, estado }, -cantidad);
      const esGranelSuelto = prod.tipo === 'granel' && !presId;
      await this.mov(tx, {
        tipo: tipoMov || (esGranelSuelto ? 'venta_granel' : 'venta_fraccionada'),
        productoId: it.productoId, sucursalId: o.sucursalId, presentacionId: presId, signo: -1,
        cantidad, unidad: this.unidadDe(prod.tipo, presId), estadoDesde: estado,
        usuarioId: o.usuarioId ?? null, descripcion: o.descripcion || 'Egreso por documento',
      });
    }
  }

  /**
   * Pone (o devuelve) mercadería EN TRÁNSITO por un documento que la despacha
   * hacia afuera del sistema (el envío a Cafetería). Mientras viaja sigue
   * siendo del origen — si el flete se pierde, la pérdida es de quien despachó
   * y el inventario total no miente. Valida TODO antes de mover.
   */
  async transitarStockItems(tx: any, o: {
    sucursalId: number;
    usuarioId?: number | null;
    descripcion: string;
    tipoMovimiento?: string;
    /** true = la vuelta: en_transito → disponible (anulación del despacho). */
    volver?: boolean;
    items: { productoId: number; presentacionId?: number | null; cantidad: number }[];
  }) {
    const desde: EstadoStock = o.volver ? 'en_transito' : 'disponible';
    const hacia: EstadoStock = o.volver ? 'disponible' : 'en_transito';

    const faltas: string[] = [];
    for (const it of o.items || []) {
      const c = Number(it.cantidad) || 0;
      if (c <= 0) continue;
      const presId = it.presentacionId || null;
      const hay = await this.cant(tx, it.productoId, o.sucursalId, presId, desde);
      if (c > hay + 1e-9) {
        const prod = await this.getProducto(tx, it.productoId);
        faltas.push(`${prod?.nombre ?? '#' + it.productoId}: hace falta ${this.fmtCant(prod?.tipo ?? 'entero', presId, c)}, hay ${this.fmtCant(prod?.tipo ?? 'entero', presId, hay)}`);
      }
    }
    if (faltas.length) throw new BadRequestException(`Stock insuficiente — ${faltas.join(' · ')}`);

    for (const it of o.items || []) {
      const c = Number(it.cantidad) || 0;
      if (c <= 0) continue;
      const presId = it.presentacionId || null;
      const prod = await this.getProducto(tx, it.productoId);
      await this.move(tx, { productoId: it.productoId, sucursalId: o.sucursalId, presentacionId: presId }, desde, hacia, c);
      await this.mov(tx, {
        tipo: o.tipoMovimiento || 'ajuste',
        productoId: it.productoId, sucursalId: o.sucursalId, presentacionId: presId, signo: 0,
        cantidad: c, unidad: this.unidadDe(prod.tipo, presId), estadoDesde: desde, estadoHacia: hacia,
        usuarioId: o.usuarioId ?? null, descripcion: o.descripcion,
      });
    }
  }

  /**
   * Reserva (o libera) stock por un documento que COMPROMETE mercadería sin
   * venderla todavía: un presupuesto confirmado aparta lo pedido
   * (disponible → comprometido) mientras el vendedor arma el pedido, y el
   * cierre en venta o la cancelación lo liberan. Reservar valida TODO antes
   * de mover: el error detalla cada renglón corto.
   */
  async reservarItems(tx: any, o: {
    sucursalId: number;
    usuarioId?: number | null;
    descripcion: string;
    liberar?: boolean;
    items: { productoId: number; presentacionId?: number | null; cantidad: number }[];
  }) {
    const desde: EstadoStock = o.liberar ? 'comprometido' : 'disponible';
    const hacia: EstadoStock = o.liberar ? 'disponible' : 'comprometido';

    if (!o.liberar) {
      const faltas: string[] = [];
      for (const it of o.items || []) {
        const c = Number(it.cantidad) || 0;
        if (c <= 0) continue;
        const presId = it.presentacionId || null;
        const disp = await this.cant(tx, it.productoId, o.sucursalId, presId, 'disponible');
        if (c > disp + 1e-9) {
          const prod = await this.getProducto(tx, it.productoId);
          faltas.push(`${prod?.nombre ?? '#' + it.productoId}: pedido ${this.fmtCant(prod?.tipo ?? 'entero', presId, c)}, disponible ${this.fmtCant(prod?.tipo ?? 'entero', presId, disp)}`);
        }
      }
      if (faltas.length) throw new BadRequestException(`Stock insuficiente para reservar — ${faltas.join(' · ')}`);
    }

    for (const it of o.items || []) {
      const c = Number(it.cantidad) || 0;
      if (c <= 0) continue;
      const presId = it.presentacionId || null;
      const prod = await this.getProducto(tx, it.productoId);
      await this.move(tx, { productoId: it.productoId, sucursalId: o.sucursalId, presentacionId: presId }, desde, hacia, c);
      await this.mov(tx, {
        tipo: 'ajuste', productoId: it.productoId, sucursalId: o.sucursalId, presentacionId: presId, signo: 0,
        cantidad: c, unidad: this.unidadDe(prod.tipo, presId), estadoDesde: desde, estadoHacia: hacia,
        usuarioId: o.usuarioId ?? null, descripcion: o.descripcion,
      });
    }
  }

  /**
   * Reingreso de stock (anulación de venta o nota de crédito con devolución).
   * Contrapartida exacta de `egresarStockItems`.
   */
  async reingresarStockItems(tx: any, o: any) {
    for (const it of o.items || []) {
      const presId = it.presentacionId || null;
      const cantidad = Number(it.cantidad) || 0;
      if (cantidad <= 0) continue;
      const prod = await this.getProducto(tx, it.productoId);
      if (!prod) continue;
      await this.addDelta(tx, { productoId: it.productoId, sucursalId: o.sucursalId, presentacionId: presId, estado: 'disponible' }, cantidad);
      await this.mov(tx, {
        tipo: 'devolucion', productoId: it.productoId, sucursalId: o.sucursalId, presentacionId: presId, signo: 1,
        cantidad, unidad: this.unidadDe(prod.tipo, presId), estadoHacia: 'disponible',
        usuarioId: o.usuarioId ?? null, descripcion: o.descripcion || 'Reingreso por anulación',
      });
    }
  }

  /* ============================ TRANSFERENCIAS ============================ *
   * Modelo PULL con el stock acompañando los estados:
   *
   *   pendiente ── tomar ──► preparada (EN PREPARACIÓN) ── despachar ──► transito ── recibir ──► recibida
   *   (demanda:     el pedido se divide en DOS listas por tipo    comprometido→        lo contado va al
   *    sin stock)   de producto: ENTEROS (preparador) y GRANEL    en_transito          destino; el resto,
   *                 (fraccionador). Cada encargado edita lo       (sigue en el         a incidencia
   *                 preparado, agrega renglones si llegó          origen)
   *                 mercadería, y CONFIRMA su lista — recién
   *                 ahí se reserva (disponible→comprometido).
   *
   * El pedido NO exige ni toca stock: lo arma el destino y el origen quizá
   * todavía no tiene la mercadería. La realidad entra al CONFIRMAR cada lista,
   * que es cuando la mercadería queda físicamente apartada. El despacho exige
   * todas las listas presentes confirmadas y viaja LO PREPARADO, no lo pedido.
   */

  /** A qué lista de preparación pertenece un producto. */
  private listaDe(prodTipo: string): 'enteros' | 'granel' {
    return prodTipo === 'granel' ? 'granel' : 'enteros';
  }

  async crearTransferencia(o: any) {
    return this.db.transaction(async (tx) => {
      const [origen] = await tx.select().from(sucursales).where(eq(sucursales.id, o.origenId)).limit(1);
      const [destino] = await tx.select().from(sucursales).where(eq(sucursales.id, o.destinoId)).limit(1);
      if (!origen || !destino || origen.id === destino.id) throw new BadRequestException('Elegí origen y destino distintos.');
      const items = (o.items || []).filter((it: any) => Number(it.cantidad) > 0);
      if (!items.length) throw new BadRequestException('Agregá al menos un ítem con cantidad.');

      const [t] = await tx.insert(transferencias).values({
        codigo: '', origenId: origen.id, destinoId: destino.id, usuarioId: o.usuarioId ?? null,
        estado: 'pendiente', observaciones: (o.observaciones ?? '').trim(),
      }).returning();
      const codigo = 'TR' + String(t.id).padStart(4, '0');
      await tx.update(transferencias).set({ codigo }).where(eq(transferencias.id, t.id));
      await tx.insert(transferenciaHist).values({ transferenciaId: t.id, estado: 'pendiente', usuarioId: o.usuarioId ?? null });
      await tx.insert(transferenciaItems).values(items.map((it: any) => ({
        transferenciaId: t.id, productoId: it.productoId,
        presentacionId: it.presId || null, cantidad: Number(it.cantidad),
        // Lo preparado arranca igual a lo pedido; el origen lo ajusta después.
        cantidadPreparada: Number(it.cantidad),
      })));
      return { ok: true, id: t.id, codigo };
    });
  }

  /* ------------------- Preparación en dos listas ------------------- */

  /**
   * Foto de una transferencia en preparación, con guardas comunes: existe,
   * está en la fase correcta, y la LISTA del renglón que se quiere tocar no
   * fue confirmada todavía (confirmada = mercadería apartada y reservada; para
   * tocarla hay que desconfirmar primero).
   */
  private async transferEnPreparacion(tx: any, id: number) {
    const [t] = await tx.select().from(transferencias).where(eq(transferencias.id, id)).limit(1);
    if (!t) throw new NotFoundException('Transferencia inexistente.');
    if (t.estado !== 'preparada') throw new BadRequestException('Solo se edita durante la preparación.');
    return t;
  }

  private listaBloqueada(t: any, lista: 'enteros' | 'granel') {
    return lista === 'enteros' ? t.enterosListo : t.granelListo;
  }

  /** Edita cantidad preparada y/o motivo de un renglón, con su lista sin confirmar. */
  async editarItemTransferencia(id: number, itemId: number, o: { cantidadPreparada?: number; motivo?: string }) {
    return this.db.transaction(async (tx) => {
      const t = await this.transferEnPreparacion(tx, id);
      const [it] = await tx.select().from(transferenciaItems)
        .where(and(eq(transferenciaItems.id, itemId), eq(transferenciaItems.transferenciaId, id))).limit(1);
      if (!it) throw new NotFoundException('Renglón inexistente.');
      const prod = await this.getProducto(tx, it.productoId);
      if (this.listaBloqueada(t, this.listaDe(prod.tipo))) {
        throw new BadRequestException('Esa lista ya está confirmada — desconfirmala para editar.');
      }
      const patch: any = {};
      if (o.cantidadPreparada != null) {
        const c = Number(o.cantidadPreparada);
        if (!Number.isFinite(c) || c < 0) throw new BadRequestException('Cantidad preparada inválida.');
        patch.cantidadPreparada = c;
      }
      if (o.motivo != null) patch.motivo = String(o.motivo).trim();
      if (!Object.keys(patch).length) return { ok: true };
      await tx.update(transferenciaItems).set(patch).where(eq(transferenciaItems.id, itemId));
      return { ok: true };
    });
  }

  /**
   * Agrega un renglón DURANTE la preparación (llegó mercadería a último
   * momento y viaja en este mismo envío, sin que el destino re-pida).
   * `cantidad` (lo pedido) queda en 0: nadie lo pidió — el remito lo muestra
   * como "Agregado".
   */
  async agregarItemTransferencia(id: number, o: { productoId: number; presId?: number | null; cantidad: number; motivo?: string }) {
    return this.db.transaction(async (tx) => {
      const t = await this.transferEnPreparacion(tx, id);
      const prod = await this.getProducto(tx, o.productoId);
      if (!prod) throw new BadRequestException('Producto inválido.');
      if (this.listaBloqueada(t, this.listaDe(prod.tipo))) {
        throw new BadRequestException('Esa lista ya está confirmada — desconfirmala para agregar.');
      }
      const c = Number(o.cantidad);
      if (!Number.isFinite(c) || c <= 0) throw new BadRequestException('Ingresá la cantidad que se agrega.');
      const [row] = await tx.insert(transferenciaItems).values({
        transferenciaId: id, productoId: prod.id, presentacionId: o.presId || null,
        cantidad: 0, cantidadPreparada: c, agregado: true,
        motivo: (o.motivo ?? '').trim() || 'Agregado en preparación',
      }).returning();
      return { ok: true, itemId: row.id };
    });
  }

  /** Quita un renglón agregado (los pedidos por el destino no se borran: se ponen en 0). */
  async quitarItemTransferencia(id: number, itemId: number) {
    return this.db.transaction(async (tx) => {
      const t = await this.transferEnPreparacion(tx, id);
      const [it] = await tx.select().from(transferenciaItems)
        .where(and(eq(transferenciaItems.id, itemId), eq(transferenciaItems.transferenciaId, id))).limit(1);
      if (!it) throw new NotFoundException('Renglón inexistente.');
      if (!it.agregado) throw new BadRequestException('Los renglones pedidos por el destino no se borran: poné la cantidad preparada en 0.');
      const prod = await this.getProducto(tx, it.productoId);
      if (this.listaBloqueada(t, this.listaDe(prod.tipo))) {
        throw new BadRequestException('Esa lista ya está confirmada — desconfirmala para quitar renglones.');
      }
      await tx.delete(transferenciaItems).where(eq(transferenciaItems.id, itemId));
      return { ok: true };
    });
  }

  /**
   * Confirma (o desconfirma) UNA lista de preparación. Confirmar es el momento
   * de verdad: la mercadería quedó apartada físicamente, así que acá se valida
   * y RESERVA el stock de esa lista (disponible → comprometido) por lo
   * PREPARADO. Desconfirmar libera la reserva para poder seguir editando.
   *
   * El reclamo del flag es atómico (`WHERE flag = <contrario>`): dos clics
   * simultáneos en Confirmar reservarían dos veces — solo uno gana el UPDATE.
   */
  async confirmarListaTransferencia(id: number, o: { tipo: 'enteros' | 'granel'; listo: boolean; usuarioId?: number }) {
    if (o.tipo !== 'enteros' && o.tipo !== 'granel') throw new BadRequestException('Lista inválida.');
    return this.db.transaction(async (tx) => {
      const t = await this.transferEnPreparacion(tx, id);
      const col = o.tipo === 'enteros' ? transferencias.enterosListo : transferencias.granelListo;
      const gano = await tx.update(transferencias)
        .set(o.tipo === 'enteros' ? { enterosListo: o.listo } : { granelListo: o.listo })
        .where(and(eq(transferencias.id, id), eq(transferencias.estado, 'preparada'), eq(col, !o.listo)))
        .returning({ id: transferencias.id });
      if (!gano.length) throw new BadRequestException('La lista cambió de estado — actualizá la pantalla.');

      const items = await tx.select().from(transferenciaItems).where(eq(transferenciaItems.transferenciaId, id));
      const mios: { it: any; prod: any }[] = [];
      for (const it of items) {
        const prod = await this.getProducto(tx, it.productoId);
        if (this.listaDe(prod.tipo) === o.tipo && it.cantidadPreparada > 1e-9) mios.push({ it, prod });
      }

      if (o.listo) {
        // Primero se valida TODO y recién después se mueve: el error detalla
        // cada renglón corto y no deja reservas a medias.
        const faltas: string[] = [];
        for (const { it, prod } of mios) {
          const disp = await this.cant(tx, it.productoId, t.origenId, it.presentacionId, 'disponible');
          if (it.cantidadPreparada > disp + 1e-9) {
            faltas.push(`${prod.nombre}: preparado ${this.fmtCant(prod.tipo, it.presentacionId, it.cantidadPreparada)}, disponible ${this.fmtCant(prod.tipo, it.presentacionId, disp)}`);
          }
        }
        if (faltas.length) throw new BadRequestException(`Stock insuficiente para confirmar — ${faltas.join(' · ')}`);
      }

      const etiqueta = o.tipo === 'enteros' ? 'Enteros' : 'Fraccionados';
      for (const { it, prod } of mios) {
        if (o.listo) {
          await this.move(tx, { productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId }, 'disponible', 'comprometido', it.cantidadPreparada);
        } else {
          await this.move(tx, { productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId }, 'comprometido', 'disponible', it.cantidadPreparada);
        }
        await this.mov(tx, {
          tipo: 'transferencia', productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId, signo: 0,
          cantidad: it.cantidadPreparada, unidad: this.unidadDe(prod.tipo, it.presentacionId),
          estadoDesde: o.listo ? 'disponible' : 'comprometido', estadoHacia: o.listo ? 'comprometido' : 'disponible',
          sucursalDestinoId: t.destinoId, refTransferenciaId: t.id, usuarioId: o.usuarioId ?? null,
          descripcion: o.listo
            ? `${t.codigo}: lista ${etiqueta} confirmada, stock reservado`
            : `${t.codigo}: lista ${etiqueta} desconfirmada, stock liberado`,
        });
      }
      return { ok: true, tipo: o.tipo, listo: o.listo };
    });
  }

  /**
   * preparada → transito. La mercadería sale pero SIGUE SIENDO DEL ORIGEN
   * (comprometido → en_transito): si el camión se pierde, la pérdida es del
   * que despachó y el inventario total no miente. Acá se congela el costo
   * unitario de cada renglón — el remito valuado a costo tiene que decir lo
   * mismo dentro de seis meses.
   */
  private async despacharTransferencia(tx: any, t: any, items: any[], usuarioId?: number | null) {
    const provs = await tx.select().from(productoProveedores)
      .where(inArray(productoProveedores.productoId, items.map((i: any) => i.productoId)));
    for (const it of items) {
      // Viaja LO PREPARADO. Un renglón en 0 ("no había") no viaja ni se valúa.
      if (!(it.cantidadPreparada > 1e-9)) continue;
      const prod = await this.getProducto(tx, it.productoId);
      const cnKg = costoNetoEntry(formatoActivo(provs.filter((p: any) => p.productoId === it.productoId)) as any, prod.iva);
      let costo = cnKg;
      if (it.presentacionId) {
        const [pres] = await tx.select().from(presentaciones).where(eq(presentaciones.id, it.presentacionId)).limit(1);
        costo = cnKg * (pres?.tamKg ?? 1);
      }
      await tx.update(transferenciaItems).set({ costoUnitario: costo }).where(eq(transferenciaItems.id, it.id));

      await this.move(tx, { productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId }, 'comprometido', 'en_transito', it.cantidadPreparada);
      await this.mov(tx, {
        tipo: 'transferencia', productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId, signo: 0,
        cantidad: it.cantidadPreparada, unidad: this.unidadDe(prod.tipo, it.presentacionId), estadoDesde: 'comprometido', estadoHacia: 'en_transito',
        sucursalDestinoId: t.destinoId, refTransferenciaId: t.id, usuarioId: usuarioId ?? null,
        descripcion: `${t.codigo}: despacho hacia destino`,
      });
    }
  }

  /**
   * Avanza pendiente→preparada→transito. Recibir tiene su método: se cuenta.
   *
   * `desde` es la intención del botón: "preparar" significa avanzar DESDE
   * pendiente. Sin eso, el doble clic en Preparar ejecutaba dos pasos — el
   * segundo request encontraba la transferencia ya preparada y la despachaba.
   */
  async avanzarTransferencia(id: number, usuarioId?: number, desde?: string) {
    return this.db.transaction(async (tx) => {
      const [t] = await tx.select().from(transferencias).where(eq(transferencias.id, id)).limit(1);
      if (!t) throw new NotFoundException('Transferencia inexistente.');
      if (desde && t.estado !== desde) {
        throw new BadRequestException('La transferencia cambió de estado — actualizá la pantalla.');
      }

      let siguiente: 'preparada' | 'transito';
      if (t.estado === 'pendiente') siguiente = 'preparada';
      else if (t.estado === 'preparada') siguiente = 'transito';
      else if (t.estado === 'transito') throw new BadRequestException('Está en tránsito: se cierra desde "Recibir", contando lo que llegó.');
      else throw new BadRequestException('La transferencia ya está en su estado final.');

      // Despachar exige cada lista PRESENTE confirmada: confirmar es reservar,
      // y sin reserva no hay nada que subir al camión.
      if (siguiente === 'transito') {
        const its = await tx.select().from(transferenciaItems).where(eq(transferenciaItems.transferenciaId, t.id));
        let hayEnteros = false; let hayGranel = false; let viaja = false;
        for (const it of its) {
          const prod = await this.getProducto(tx, it.productoId);
          if (this.listaDe(prod.tipo) === 'granel') hayGranel = true; else hayEnteros = true;
          if (it.cantidadPreparada > 1e-9) viaja = true;
        }
        if (!viaja) throw new BadRequestException('No hay nada preparado para despachar: todos los renglones están en 0.');
        const faltan: string[] = [];
        if (hayEnteros && !t.enterosListo) faltan.push('Enteros');
        if (hayGranel && !t.granelListo) faltan.push('Fraccionados');
        if (faltan.length) throw new BadRequestException(`Falta confirmar: ${faltan.join(' y ')}. Cada encargado confirma su lista cuando la mercadería está apartada.`);
      }

      /*
       * El RECLAMO del estado va PRIMERO y es atómico (`WHERE estado = el que
       * leí`): dos clics simultáneos leen los dos "pendiente", pero solo uno
       * gana este UPDATE — el otro afecta cero filas y corta acá, sin haber
       * tocado stock. Sin esto, la reserva corría dos veces.
       */
      const gano = await tx.update(transferencias)
        .set({ estado: siguiente })
        .where(and(eq(transferencias.id, t.id), eq(transferencias.estado, t.estado)))
        .returning({ id: transferencias.id });
      if (!gano.length) throw new BadRequestException('La transferencia cambió de estado — actualizá la pantalla.');

      // pendiente → preparada ya no toca stock: abre la fase de preparación y
      // la reserva llega recién cuando cada encargado CONFIRMA su lista.
      if (siguiente === 'transito') {
        const items = await tx.select().from(transferenciaItems).where(eq(transferenciaItems.transferenciaId, t.id));
        await this.despacharTransferencia(tx, t, items, usuarioId);
      }

      await tx.insert(transferenciaHist).values({ transferenciaId: t.id, estado: siguiente, usuarioId: usuarioId ?? null });
      return { ok: true, estado: siguiente };
    });
  }

  /**
   * transito → recibida, CONTANDO. Se acepta lo que llegó — esa es la verdad —
   * y la diferencia no desaparece: vuelve a `comprometido` en el origen atada
   * a una incidencia automática. Comprometido es adrede: es el estado sobre el
   * que ya trabaja la resolución de incidencias (aparece → liberar; si no →
   * merma/vencido/defectuoso), así que el faltante se cierra con el circuito
   * que ya existe, sin uno nuevo.
   */
  async recibirTransferencia(id: number, o: { items?: { itemId: number; cantidadRecibida: number }[]; usuarioId?: number; observaciones?: string } = {}) {
    return this.db.transaction(async (tx) => {
      const [t] = await tx.select().from(transferencias).where(eq(transferencias.id, id)).limit(1);
      if (!t) throw new NotFoundException('Transferencia inexistente.');
      if (t.estado !== 'transito') throw new BadRequestException('Solo se recibe lo que está en tránsito.');
      // Mismo reclamo atómico que en avanzar: dos recepciones simultáneas del
      // mismo remito duplicarían el ingreso al destino.
      const gano = await tx.update(transferencias)
        .set({ estado: 'recibida' })
        .where(and(eq(transferencias.id, t.id), eq(transferencias.estado, 'transito')))
        .returning({ id: transferencias.id });
      if (!gano.length) throw new BadRequestException('La transferencia cambió de estado — actualizá la pantalla.');
      const items = await tx.select().from(transferenciaItems).where(eq(transferenciaItems.transferenciaId, t.id));
      const [origen] = await tx.select().from(sucursales).where(eq(sucursales.id, t.origenId)).limit(1);
      const [destino] = await tx.select().from(sucursales).where(eq(sucursales.id, t.destinoId)).limit(1);
      const contado = new Map((o.items ?? []).map((x) => [Number(x.itemId), Number(x.cantidadRecibida)]));

      const incidenciasCreadas: string[] = [];
      for (const it of items) {
        // Se recibe contra LO PREPARADO (lo que de verdad viajó). Un renglón
        // en 0 no subió al camión: se cierra en 0 sin tocar stock.
        const enviado = it.cantidadPreparada;
        if (!(enviado > 1e-9)) {
          await tx.update(transferenciaItems).set({ cantidadRecibida: 0 }).where(eq(transferenciaItems.id, it.id));
          continue;
        }
        const prod = await this.getProducto(tx, it.productoId);
        const unidad = this.unidadDe(prod.tipo, it.presentacionId);
        // Sin conteo explícito se asume completo; jamás más de lo enviado.
        const rec = Math.min(Math.max(contado.get(it.id) ?? enviado, 0), enviado);
        const faltante = enviado - rec;
        await tx.update(transferenciaItems).set({ cantidadRecibida: rec }).where(eq(transferenciaItems.id, it.id));

        if (rec > 1e-9) {
          // Lo recibido: sale del origen (en_transito) y entra al destino.
          await this.addDelta(tx, { productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId, estado: 'en_transito' }, -rec);
          await this.mov(tx, {
            tipo: 'transferencia', productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId, signo: -1,
            cantidad: rec, unidad, estadoDesde: 'en_transito', sucursalDestinoId: t.destinoId, refTransferenciaId: t.id,
            usuarioId: o.usuarioId ?? null, descripcion: `${t.codigo}: entregado a ${destino?.nombre}`,
          });
          await this.addDelta(tx, { productoId: it.productoId, sucursalId: t.destinoId, presentacionId: it.presentacionId, estado: 'disponible' }, rec);
          await this.mov(tx, {
            tipo: 'transferencia', productoId: it.productoId, sucursalId: t.destinoId, presentacionId: it.presentacionId, signo: 1,
            cantidad: rec, unidad, estadoHacia: 'disponible', refTransferenciaId: t.id,
            usuarioId: o.usuarioId ?? null, descripcion: `${t.codigo}: recepción desde ${origen?.nombre}`,
          });
        }

        if (faltante > 1e-9) {
          // La diferencia no se pierde: queda retenida en el origen con una
          // incidencia que ALGUIEN tiene que cerrar.
          await this.move(tx, { productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId }, 'en_transito', 'comprometido', faltante);
          const [inc] = await tx.insert(incidencias).values({
            codigo: '', tipo: 'faltante', estado: 'pendiente', responsableId: o.usuarioId ?? null,
            motivo: `${t.codigo} ${origen?.nombre} → ${destino?.nombre}: se enviaron ${this.fmtCant(prod.tipo, it.presentacionId, enviado)} de ${prod.nombre} y llegaron ${this.fmtCant(prod.tipo, it.presentacionId, rec)}.`,
            productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId,
            cantidad: faltante, unidad,
          }).returning();
          const codigoInc = 'INC' + String(inc.id).padStart(4, '0');
          await tx.update(incidencias).set({ codigo: codigoInc }).where(eq(incidencias.id, inc.id));
          incidenciasCreadas.push(codigoInc);
          await this.mov(tx, {
            tipo: 'ajuste', productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId, signo: 0,
            cantidad: faltante, unidad, estadoDesde: 'en_transito', estadoHacia: 'comprometido',
            refTransferenciaId: t.id, refIncidenciaId: inc.id, usuarioId: o.usuarioId ?? null,
            descripcion: `${t.codigo}: faltante en recepción → ${codigoInc}`,
          });
        }
      }

      // El estado ya se reclamó arriba; acá solo se suman las notas del receptor.
      const obs = (o.observaciones ?? '').trim();
      if (obs) {
        await tx.update(transferencias)
          .set({ observaciones: t.observaciones ? `${t.observaciones} · ${obs}` : obs })
          .where(eq(transferencias.id, t.id));
      }
      await tx.insert(transferenciaHist).values({ transferenciaId: t.id, estado: 'recibida', usuarioId: o.usuarioId ?? null });
      return { ok: true, estado: 'recibida', incidencias: incidenciasCreadas };
    });
  }

  async cancelarTransferencia(id: number) {
    return this.db.transaction(async (tx) => {
      const [t] = await tx.select().from(transferencias).where(eq(transferencias.id, id)).limit(1);
      if (!t) throw new NotFoundException('Transferencia inexistente.');
      if (t.estado !== 'pendiente' && t.estado !== 'preparada') throw new BadRequestException('Solo se cancelan transferencias pendientes o preparadas.');
      // Reclamo atómico: si en el medio la prepararon o despacharon, no se
      // puede cancelar con la foto vieja.
      const gano = await tx.update(transferencias)
        .set({ estado: 'cancelada' })
        .where(and(eq(transferencias.id, t.id), eq(transferencias.estado, t.estado)))
        .returning({ id: transferencias.id });
      if (!gano.length) throw new BadRequestException('La transferencia cambió de estado — actualizá la pantalla.');
      const items = await tx.select().from(transferenciaItems).where(eq(transferenciaItems.transferenciaId, t.id));
      // El pedido (pendiente) nunca tocó stock. En preparación, la reserva
      // existe SOLO en las listas confirmadas: se libera exactamente eso.
      if (t.estado === 'preparada') {
        for (const it of items) {
          if (!(it.cantidadPreparada > 1e-9)) continue;
          const prod = await this.getProducto(tx, it.productoId);
          const confirmada = this.listaDe(prod.tipo) === 'granel' ? t.granelListo : t.enterosListo;
          if (!confirmada) continue;
          await this.move(tx, { productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId }, 'comprometido', 'disponible', it.cantidadPreparada);
          await this.mov(tx, {
            tipo: 'transferencia', productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId, signo: 0,
            cantidad: it.cantidadPreparada, unidad: this.unidadDe(prod.tipo, it.presentacionId), estadoDesde: 'comprometido', estadoHacia: 'disponible',
            refTransferenciaId: t.id, descripcion: `${t.codigo}: cancelada, stock liberado`,
          });
        }
      }
      await tx.insert(transferenciaHist).values({ transferenciaId: t.id, estado: 'cancelada' });
      return { ok: true };
    });
  }

  /* ============================ INCIDENCIAS ============================ */
  async crearIncidencia(o: any) {
    return this.db.transaction(async (tx) => {
      const prod = await this.getProducto(tx, o.productoId);
      if (!prod) throw new BadRequestException('Producto inválido.');
      const presId = o.presId || null;
      const sucId = o.sucursalId;
      const c = Number(o.cantidad);
      if (!(c > 0)) throw new BadRequestException('Ingresá la cantidad comprometida.');
      const disp = await this.cant(tx, prod.id, sucId, presId, 'disponible');
      if (c > disp + 1e-9) throw new BadRequestException(`No hay tanto stock disponible. Disponible: ${this.fmtCant(prod.tipo, presId, disp)}.`);
      await this.move(tx, { productoId: prod.id, sucursalId: sucId, presentacionId: presId }, 'disponible', 'comprometido', c);
      const [inc] = await tx.insert(incidencias).values({
        codigo: '', tipo: o.tipo, estado: 'pendiente', responsableId: o.responsableId ?? null, motivo: o.motivo || '',
        productoId: prod.id, sucursalId: sucId, presentacionId: presId, cantidad: c, unidad: this.unidadDe(prod.tipo, presId),
      }).returning();
      const codigo = 'INC' + String(inc.id).padStart(4, '0');
      await tx.update(incidencias).set({ codigo }).where(eq(incidencias.id, inc.id));
      await this.mov(tx, {
        tipo: 'ajuste', productoId: prod.id, sucursalId: sucId, presentacionId: presId, signo: 0, cantidad: c,
        unidad: this.unidadDe(prod.tipo, presId), estadoDesde: 'disponible', estadoHacia: 'comprometido',
        refIncidenciaId: inc.id, usuarioId: o.responsableId ?? null, descripcion: `${codigo} (${o.tipo}): ${this.fmtCant(prod.tipo, presId, c)} a comprometido`,
      });
      return { ok: true, id: inc.id, codigo };
    });
  }

  async avanzarIncidencia(id: number) {
    const [inc] = await this.db.select().from(incidencias).where(eq(incidencias.id, id)).limit(1);
    if (!inc) throw new NotFoundException('Incidencia inexistente.');
    if (inc.estado !== 'pendiente') throw new BadRequestException("Usá 'Resolver' para cerrar la incidencia.");
    await this.db.update(incidencias).set({ estado: 'revision' }).where(eq(incidencias.id, id));
    return { ok: true };
  }

  async resolverIncidencia(id: number, resolucion: string) {
    return this.db.transaction(async (tx) => {
      const [inc] = await tx.select().from(incidencias).where(eq(incidencias.id, id)).limit(1);
      if (!inc) throw new NotFoundException('Incidencia inexistente.');
      if (inc.estado === 'resuelta') throw new BadRequestException('La incidencia ya está resuelta.');
      const prod = await this.getProducto(tx, inc.productoId);
      const c = inc.cantidad;
      const comprom = await this.cant(tx, prod.id, inc.sucursalId, inc.presentacionId, 'comprometido');
      if (c > comprom + 1e-9) throw new BadRequestException('El stock comprometido cambió; revisá manualmente.');
      await this.addDelta(tx, { productoId: prod.id, sucursalId: inc.sucursalId, presentacionId: inc.presentacionId, estado: 'comprometido' }, -c);
      let tipoMov = 'ajuste';
      let estadoHacia: EstadoStock | null = null;
      if (resolucion === 'liberar') { await this.addDelta(tx, { productoId: prod.id, sucursalId: inc.sucursalId, presentacionId: inc.presentacionId, estado: 'disponible' }, c); estadoHacia = 'disponible'; }
      else if (resolucion === 'merma') { tipoMov = 'merma'; }
      else if (resolucion === 'vencido') { tipoMov = 'vencido'; await this.addDelta(tx, { productoId: prod.id, sucursalId: inc.sucursalId, presentacionId: inc.presentacionId, estado: 'vencido' }, c); estadoHacia = 'vencido'; }
      else if (resolucion === 'defectuoso') { tipoMov = 'defectuoso'; await this.addDelta(tx, { productoId: prod.id, sucursalId: inc.sucursalId, presentacionId: inc.presentacionId, estado: 'defectuoso' }, c); estadoHacia = 'defectuoso'; }
      else throw new BadRequestException('Resolución inválida.');
      await tx.update(incidencias).set({ estado: 'resuelta', resolucion, fechaResolucion: new Date(), activa: false }).where(eq(incidencias.id, id));
      await this.mov(tx, {
        tipo: tipoMov, productoId: prod.id, sucursalId: inc.sucursalId, presentacionId: inc.presentacionId,
        signo: resolucion === 'liberar' ? 0 : -1, cantidad: c, unidad: inc.unidad, estadoDesde: 'comprometido', estadoHacia,
        refIncidenciaId: inc.id, descripcion: `${inc.codigo} resuelta: ${resolucion === 'liberar' ? 'liberado a disponible' : 'baja por ' + resolucion}`,
      });
      return { ok: true };
    });
  }

  /**
   * OPERACIONES DE UN ALMACÉN — el "libro" del legacy: una fila por DOCUMENTO
   * (no por renglón), valuada a costo, en un rango de fechas.
   *
   * Tres fuentes, un solo formato de fila:
   *   · transferencias: una fila por LADO — el mismo remito es "enviado" para
   *     el origen y "recibido" para el destino, con la fecha de SU evento
   *     (despacho o recepción). Valuadas al costo CONGELADO al despachar.
   *   · comprobantes de compra con recepción en esa sucursal (costo real).
   *   · movimientos sueltos (ajuste, merma, vencido, defectuoso): cada uno es
   *     una operación de por sí. Sin valuar: no congelan costo, y valuarlos a
   *     costo de HOY sería inventar un número histórico.
   *
   * El rango de fechas acota el volumen; los filtros finos (tipo, con
   * observación) los aplica la pantalla en memoria.
   */
  async operacionesAlmacen(q: { sucursalId: number; desde?: string; hasta?: string; limit?: number }) {
    const sucId = Number(q.sucursalId);
    if (!sucId) throw new BadRequestException('Indicá la sucursal.');
    const desde = q.desde ? new Date(q.desde) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const hasta = q.hasta ? new Date(`${q.hasta}T23:59:59`) : new Date();
    const limit = Math.min(Math.max(Number(q.limit) || 300, 1), 1000);

    const [ts, tItems, tHist, comps, movs, sucs, usrs, prods] = await Promise.all([
      this.db.select().from(transferencias)
        .where(or(eq(transferencias.origenId, sucId), eq(transferencias.destinoId, sucId))),
      this.db.select().from(transferenciaItems),
      this.db.select().from(transferenciaHist),
      this.db.select().from(comprobantes)
        .where(and(eq(comprobantes.sucursalId, sucId), eq(comprobantes.recepcion, true),
          gte(comprobantes.fechaCarga, desde), lte(comprobantes.fechaCarga, hasta))),
      this.db.select().from(movimientos)
        .where(and(eq(movimientos.sucursalId, sucId),
          inArray(movimientos.tipo, ['ajuste', 'merma', 'vencido', 'defectuoso'] as any),
          gte(movimientos.fecha, desde), lte(movimientos.fecha, hasta))),
      this.db.select().from(sucursales),
      this.db.select().from(usuarios),
      this.db.select({ id: productos.id, nombre: productos.nombre }).from(productos),
    ]);
    const nomSuc = new Map(sucs.map((s) => [s.id, s.nombre]));
    const nomUsr = new Map(usrs.map((u) => [u.id, u.nombre]));
    const nomProd = new Map(prods.map((p) => [p.id, p.nombre]));

    const filas: any[] = [];

    /** Fecha en la que la transferencia entró a un estado (del historial). */
    const fechaEstado = (tId: number, estado: string) =>
      tHist.filter((h) => h.transferenciaId === tId && h.estado === estado).map((h) => h.fecha).pop() ?? null;
    const usuarioEstado = (tId: number, estado: string) =>
      tHist.filter((h) => h.transferenciaId === tId && h.estado === estado).map((h) => h.usuarioId).pop() ?? null;

    for (const t of ts) {
      const items = tItems.filter((i) => i.transferenciaId === t.id);
      // Lado ORIGEN: la operación es el despacho, valuada a lo ENVIADO.
      if (t.origenId === sucId && (t.estado === 'transito' || t.estado === 'recibida')) {
        const f = fechaEstado(t.id, 'transito');
        if (f && f >= desde && f <= hasta) {
          filas.push({
            id: `t${t.id}-env`, tipo: 'transferencia_enviada', codigo: t.codigo, fecha: f, fechaCarga: t.fecha,
            concepto: `Envío a ${nomSuc.get(t.destinoId) ?? '—'}`,
            monto: items.reduce((a, i) => a + i.cantidad * i.costoUnitario, 0),
            observaciones: t.observaciones, usuario: nomUsr.get(usuarioEstado(t.id, 'transito') as number) ?? nomUsr.get(t.usuarioId as number) ?? '',
            refTransferenciaId: t.id,
          });
        }
      }
      // Lado DESTINO: la operación es la recepción, valuada a lo RECIBIDO.
      if (t.destinoId === sucId && t.estado === 'recibida') {
        const f = fechaEstado(t.id, 'recibida');
        if (f && f >= desde && f <= hasta) {
          filas.push({
            id: `t${t.id}-rec`, tipo: 'transferencia_recibida', codigo: t.codigo, fecha: f, fechaCarga: t.fecha,
            concepto: `Recepción desde ${nomSuc.get(t.origenId) ?? '—'}`,
            monto: items.reduce((a, i) => a + (i.cantidadRecibida ?? i.cantidad) * i.costoUnitario, 0),
            observaciones: t.observaciones, usuario: nomUsr.get(usuarioEstado(t.id, 'recibida') as number) ?? '',
            refTransferenciaId: t.id,
          });
        }
      }
    }

    for (const c of comps) {
      filas.push({
        id: `c${c.id}`, tipo: 'compra_recibida', codigo: `${c.tipo === 'remito' ? 'REM' : 'FC'} ${c.puntoVenta}-${String(c.numero ?? 0).padStart(8, '0')}`,
        fecha: c.fecha, fechaCarga: c.fechaCarga, concepto: 'Recepción de compra',
        monto: c.subtotalNeto, observaciones: c.observaciones,
        usuario: nomUsr.get(c.usuarioId as number) ?? '', refComprobanteId: c.id,
      });
    }

    for (const m of movs) {
      filas.push({
        id: `m${m.id}`, tipo: m.tipo, codigo: `MOV${m.id}`, fecha: m.fecha, fechaCarga: m.fecha,
        concepto: `${nomProd.get(m.productoId as number) ?? '—'}: ${m.descripcion || m.tipo}`,
        monto: null, observaciones: m.motivo ?? '', usuario: nomUsr.get(m.usuarioId as number) ?? '',
        cantidad: m.cantidad, unidad: m.unidad,
      });
    }

    filas.sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime());
    return filas.slice(0, limit);
  }

  /* ============================ LECTURAS ============================ */
  async existencias() {
    const rows = await this.db.select().from(stock);
    return rows.filter((r) => r.cantidad > 1e-9);
  }

  /**
   * Historial paginado. Ya no viaja en el bootstrap, así que el panel lo pide
   * con sus filtros y un techo duro: la tabla crece para siempre.
   */
  async listMovimientos(q: { productoId?: number; sucursalId?: number; tipo?: string; limit?: number } = {}) {
    const conds: any[] = [];
    if (q.productoId) conds.push(eq(movimientos.productoId, Number(q.productoId)));
    if (q.sucursalId) conds.push(eq(movimientos.sucursalId, Number(q.sucursalId)));
    if (q.tipo) conds.push(eq(movimientos.tipo, q.tipo as any));
    const limit = Math.min(Math.max(Number(q.limit) || 300, 1), 1000);
    return this.db.select().from(movimientos)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(movimientos.id))
      .limit(limit);
  }

  async listTransferencias() {
    const ts = await this.db.select().from(transferencias).orderBy(desc(transferencias.id));
    const items = await this.db.select().from(transferenciaItems);
    const hist = await this.db.select().from(transferenciaHist);
    return ts.map((t) => ({
      ...t,
      items: items.filter((i) => i.transferenciaId === t.id),
      hist: hist.filter((h) => h.transferenciaId === t.id),
    }));
  }

  async listIncidencias() {
    return this.db.select().from(incidencias).orderBy(desc(incidencias.id));
  }

  /**
   * Snapshot del inventario: **solo lo que tiene techo**.
   *
   * Catálogo (productos, proveedores, sucursales, usuarios), existencias,
   * transferencias e incidencias crecen con la operación pero acotadas.
   * `movimientos` y `comprobantes` NO están: crecen sin techo y esta llamada
   * corre al abrir Compras/Almacén y después de cada mutación — meterlos acá
   * hacía que el sistema se pusiera más lento cada mes que pasa. Se piden
   * paginados desde el panel que los muestra (`/movimientos`, `/comprobantes`).
   */
  /**
   * Usuarios como los ve el frontend: SIN hash de contraseña y con el rol
   * dinámico resuelto (clave, nombre y permisos) — de acá sale can().
   */
  private usuariosPublicos(usr: any[], rs: any[]) {
    const rolDe = new Map(rs.map((r: any) => [r.id, r]));
    return usr.map((u) => {
      const r = rolDe.get(u.rolId);
      return {
        id: u.id, nombre: u.nombre, activo: u.activo, rolId: u.rolId,
        rolClave: r?.clave ?? '', rolNombre: r?.nombre ?? '', permisos: r?.permisos ?? [],
      };
    });
  }

  async bootstrap() {
    const [suc, prov, usr, prods, pres, provCostos, formatos, listasCat, stk, transfs, incs,
      ms, cs, ss, es, pes, rolesCat, pendientesLectura] = await Promise.all([
      this.db.select().from(sucursales),
      this.db.select().from(proveedores),
      this.db.select().from(usuarios),
      this.db.select().from(productos),
      this.db.select().from(presentaciones),
      this.db.select().from(productoProveedores),
      this.db.select().from(productoListas),
      this.listas.catalogo(),
      this.db.select().from(stock),
      this.listTransferencias(),
      this.db.select().from(incidencias).orderBy(desc(incidencias.id)),
      this.db.select().from(marcas),
      this.db.select().from(categorias),
      this.db.select().from(subcategorias),
      this.db.select().from(etiquetas),
      this.db.select().from(productoEtiquetas),
      this.db.select().from(roles),
      this.db.select({ n: sql<number>`count(*)` }).from(facturaLecturas)
        .where(eq(facturaLecturas.estado, 'pendiente')),
    ]);
    const cfgVentas = await this.cfg.get('ventas');
    const redondeo = cfgVentas.redondeoPrecio;
    const activas = listasCat.listas.filter((l: any) => l.activa);
    const listaBase = activas.find((l: any) => l.id === cfgVentas.listaBaseId) || activas[0] || null;

    // Catálogos resueltos a nombre: la pantalla muestra "Cachafaz", no un id, y
    // así no tiene que cruzar cuatro tablas por fila.
    const nombreDe = (rows: any[]) => new Map<number, string>(rows.map((r) => [r.id, r.nombre]));
    const nMarca = nombreDe(ms);
    const nCategoria = nombreDe(cs);
    const nSubcategoria = nombreDe(ss);
    const nEtiqueta = nombreDe(es);
    const etiquetasDe = new Map<number, number[]>();
    for (const pe of pes) {
      const arr = etiquetasDe.get(pe.productoId);
      if (arr) arr.push(pe.etiquetaId); else etiquetasDe.set(pe.productoId, [pe.etiquetaId]);
    }

    const productosFull = prods.map((p) => {
      const pp = provCostos.filter((x) => x.productoId === p.id);
      const active = formatoActivo(pp);
      const cn = costoNetoEntry(active, p.iva);
      const mias = formatos.filter((x) => x.productoId === p.id);
      // El redondeo propio del producto pisa al de configuración; null = heredar.
      const opts = { iva: p.iva, redondeo: p.redondeo ?? redondeo };

      // FORMATO DE VENTA: solo las listas que el producto tiene cargadas, cada
      // una con su markup propio. Sin fila no hay precio en esa lista.
      const listasProd = mias
        .map((f) => {
          const l: any = activas.find((x: any) => x.id === f.listaId);
          if (!l) return null;
          // El MISMO helper que la ficha y el POS: markup o precio definido,
          // unidades por formato — una sola derivación en todo el sistema.
          const pv = precioVentaFila(cn, f as any, opts);
          return {
            id: f.id,          // fila de producto_listas: la llave de la masiva de márgenes
            listaId: f.listaId,
            modalidadId: l.modalidadId,
            modalidad: l.modalidad,
            numero: l.numero,
            nombre: l.nombre,
            etiqueta: l.etiqueta,
            orden: l.orden,
            modoPrecio: (f as any).modoPrecio,
            markup: f.markup,
            precioFijo: (f as any).precioFijo,
            unidades: (f as any).unidades,
            codigoBarras: (f as any).codigoBarras,
            unidadesMinimas: f.unidadesMinimas,
            precio: pv.netoUnitario,
            precioFinalUnitario: pv.finalUnitario,
            precioFinalFormato: pv.finalFormato,
          };
        })
        .filter(Boolean)
        .sort((a: any, b: any) => a.orden - b.orden) as any[];

      // El precio de referencia de una presentación usa el piso; el POS
      // recalcula con la lista que el ticket habilite. Con precio definido el
      // markup no manda: se usa el equivalente derivado del neto.
      const filaRefB = listasProd.find((l) => l.listaId === listaBase?.id)
        ?? listasProd[listasProd.length - 1] ?? null;
      const markupRef = filaRefB
        ? (cn > 0 ? ((filaRefB.precio / cn) - 1) * 100 : filaRefB.markup)
        : 0;
      const misEtq = etiquetasDe.get(p.id) ?? [];
      return {
        ...p,
        marca: nMarca.get(p.marcaId as number) ?? '',
        categoria: nCategoria.get(p.categoriaId as number) ?? '',
        subcategoria: nSubcategoria.get(p.subcategoriaId as number) ?? '',
        etiquetas: misEtq,
        etiquetasNombres: misEtq.map((id) => nEtiqueta.get(id)).filter(Boolean),
        costoNeto: cn,
        presentaciones: pres.filter((x) => x.productoId === p.id)
          .map((pr) => ({ ...pr, precio: precioPresentacion(cn, pr, markupRef, opts) })),
        // Cada formato con su cadena derivada. Mismo nombre que en
        // `/productos`: un producto tiene una sola forma, venga de donde venga.
        formatosCompra: pp.map((e) => ({ ...e, ...costosFormato(e, p.iva), costoNeto: costoNetoEntry(e, p.iva) })),
        listas: listasProd,
      };
    });
    return {
      listasCatalogo: listasCat,
      // Los catálogos del producto: chicos y estables, viajan enteros para que
      // los desplegables del modal no cuesten una llamada cada uno.
      catalogos: { marcas: ms, categorias: cs, subcategorias: ss, etiquetas: es },
      sucursales: suc, proveedores: prov, usuarios: this.usuariosPublicos(usr, rolesCat), productos: productosFull,
      stock: stk, transferencias: transfs, incidencias: incs,
      /*
       * Cuántas facturas de papel están esperando que alguien las cargue. Viaja
       * solo el NÚMERO —para el globito del menú—: la bandeja en sí la pide su
       * panel, con sus filtros. Sin este aviso nadie se entera de que hay
       * facturas subidas, y el papel se queda en la bandeja como se quedaba en
       * el cajón.
       */
      lecturasPendientes: Number(pendientesLectura?.[0]?.n) || 0,
      // El frontend replica el cálculo de precios: necesita el mismo redondeo
      // para no mostrar un número distinto al de la API.
      configVentas: cfgVentas,
    };
  }
}
