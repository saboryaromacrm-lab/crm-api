import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, eq, isNull, desc } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  productos, presentaciones, productoProveedores, listasPrecio, proveedores, sucursales, usuarios,
  stock, movimientos, transferencias, transferenciaItems, transferenciaHist, incidencias,
  comprobantes, comprobanteItems,
} from '../db/schema';
import { ConfiguracionService } from '../configuracion/configuracion.module';
import { costoNetoEntry, precioLista, precioPresentacion } from './pricing';

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
};

type EstadoStock = 'disponible' | 'comprometido' | 'retenido' | 'defectuoso' | 'vencido';
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
  private async setCantidad(tx: any, id: number, val: number) {
    await tx.update(stock).set({ cantidad: val }).where(eq(stock.id, id));
  }
  private async addDelta(tx: any, c: Coord, delta: number) {
    const e = await this.getOrCreate(tx, c);
    await this.setCantidad(tx, e.id, e.cantidad + delta);
    return e.cantidad + delta;
  }
  private async cant(tx: any, productoId: number, sucursalId: number, presentacionId: number | null, estado: EstadoStock) {
    const e = await this.getEntry(tx, { productoId, sucursalId, presentacionId, estado });
    return e ? e.cantidad : 0;
  }
  private async move(tx: any, base: Omit<Coord, 'estado'>, desde: EstadoStock, hacia: EstadoStock, c: number) {
    const from = await this.getOrCreate(tx, { ...base, estado: desde });
    if (from.cantidad + 1e-9 < c) return false;
    await this.setCantidad(tx, from.id, from.cantidad - c);
    const to = await this.getOrCreate(tx, { ...base, estado: hacia });
    await this.setCantidad(tx, to.id, to.cantidad + c);
    return true;
  }

  /* ------------------------- Costos / precios ------------------------- */

  /**
   * Todo lo que hace falta para cotizar un producto: costo neto del proveedor
   * activo, IVA (define el redondeo de góndola) y margen de referencia.
   */
  private async ctxPrecio(tx: any, productoId: number) {
    const [prod] = await tx.select().from(productos).where(eq(productos.id, productoId)).limit(1);
    if (!prod) return { cn: 0, iva: 0, ganancia: 0, tieneLista: false, redondeo: 0 };
    const [provs, listas, cfg] = await Promise.all([
      tx.select().from(productoProveedores).where(eq(productoProveedores.productoId, productoId)),
      tx.select().from(listasPrecio).where(eq(listasPrecio.productoId, productoId)),
      this.cfg.get('ventas'),
    ]);
    const active = provs.find((p: any) => p.proveedorId === prod.proveedorActivoId) || provs[0] || null;
    return {
      cn: costoNetoEntry(active),
      iva: prod.iva,
      ganancia: listas[0]?.ganancia ?? 0,
      tieneLista: listas.length > 0,
      redondeo: cfg.redondeoPrecio,
    };
  }

  private async precioBase(tx: any, productoId: number): Promise<number> {
    const { cn, iva, ganancia, tieneLista, redondeo } = await this.ctxPrecio(tx, productoId);
    return tieneLista ? precioLista(cn, ganancia, { iva, redondeo }) : cn;
  }

  private async precioPres(tx: any, presentacionId: number): Promise<number> {
    const [pres] = await tx.select().from(presentaciones).where(eq(presentaciones.id, presentacionId)).limit(1);
    if (!pres) return 0;
    // El margen lo pone la lista (acá, la primera del producto); la presentación
    // solo agrega su recargo de fraccionamiento.
    const { cn, iva, ganancia, redondeo } = await this.ctxPrecio(tx, pres.productoId);
    return precioPresentacion(cn, pres, ganancia, { iva, redondeo });
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
          const existing = await tx.select().from(productoProveedores)
            .where(and(eq(productoProveedores.productoId, prod.id), eq(productoProveedores.proveedorId, prov.id))).limit(1);
          if (!existing[0]) {
            await tx.insert(productoProveedores).values({ productoId: prod.id, proveedorId: prov.id, costo: 0, descuento: 0, flete: 0 });
          }
          await tx.update(productos).set({ proveedorActivoId: prov.id }).where(eq(productos.id, prod.id));
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
        const existing = await tx.select().from(productoProveedores)
          .where(and(eq(productoProveedores.productoId, productoId), eq(productoProveedores.proveedorId, o.proveedorId))).limit(1);
        if (!existing[0]) {
          const it = (o.items || []).find((x: any) => x.productoId === productoId);
          await tx.insert(productoProveedores).values({ productoId, proveedorId: o.proveedorId, costo: Number(it?.costoUnitario) || 0, descuento: 0, flete: 0 });
        }
        await tx.update(productos)
          .set({ proveedorActivoId: o.proveedorId })
          .where(and(eq(productos.id, productoId), isNull(productos.proveedorActivoId)));
      }
    }
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
    for (const it of o.items || []) {
      const presId = it.presentacionId || null;
      const cantidad = Number(it.cantidad) || 0;
      if (cantidad <= 0) continue;
      const prod = await this.getProducto(tx, it.productoId);
      if (!prod) throw new BadRequestException('Producto inválido en el detalle.');
      const disp = await this.cant(tx, it.productoId, o.sucursalId, presId, 'disponible');
      if (!o.permitirNegativo && cantidad > disp + 1e-9) {
        throw new BadRequestException(
          `Stock insuficiente de ${prod.nombre}. Disponible: ${this.fmtCant(prod.tipo, presId, disp)}.`,
        );
      }
      await this.addDelta(tx, { productoId: it.productoId, sucursalId: o.sucursalId, presentacionId: presId, estado: 'disponible' }, -cantidad);
      const esGranelSuelto = prod.tipo === 'granel' && !presId;
      await this.mov(tx, {
        tipo: tipoMov || (esGranelSuelto ? 'venta_granel' : 'venta_fraccionada'),
        productoId: it.productoId, sucursalId: o.sucursalId, presentacionId: presId, signo: -1,
        cantidad, unidad: this.unidadDe(prod.tipo, presId), estadoDesde: 'disponible',
        usuarioId: o.usuarioId ?? null, descripcion: o.descripcion || 'Egreso por documento',
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

  /* ============================ TRANSFERENCIAS ============================ */
  async crearTransferencia(o: any) {
    return this.db.transaction(async (tx) => {
      const [origen] = await tx.select().from(sucursales).where(eq(sucursales.id, o.origenId)).limit(1);
      const [destino] = await tx.select().from(sucursales).where(eq(sucursales.id, o.destinoId)).limit(1);
      if (!origen || !destino || origen.id === destino.id) throw new BadRequestException('Elegí origen y destino distintos.');
      const items = (o.items || []).filter((it: any) => Number(it.cantidad) > 0);
      if (!items.length) throw new BadRequestException('Agregá al menos un ítem con cantidad.');
      for (const it of items) {
        const disp = await this.cant(tx, it.productoId, origen.id, it.presId || null, 'disponible');
        if (Number(it.cantidad) > disp + 1e-9) throw new BadRequestException(`Sin stock disponible en ${origen.nombre}.`);
      }
      const [t] = await tx.insert(transferencias).values({
        codigo: '', origenId: origen.id, destinoId: destino.id, usuarioId: o.usuarioId ?? null, estado: 'pendiente',
      }).returning();
      const codigo = 'TR' + String(t.id).padStart(4, '0');
      await tx.update(transferencias).set({ codigo }).where(eq(transferencias.id, t.id));
      await tx.insert(transferenciaHist).values({ transferenciaId: t.id, estado: 'pendiente', usuarioId: o.usuarioId ?? null });
      for (const it of items) {
        const presId = it.presId || null;
        await tx.insert(transferenciaItems).values({ transferenciaId: t.id, productoId: it.productoId, presentacionId: presId, cantidad: Number(it.cantidad) });
        await this.move(tx, { productoId: it.productoId, sucursalId: origen.id, presentacionId: presId }, 'disponible', 'comprometido', Number(it.cantidad));
        const prod = await this.getProducto(tx, it.productoId);
        await this.mov(tx, {
          tipo: 'transferencia', productoId: it.productoId, sucursalId: origen.id, presentacionId: presId, signo: 0,
          cantidad: Number(it.cantidad), unidad: this.unidadDe(prod.tipo, presId), estadoDesde: 'disponible', estadoHacia: 'comprometido',
          sucursalDestinoId: destino.id, refTransferenciaId: t.id, usuarioId: o.usuarioId ?? null,
          descripcion: `${codigo}: reserva ${this.fmtCant(prod.tipo, presId, Number(it.cantidad))} para ${destino.nombre}`,
        });
      }
      return { ok: true, id: t.id, codigo };
    });
  }

  async avanzarTransferencia(id: number) {
    return this.db.transaction(async (tx) => {
      const [t] = await tx.select().from(transferencias).where(eq(transferencias.id, id)).limit(1);
      if (!t) throw new NotFoundException('Transferencia inexistente.');
      const orden = ['pendiente', 'preparada', 'transito', 'recibida'];
      const idx = orden.indexOf(t.estado);
      if (idx < 0 || idx >= orden.length - 1) throw new BadRequestException('La transferencia ya está en su estado final.');
      const siguiente = orden[idx + 1] as any;
      const items = await tx.select().from(transferenciaItems).where(eq(transferenciaItems.transferenciaId, t.id));
      const [origen] = await tx.select().from(sucursales).where(eq(sucursales.id, t.origenId)).limit(1);
      const [destino] = await tx.select().from(sucursales).where(eq(sucursales.id, t.destinoId)).limit(1);
      if (siguiente === 'transito') {
        for (const it of items) {
          await this.addDelta(tx, { productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId, estado: 'comprometido' }, -it.cantidad);
          const prod = await this.getProducto(tx, it.productoId);
          await this.mov(tx, {
            tipo: 'transferencia', productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId, signo: -1,
            cantidad: it.cantidad, unidad: this.unidadDe(prod.tipo, it.presentacionId), estadoDesde: 'comprometido',
            sucursalDestinoId: t.destinoId, refTransferenciaId: t.id, descripcion: `${t.codigo}: salida de ${origen?.nombre}`,
          });
        }
      } else if (siguiente === 'recibida') {
        for (const it of items) {
          await this.addDelta(tx, { productoId: it.productoId, sucursalId: t.destinoId, presentacionId: it.presentacionId, estado: 'disponible' }, it.cantidad);
          const prod = await this.getProducto(tx, it.productoId);
          await this.mov(tx, {
            tipo: 'transferencia', productoId: it.productoId, sucursalId: t.destinoId, presentacionId: it.presentacionId, signo: 1,
            cantidad: it.cantidad, unidad: this.unidadDe(prod.tipo, it.presentacionId), estadoHacia: 'disponible',
            refTransferenciaId: t.id, descripcion: `${t.codigo}: recepción en ${destino?.nombre}`,
          });
        }
      }
      await tx.update(transferencias).set({ estado: siguiente }).where(eq(transferencias.id, t.id));
      await tx.insert(transferenciaHist).values({ transferenciaId: t.id, estado: siguiente });
      return { ok: true, estado: siguiente };
    });
  }

  async cancelarTransferencia(id: number) {
    return this.db.transaction(async (tx) => {
      const [t] = await tx.select().from(transferencias).where(eq(transferencias.id, id)).limit(1);
      if (!t) throw new NotFoundException('Transferencia inexistente.');
      if (t.estado !== 'pendiente' && t.estado !== 'preparada') throw new BadRequestException('Solo se cancelan transferencias pendientes o preparadas.');
      const items = await tx.select().from(transferenciaItems).where(eq(transferenciaItems.transferenciaId, t.id));
      for (const it of items) {
        await this.move(tx, { productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId }, 'comprometido', 'disponible', it.cantidad);
        const prod = await this.getProducto(tx, it.productoId);
        await this.mov(tx, {
          tipo: 'transferencia', productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId, signo: 0,
          cantidad: it.cantidad, unidad: this.unidadDe(prod.tipo, it.presentacionId), estadoDesde: 'comprometido', estadoHacia: 'disponible',
          refTransferenciaId: t.id, descripcion: `${t.codigo}: cancelada, stock liberado`,
        });
      }
      await tx.update(transferencias).set({ estado: 'cancelada' }).where(eq(transferencias.id, t.id));
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
  async bootstrap() {
    const [suc, prov, usr, prods, pres, provCostos, listas, stk, transfs, incs] = await Promise.all([
      this.db.select().from(sucursales),
      this.db.select().from(proveedores),
      this.db.select().from(usuarios),
      this.db.select().from(productos),
      this.db.select().from(presentaciones),
      this.db.select().from(productoProveedores),
      this.db.select().from(listasPrecio),
      this.db.select().from(stock),
      this.listTransferencias(),
      this.db.select().from(incidencias).orderBy(desc(incidencias.id)),
    ]);
    const cfgVentas = await this.cfg.get('ventas');
    const redondeo = cfgVentas.redondeoPrecio;
    const productosFull = prods.map((p) => {
      const pp = provCostos.filter((x) => x.productoId === p.id);
      const active = pp.find((e) => e.proveedorId === p.proveedorActivoId) || pp[0] || null;
      const cn = costoNetoEntry(active);
      const suyas = listas.filter((x) => x.productoId === p.id);
      // El precio de referencia de una presentación usa la primera lista, igual
      // que el resto del catálogo; el POS recalcula con la lista del cliente.
      const gananciaRef = suyas[0]?.ganancia ?? 0;
      const opts = { iva: p.iva, redondeo };
      return {
        ...p,
        costoNeto: cn,
        presentaciones: pres.filter((x) => x.productoId === p.id)
          .map((pr) => ({ ...pr, precio: precioPresentacion(cn, pr, gananciaRef, opts) })),
        proveedores: pp.map((e) => ({ ...e, costoNeto: costoNetoEntry(e) })),
        listasPrecio: suyas.map((l) => ({ ...l, precio: precioLista(cn, l.ganancia, opts) })),
      };
    });
    return {
      sucursales: suc, proveedores: prov, usuarios: usr, productos: productosFull,
      stock: stk, transferencias: transfs, incidencias: incs,
      // El frontend replica el cálculo de precios: necesita el mismo redondeo
      // para no mostrar un número distinto al de la API.
      configVentas: cfgVentas,
    };
  }
}
