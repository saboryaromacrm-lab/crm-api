/**
 * DIFERENCIAS DE ENTREGA (0248, 26/11/2026, pedido del dueño: «cuando me llega
 * un pedido y me mandan productos de más o de menos, que lo pueda hacer desde
 * la misma factura y que quede registrado… que todo concuerde»).
 * ============================================================================
 * Al cargar la factura (o liquidación, o remito) se dice cuánto LLEGÓ de lo
 * que se contó. Las reglas puras están en `diferencias.ts`:
 *
 *   · faltante: el papel lo cobra, no llegó. No entra al stock; la deuda queda
 *     por el papel. Se resuelve cuando llega después (entra al stock), con una
 *     nota de crédito (se ata al cargarla, sin sacar stock) o dándolo por perdido.
 *   · sobrante: llegó y el papel no lo cobra. Entra al stock sin deuda. Se
 *     resuelve cuando lo factura (la factura nueva lo ata y esas unidades no
 *     vuelven a entrar), devolviéndolo (sale del stock) o quedando sin cargo.
 *
 * Una resolución que nació de un papel se cae si ese papel se anula; las
 * cargadas a mano se deshacen a mano (y el stock vuelve). Anular el papel que
 * trajo las diferencias las anula, salvo que alguna ya esté resuelta.
 */
import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Injectable, Module, NotFoundException, Param, ParseIntPipe, Post, Query,
} from '@nestjs/common';
import { IsIn, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { and, desc, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { soloSuSucursal } from '../auth/auth.guard';
import { etiquetaDoc } from '../common/documentos';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  comprobanteItems, comprobantes, entregaDiferenciaResoluciones, entregaDiferencias, presentaciones, productos, proveedores, sucursales, usuarios,
} from '../db/schema';
import { InventarioModule } from '../inventario/inventario.module';
import { InventarioService } from '../inventario/inventario.service';
import { costosDeHoy } from '../inventario/costo-hoy';
import { VENTANA_OTRA_MITAD, tipoDeLaOtraMitad } from '../comprobantes/otra-mitad';
import { A_MANO, claveDe, movimientoDe, pendienteDe, repartirEntrega, type Como, type Renglon } from './diferencias';

const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const ESTADOS = ['pendientes', 'resueltas', 'todas'] as const;
type Filtro = (typeof ESTADOS)[number];
/** Lo resuelto (vivo) de cada diferencia. */
const RESUELTO = sql<number>`coalesce((select sum(r.cantidad) from entrega_diferencia_resoluciones r
  where r.diferencia_id = ${entregaDiferencias.id} and r.anulado_en is null), 0)::float8`;
const TEXTO_COMO: Record<Como, string> = {
  llego: 'Llegó', nota_credito: 'Nota de crédito', perdido: 'Dado por perdido', facturado: 'Facturado después', devuelto: 'Devuelto', sin_cargo: 'Sin cargo',
};

export class ResolverDiferenciaDto {
  @IsIn(['llego', 'perdido', 'devuelto', 'sin_cargo']) como!: Como;
  @IsNumber() @Min(0.001) cantidad!: number;
  @IsOptional() @IsString() @MaxLength(300) nota?: string;
}
/** Una diferencia pendiente que un papel nuevo cubre (la NC del faltante, la factura del sobrante). */
export type Cubre = { diferenciaId: number; cantidad: number };

@Injectable()
export class DiferenciasService {
  constructor(@Inject(DRIZZLE) private readonly db: Database, private readonly inv: InventarioService) {}

  /* ============================ Al cargar un papel ============================ */

  /**
   * LO QUE TRAJO LA OTRA MITAD de un proveedor mitad y mitad: el papel más
   * cercano (factura A ↔ liquidación, ±7 días) con recepción, y lo que ingresó
   * por producto. `id` es el que la pantalla mostró y sumó: si ya no es la otra
   * mitad, no se adivina. `conDiferencias`: ese papel ya marcó las suyas, así
   * que no se suma (se compararía dos veces; cada papel queda con lo suyo).
   */
  async otraMitadDeLaEntrega(ex: any, c: { proveedorId: number; tipo: string; letra?: string | null; fecha: Date | string }, id?: number | null) {
    const buscar = tipoDeLaOtraMitad(c.tipo, c.letra);
    if (!buscar) return null;
    const [prov] = await ex.select({ porc: proveedores.porcSinFactura, mensual: proveedores.facturaMensual }).from(proveedores).where(eq(proveedores.id, c.proveedorId)).limit(1);
    const porc = Number(prov?.porc) || 0;
    if (!(porc > 0 && porc < 100) || prov?.mensual) return null;
    const distancia = sql<number>`abs((${comprobantes.fecha} at time zone 'America/Argentina/Buenos_Aires')::date - (${new Date(c.fecha).toISOString()}::timestamptz at time zone 'America/Argentina/Buenos_Aires')::date)`;
    const [papel] = await ex.select({ c: comprobantes }).from(comprobantes).where(and(
      eq(comprobantes.proveedorId, c.proveedorId), eq(comprobantes.estado, 'confirmado'), eq(comprobantes.tipo, buscar as any),
      eq(comprobantes.recepcion, true),
      buscar === 'factura' ? eq(comprobantes.letra, 'A' as any) : undefined,
      id ? eq(comprobantes.id, id) : undefined,
      sql`${distancia} <= ${VENTANA_OTRA_MITAD}`,
    )).orderBy(distancia, desc(comprobantes.id)).limit(1);
    if (!papel) return null;
    const [ya] = await ex.select({ id: entregaDiferencias.id }).from(entregaDiferencias)
      .where(and(eq(entregaDiferencias.comprobanteId, papel.c.id), ne(entregaDiferencias.estado, 'anulada'))).limit(1);
    const filas = await ex.select({ productoId: comprobanteItems.productoId, presentacionId: comprobanteItems.presentacionId, cantidad: comprobanteItems.cantidad, noEntra: comprobanteItems.noEntra })
      .from(comprobanteItems).where(eq(comprobanteItems.comprobanteId, papel.c.id));
    const porClave = new Map<string, number>();
    for (const f of filas) {
      const k = claveDe(f.productoId, f.presentacionId);
      porClave.set(k, (porClave.get(k) ?? 0) + (Number(f.cantidad) || 0) - (Number(f.noEntra) || 0));
    }
    return { id: papel.c.id as number, etiqueta: etiquetaDoc(papel.c), conDiferencias: !!ya, porClave };
  }

  /** Las diferencias pendientes que un papel dice cubrir, con candado y validadas. */
  private async cubiertas(tx: any, proveedorId: number, tipo: 'faltante' | 'sobrante', cubre: Cubre[]) {
    if (!cubre.length) return [];
    const ids = [...new Set(cubre.map((x) => x.diferenciaId))];
    const filas = await tx.select({ d: entregaDiferencias, resuelto: RESUELTO }).from(entregaDiferencias)
      .where(inArray(entregaDiferencias.id, ids)).for('update', { of: entregaDiferencias });
    return cubre.map((x) => {
      const f = filas.find((r: any) => r.d.id === x.diferenciaId);
      if (!f || f.d.proveedorId !== proveedorId || f.d.tipo !== tipo || f.d.estado !== 'pendiente') {
        throw new BadRequestException('Una de las diferencias elegidas ya no está pendiente con este proveedor: actualizá la pantalla.');
      }
      const queda = pendienteDe(f.d.cantidad, f.resuelto);
      const cantidad = Number(x.cantidad) || 0;
      if (!(cantidad > 0) || cantidad > queda + 1e-6) {
        throw new BadRequestException(`De esa diferencia quedan ${queda} pendientes: no se pueden cubrir ${cantidad}.`);
      }
      return { ...f.d, cantidad };
    });
  }

  /**
   * LA ENTREGA DE UN PAPEL QUE INGRESA STOCK (factura, liquidación, remito).
   * Corre en la transacción del alta, ya con el comprobante creado y antes de
   * sus renglones: devuelve lo que no entra de cada renglón (`noEntra`), y deja
   * grabadas las diferencias nuevas, lo que vino de más adentro del stock y las
   * resoluciones de lo que este papel recién cobra.
   */
  async alCargarEntrega(tx: any, o: {
    comprobante: { id: number; tipo: string; letra: string | null; puntoVenta: string; numero: number | null; fecha: Date; proveedorId: number; sucursalId: number };
    usuarioId: number | null;
    items: { productoId: number; presentacionId?: number | null; cantidad: number; subtotal: number }[];
    /** Lo que queda del neto después de la bonificación general (1 = sin bonificación). */
    factorNeto: number;
    llegaron?: Renglon[] | null;
    /** El papel de la otra mitad que la pantalla sumó a lo que llegó (ver `otraMitadDeLaEntrega`). */
    otraMitadId?: number | null;
    cubreSobrantes?: Cubre[] | null;
  }) {
    const c = o.comprobante;
    const cubiertas = await this.cubiertas(tx, c.proveedorId, 'sobrante', o.cubreSobrantes ?? []);
    const cubiertos = new Map<string, number>();
    for (const d of cubiertas) {
      const k = claveDe(d.productoId, d.presentacionId);
      cubiertos.set(k, (cubiertos.get(k) ?? 0) + d.cantidad);
    }
    const llegaron = o.llegaron?.length ? o.llegaron : null;
    if (!llegaron && !cubiertas.length) return o.items.map(() => 0);
    let otraMitad: Map<string, number> | null = null;
    if (llegaron && o.otraMitadId) {
      const m = await this.otraMitadDeLaEntrega(tx, c, o.otraMitadId);
      if (!m || m.conDiferencias) throw new BadRequestException('La otra mitad que se sumó a lo que llegó ya no corresponde: actualizá la pantalla y volvé a contar.');
      otraMitad = m.porClave;
    }

    const r = repartirEntrega({ items: o.items, llegaron, cubiertos, otraMitad });
    const ids = [...new Set([...o.items, ...(llegaron ?? [])].map((x) => x.productoId))];
    const prods = await tx.select().from(productos).where(inArray(productos.id, ids));
    const prodDe = new Map<number, any>(prods.map((p: any) => [p.id, p]));
    const nombre = (id: number) => prodDe.get(id)?.nombre ?? `#${id}`;
    if (r.errores.length) {
      const e = r.errores[0];
      throw new BadRequestException(
        e.tipo === 'negativo' ? `Lo que llegó de ${nombre(e.productoId)} no puede ser negativo.`
          : e.tipo === 'cobra_mas_de_lo_que_entro' ? `Este papel trae ${e.puede} de ${nombre(e.productoId)}: no puede cobrar más de eso de lo que vino de más antes.`
            : `De ${nombre(e.productoId)} faltaría más de lo que trae este papel (${e.puede}): marcá el faltante en el papel de la otra mitad.`,
      );
    }
    for (const x of llegaron ?? []) {
      const prod = prodDe.get(x.productoId);
      if (!prod) throw new BadRequestException('Uno de los productos que llegaron ya no existe.');
      this.inv.exigirEntero(prod, x.presentacionId ?? null, Number(x.cantidad) || 0);
    }

    /* El neto por unidad que cobra el papel, con su bonificación: así se valoriza la diferencia. */
    const netoDe = new Map<string, { neto: number; cant: number }>();
    for (const it of o.items) {
      const k = claveDe(it.productoId, it.presentacionId);
      const a = netoDe.get(k) ?? { neto: 0, cant: 0 };
      a.neto += (Number(it.subtotal) || 0) * o.factorNeto;
      a.cant += Number(it.cantidad) || 0;
      netoDe.set(k, a);
    }
    const sinPapel = r.sobrantes.filter((x) => !netoDe.get(claveDe(x.productoId, x.presentacionId))?.cant);
    const deHoy = new Map((sinPapel.length ? await costosDeHoy(tx, sinPapel) : [])
      .map((x, i) => [claveDe(sinPapel[i].productoId, sinPapel[i].presentacionId), x.costoUnitario]));
    const costoDe = (x: Renglon) => {
      const k = claveDe(x.productoId, x.presentacionId);
      const n = netoDe.get(k);
      return n?.cant ? Math.round((n.neto / n.cant) * 1e4) / 1e4 : (deHoy.get(k) ?? 0);
    };
    const nuevas = [...r.faltantes.map((x) => ({ ...x, tipo: 'faltante' as const })), ...r.sobrantes.map((x) => ({ ...x, tipo: 'sobrante' as const }))];
    if (nuevas.length) {
      await tx.insert(entregaDiferencias).values(nuevas.map((x) => ({
        comprobanteId: c.id, proveedorId: c.proveedorId, sucursalId: c.sucursalId, productoId: x.productoId, presentacionId: x.presentacionId ?? null,
        tipo: x.tipo, cantidad: x.cantidad, costoUnitario: costoDe(x), usuarioId: o.usuarioId,
      })));
    }
    if (r.sobrantes.length) {
      await this.inv.reingresarStockItems(tx, {
        sucursalId: c.sucursalId, usuarioId: o.usuarioId, tipoMovimiento: 'compra',
        descripcion: `Vino de más con ${etiquetaDoc(c as any)}`, items: r.sobrantes,
      });
    }
    await this.resolverConPapel(tx, cubiertas, 'facturado', c.id, o.usuarioId);
    return r.noEntra;
  }

  /** La nota de crédito por un faltante: lo resuelve sin tocar el stock (nunca entró). */
  async alCargarNota(tx: any, c: { id: number; proveedorId: number }, cubre: Cubre[], usuarioId: number | null) {
    await this.resolverConPapel(tx, await this.cubiertas(tx, c.proveedorId, 'faltante', cubre), 'nota_credito', c.id, usuarioId);
  }

  private async resolverConPapel(tx: any, cubiertas: { id: number; cantidad: number }[], como: Como, comprobanteId: number, usuarioId: number | null) {
    if (!cubiertas.length) return;
    await tx.insert(entregaDiferenciaResoluciones).values(cubiertas.map((d) => ({
      diferenciaId: d.id, como, cantidad: d.cantidad, comprobanteId, usuarioId,
    })));
    await this.recalcular(tx, cubiertas.map((d) => d.id));
  }

  /** Resuelta cuando no le queda nada pendiente; pendiente otra vez si se deshizo algo (las anuladas no se tocan). */
  private async recalcular(tx: any, ids: number[]) {
    if (!ids.length) return;
    await tx.update(entregaDiferencias).set({
      estado: sql`case when ${entregaDiferencias.cantidad} - ${RESUELTO} > 0.000001 then 'pendiente' else 'resuelta' end`,
    }).where(and(inArray(entregaDiferencias.id, [...new Set(ids)]), ne(entregaDiferencias.estado, 'anulada')));
  }

  /* ============================ Al anular un papel ============================ */

  /**
   * Lo que la anulación de un papel tiene que saber: si sus diferencias ya se
   * resolvieron con otra cosa (frena: primero se deshace eso) y lo que vino de
   * más, que sale del stock junto con lo demás.
   */
  async planAnulacion(ex: any, comprobanteId: number) {
    const propias = await ex.select({ d: entregaDiferencias, nombre: productos.nombre }).from(entregaDiferencias)
      .innerJoin(productos, eq(productos.id, entregaDiferencias.productoId))
      .where(and(eq(entregaDiferencias.comprobanteId, comprobanteId), ne(entregaDiferencias.estado, 'anulada')));
    if (!propias.length) return { bloqueos: [] as string[], sobrantes: [] as Renglon[] };
    const resueltas = await ex.select({ diferenciaId: entregaDiferenciaResoluciones.diferenciaId }).from(entregaDiferenciaResoluciones).where(and(
      inArray(entregaDiferenciaResoluciones.diferenciaId, propias.map((p: any) => p.d.id)), isNull(entregaDiferenciaResoluciones.anuladoEn),
    ));
    const conResolucion = new Set(resueltas.map((x: any) => x.diferenciaId));
    const trabadas = propias.filter((p: any) => conResolucion.has(p.d.id));
    return {
      bloqueos: trabadas.length
        ? [`Tiene diferencias de entrega ya resueltas (${trabadas.map((p: any) => `${p.d.tipo === 'faltante' ? 'faltó' : 'vino de más'} ${p.nombre}`).join(', ')}): deshacé esas resoluciones en Proveedores › Cambios de mercadería, o anulá el papel que las resolvió.`]
        : [],
      sobrantes: propias.filter((p: any) => p.d.tipo === 'sobrante')
        .map((p: any) => ({ productoId: p.d.productoId, presentacionId: p.d.presentacionId, cantidad: Number(p.d.cantidad) })),
    };
  }

  /** La anulación de un papel: sus diferencias se anulan y lo que resolvió vuelve a quedar pendiente. */
  async alAnular(tx: any, comprobanteId: number, usuarioId: number | null) {
    await tx.update(entregaDiferencias).set({ estado: 'anulada' })
      .where(and(eq(entregaDiferencias.comprobanteId, comprobanteId), ne(entregaDiferencias.estado, 'anulada')));
    const caidas = await tx.update(entregaDiferenciaResoluciones).set({ anuladoEn: new Date(), anuladoPor: usuarioId })
      .where(and(eq(entregaDiferenciaResoluciones.comprobanteId, comprobanteId), isNull(entregaDiferenciaResoluciones.anuladoEn)))
      .returning({ diferenciaId: entregaDiferenciaResoluciones.diferenciaId });
    await this.recalcular(tx, caidas.map((x: any) => x.diferenciaId));
  }

  /* ============================ A mano ============================ */

  private async paraTocar(tx: any, id: number, s: Sesion) {
    const [f] = await tx.select({ d: entregaDiferencias, resuelto: RESUELTO, proveedor: proveedores.nombre, c: comprobantes })
      .from(entregaDiferencias)
      .innerJoin(proveedores, eq(proveedores.id, entregaDiferencias.proveedorId))
      .innerJoin(comprobantes, eq(comprobantes.id, entregaDiferencias.comprobanteId))
      .where(eq(entregaDiferencias.id, id)).for('update', { of: entregaDiferencias }).limit(1);
    if (!f) throw new NotFoundException('Esa diferencia no existe.');
    const mia = soloSuSucursal(s);
    if (mia != null && f.d.sucursalId !== mia) throw new ForbiddenException('Esa diferencia es de otra sucursal.');
    return f;
  }

  /** Lo que se resuelve sin papel: llegó lo que faltaba, se da por perdido, se devolvió o quedó sin cargo. */
  async resolver(id: number, dto: ResolverDiferenciaDto, s: Sesion) {
    await this.db.transaction(async (tx) => {
      const f = await this.paraTocar(tx, id, s);
      if (f.d.estado !== 'pendiente') throw new BadRequestException('Esa diferencia ya no está pendiente.');
      if (!A_MANO[f.d.tipo].includes(dto.como)) throw new BadRequestException('Esa forma de resolverla no corresponde a esta diferencia.');
      const queda = pendienteDe(f.d.cantidad, f.resuelto);
      const cantidad = Number(dto.cantidad);
      if (cantidad > queda + 1e-6) throw new BadRequestException(`Quedan ${queda} pendientes: no se pueden resolver ${cantidad}.`);
      await this.moverStock(tx, f, dto.como, cantidad, 1, s.usuarioId);
      await tx.insert(entregaDiferenciaResoluciones).values({ diferenciaId: id, como: dto.como, cantidad, nota: (dto.nota ?? '').trim(), usuarioId: s.usuarioId });
      await this.recalcular(tx, [id]);
    });
    return { ok: true };
  }

  /** Deshace una resolución cargada a mano (las de un papel se caen anulando ese papel): el stock vuelve. */
  async deshacer(resolucionId: number, s: Sesion) {
    await this.db.transaction(async (tx) => {
      const [res] = await tx.select().from(entregaDiferenciaResoluciones).where(eq(entregaDiferenciaResoluciones.id, resolucionId)).for('update').limit(1);
      if (!res || res.anuladoEn) throw new NotFoundException('Esa resolución no existe o ya se deshizo.');
      if (res.comprobanteId) throw new BadRequestException('Esta la resolvió un papel: se deshace anulando ese papel.');
      const f = await this.paraTocar(tx, res.diferenciaId, s);
      if (f.d.estado === 'anulada') throw new BadRequestException('Esa diferencia está anulada.');
      await this.moverStock(tx, f, res.como, Number(res.cantidad), -1, s.usuarioId);
      await tx.update(entregaDiferenciaResoluciones).set({ anuladoEn: new Date(), anuladoPor: s.usuarioId }).where(eq(entregaDiferenciaResoluciones.id, resolucionId));
      await this.recalcular(tx, [res.diferenciaId]);
    });
    return { ok: true };
  }

  /** El stock de una resolución a mano (`sentido` −1 la deshace): lo que faltaba entra, lo devuelto sale. */
  private async moverStock(tx: any, f: any, como: Como, cantidad: number, sentido: 1 | -1, usuarioId: number | null) {
    const mueve = movimientoDe(f.d.tipo, como) * sentido;
    if (!mueve) return;
    const [prod] = await tx.select().from(productos).where(eq(productos.id, f.d.productoId)).limit(1);
    this.inv.exigirEntero(prod, f.d.presentacionId, cantidad);
    const items = [{ productoId: f.d.productoId, presentacionId: f.d.presentacionId, cantidad }];
    const papel = etiquetaDoc(f.c);
    const descripcion = como === 'llego'
      ? (sentido > 0 ? `Llegó lo que faltaba de ${papel} (${f.proveedor})` : `Se deshizo «llegó lo que faltaba» de ${papel}`)
      : (sentido > 0 ? `Devuelto a ${f.proveedor}: vino de más con ${papel}` : `Se deshizo la devolución de lo que vino de más con ${papel}`);
    if (mueve > 0) {
      await this.inv.reingresarStockItems(tx, { sucursalId: f.d.sucursalId, usuarioId, tipoMovimiento: como === 'llego' ? 'compra' : 'devolucion', descripcion, items });
    } else {
      await this.inv.egresarStockItems(tx, { sucursalId: f.d.sucursalId, usuarioId, tipoMovimiento: como === 'llego' ? 'compra' : 'devolucion', descripcion, items });
    }
  }

  /* ============================ Consultas ============================ */

  /** Las diferencias con su producto, su papel y lo que queda; con `resoluciones`, también cómo se fue resolviendo. */
  async listar(q: { estado?: Filtro; proveedorId?: number; tipo?: 'faltante' | 'sobrante'; comprobanteIds?: number[]; conResoluciones?: boolean; limite?: number }) {
    const conds: SQL[] = [];
    if (q.estado === 'pendientes') conds.push(eq(entregaDiferencias.estado, 'pendiente'));
    else if (q.estado === 'resueltas') conds.push(eq(entregaDiferencias.estado, 'resuelta'));
    else conds.push(ne(entregaDiferencias.estado, 'anulada'));
    if (q.proveedorId) conds.push(eq(entregaDiferencias.proveedorId, q.proveedorId));
    if (q.tipo) conds.push(eq(entregaDiferencias.tipo, q.tipo));
    if (q.comprobanteIds) conds.push(q.comprobanteIds.length ? inArray(entregaDiferencias.comprobanteId, q.comprobanteIds) : sql`false`);
    const base = this.db.select({
      d: entregaDiferencias, resuelto: RESUELTO, producto: productos.nombre, tipoProducto: productos.tipo, tamKg: presentaciones.tamKg,
      proveedor: proveedores.nombre, sucursal: sucursales.nombre,
      c: { id: comprobantes.id, tipo: comprobantes.tipo, letra: comprobantes.letra, puntoVenta: comprobantes.puntoVenta, numero: comprobantes.numero, fecha: comprobantes.fecha },
    }).from(entregaDiferencias)
      .innerJoin(productos, eq(productos.id, entregaDiferencias.productoId))
      .leftJoin(presentaciones, eq(presentaciones.id, entregaDiferencias.presentacionId))
      .innerJoin(proveedores, eq(proveedores.id, entregaDiferencias.proveedorId))
      .innerJoin(sucursales, eq(sucursales.id, entregaDiferencias.sucursalId))
      .innerJoin(comprobantes, eq(comprobantes.id, entregaDiferencias.comprobanteId))
      .where(and(...conds)).orderBy(desc(entregaDiferencias.creadoEn), desc(entregaDiferencias.id));
    const filas = await (q.limite ? base.limit(q.limite) : base);
    const resoluciones = q.conResoluciones && filas.length ? await this.resolucionesDe(filas.map((f) => f.d.id)) : [];
    return filas.map((f) => {
      const pendiente = f.d.estado === 'pendiente' ? pendienteDe(f.d.cantidad, f.resuelto) : 0;
      return {
        id: f.d.id, tipo: f.d.tipo, estado: f.d.estado, creadoEn: f.d.creadoEn,
        proveedorId: f.d.proveedorId, proveedor: f.proveedor, sucursalId: f.d.sucursalId, sucursal: f.sucursal,
        productoId: f.d.productoId, presentacionId: f.d.presentacionId, producto: f.producto, tipoProducto: f.tipoProducto, tamKg: f.tamKg,
        comprobanteId: f.c.id, papel: etiquetaDoc(f.c as any), fechaPapel: f.c.fecha,
        cantidad: Number(f.d.cantidad), resuelto: Number(f.resuelto), pendiente, costoUnitario: Number(f.d.costoUnitario),
        valorPendiente: money(pendiente * Number(f.d.costoUnitario)),
        ...(q.conResoluciones ? { resoluciones: resoluciones.filter((r) => r.diferenciaId === f.d.id) } : {}),
      };
    });
  }

  private async resolucionesDe(ids: number[]) {
    const filas = await this.db.select({
      r: entregaDiferenciaResoluciones, quien: usuarios.nombre,
      c: { id: comprobantes.id, tipo: comprobantes.tipo, letra: comprobantes.letra, puntoVenta: comprobantes.puntoVenta, numero: comprobantes.numero },
    }).from(entregaDiferenciaResoluciones)
      .leftJoin(usuarios, eq(usuarios.id, entregaDiferenciaResoluciones.usuarioId))
      .leftJoin(comprobantes, eq(comprobantes.id, entregaDiferenciaResoluciones.comprobanteId))
      .where(inArray(entregaDiferenciaResoluciones.diferenciaId, ids))
      .orderBy(entregaDiferenciaResoluciones.fecha);
    return filas.map((f) => ({
      id: f.r.id, diferenciaId: f.r.diferenciaId, como: f.r.como, texto: TEXTO_COMO[f.r.como], cantidad: Number(f.r.cantidad),
      fecha: f.r.fecha, nota: f.r.nota, quien: f.quien ?? '', anulada: !!f.r.anuladoEn,
      papel: f.c?.id ? etiquetaDoc(f.c as any) : null, aMano: !f.r.comprobanteId,
    }));
  }

  /** Lo que un papel cubrió de diferencias de otros (la NC de un faltante, la factura de lo que vino de más). */
  async cubiertasPor(comprobanteId: number) {
    const filas = await this.db.select({
      r: entregaDiferenciaResoluciones, d: entregaDiferencias, producto: productos.nombre,
      c: { id: comprobantes.id, tipo: comprobantes.tipo, letra: comprobantes.letra, puntoVenta: comprobantes.puntoVenta, numero: comprobantes.numero },
    }).from(entregaDiferenciaResoluciones)
      .innerJoin(entregaDiferencias, eq(entregaDiferencias.id, entregaDiferenciaResoluciones.diferenciaId))
      .innerJoin(productos, eq(productos.id, entregaDiferencias.productoId))
      .innerJoin(comprobantes, eq(comprobantes.id, entregaDiferencias.comprobanteId))
      .where(eq(entregaDiferenciaResoluciones.comprobanteId, comprobanteId));
    return filas.map((f) => ({
      id: f.r.id, tipo: f.d.tipo, como: f.r.como, texto: TEXTO_COMO[f.r.como], producto: f.producto, presentacionId: f.d.presentacionId,
      cantidad: Number(f.r.cantidad), papel: etiquetaDoc(f.c as any), anulada: !!f.r.anuladoEn,
    }));
  }

  /** Por proveedor, lo pendiente a costo: lo que te debe (faltantes) y lo que le debés (vino de más). */
  async pendientesPorProveedor() {
    const filas = await this.db.select({
      proveedorId: entregaDiferencias.proveedorId, tipo: entregaDiferencias.tipo,
      valor: sql<number>`sum(greatest(0, ${entregaDiferencias.cantidad} - ${RESUELTO}) * ${entregaDiferencias.costoUnitario})::float8`,
    }).from(entregaDiferencias).where(eq(entregaDiferencias.estado, 'pendiente'))
      .groupBy(entregaDiferencias.proveedorId, entregaDiferencias.tipo);
    const por = new Map<number, { faltantes: number; sobrantes: number }>();
    for (const f of filas) {
      const x = por.get(f.proveedorId) ?? { faltantes: 0, sobrantes: 0 };
      if (f.tipo === 'faltante') x.faltantes = money(f.valor); else x.sobrantes = money(f.valor);
      por.set(f.proveedorId, x);
    }
    return por;
  }
}

@Controller('diferencias-entrega')
@Permiso('proveedores.pedidos')
export class DiferenciasController {
  constructor(private readonly svc: DiferenciasService) {}

  @Get() listar(@Query('estado') estado?: string, @Query('proveedorId') proveedorId?: string) {
    const filtro = (ESTADOS as readonly string[]).includes(String(estado)) ? (estado as Filtro) : 'pendientes';
    return this.svc.listar({ estado: filtro, proveedorId: Number(proveedorId) || undefined, conResoluciones: true, limite: 400 });
  }

  @Post(':id/resolver')
  resolver(@Param('id', ParseIntPipe) id: number, @Body() dto: ResolverDiferenciaDto, @Auth() s: Sesion) { return this.svc.resolver(id, dto, s); }

  @Post('resoluciones/:id/deshacer')
  deshacer(@Param('id', ParseIntPipe) id: number, @Auth() s: Sesion) { return this.svc.deshacer(id, s); }
}

@Module({
  imports: [InventarioModule],
  controllers: [DiferenciasController],
  providers: [DiferenciasService],
  exports: [DiferenciasService],
})
export class DiferenciasModule {}
