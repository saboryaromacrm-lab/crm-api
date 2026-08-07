/**
 * PAGOS A PROVEEDORES
 * ============================================================================
 * Un solo registro para toda la plata que sale hacia un proveedor, sin importar
 * por dónde salga (el cajón de la sucursal, una transferencia del admin) ni
 * contra qué termine aplicándose (una factura de mercadería o un gasto).
 *
 * El caso que lo motiva:
 *
 *   10:40 · Sucursal Centro. Llega el pedido de Coca-Cola. La cajera paga
 *   $100.000 del cajón. NO carga la factura: no le corresponde. Registra el
 *   PAGO — proveedor, importe, concepto — y sigue vendiendo. El arqueo de su
 *   turno ya muestra el egreso, con la hora exacta y su nombre.
 *
 *   Día siguiente · El admin carga la factura de Coca-Cola. El sistema le
 *   avisa que ese proveedor tiene $100.000 sin aplicar y los imputa.
 *
 * Reglas que sostienen el circuito (romper una rompe la contabilidad):
 *
 *   · La plata sale UNA vez: al crear el pago. Imputar no vuelve a mover plata.
 *   · Un pago sin imputar NO es gasto ni costo — es un crédito contra el
 *     proveedor. El gasto lo genera el documento, siempre.
 *   · Los totales (`aplicado`, `pagado`) se RECALCULAN sumando las
 *     imputaciones. Nunca se suman deltas: un recálculo no se desincroniza.
 *   · El pago solo se imputa a documentos DEL MISMO proveedor.
 */
import {
  BadRequestException, Body, Controller, Delete, Get, Inject, Injectable, Module,
  NotFoundException, Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, ValidateNested,
} from 'class-validator';
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  cajaMovimientos, cajaSesiones, comprobantes, gastos, proveedorImputaciones,
  proveedorPagos, proveedores, sucursales, usuarios,
} from '../db/schema';

const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
/** Tolerancia de centavo: los importes son double y no hay que pelearse con eso. */
const EPS = 0.009;

const MEDIOS = ['efectivo', 'transferencia', 'tarjeta_debito', 'tarjeta_credito', 'cheque', 'qr', 'otro'] as const;

/* --------------------------------- DTOs --------------------------------- */

export class ImputacionDto {
  @IsOptional() @IsInt() gastoId?: number;
  @IsOptional() @IsInt() comprobanteId?: number;
  @IsNumber() importe!: number;
}

export class CrearPagoDto {
  @IsOptional() @IsInt() proveedorId?: number;
  /**
   * A qué mundo va la plata: compras de mercadería o gastos. Lo elige quien
   * paga (la cajera sabe si le pagó al de las gaseosas o al plomero); si no
   * viene, se infiere de la imputación o de las marcas del proveedor.
   */
  @IsOptional() @IsIn(['mercaderia', 'gastos']) destino?: 'mercaderia' | 'gastos';
  @IsNumber() importe!: number;
  @IsOptional() @IsIn(MEDIOS as unknown as string[]) medio?: string;
  @IsOptional() @IsString() fecha?: string;
  @IsOptional() @IsString() concepto?: string;
  @IsOptional() @IsString() referencia?: string;
  @IsOptional() @IsInt() sucursalId?: number;
  /** Turno del que sale el efectivo: genera el egreso en esa caja. */
  @IsOptional() @IsInt() cajaSesionId?: number;
  @IsOptional() @IsInt() usuarioId?: number;
  @IsOptional() @IsString() observaciones?: string;
  /** Imputación en el mismo acto (pagar una factura que ya está cargada). */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ImputacionDto)
  imputaciones?: ImputacionDto[];
}

export class ImputarDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ImputacionDto)
  imputaciones!: ImputacionDto[];
  @IsOptional() @IsInt() usuarioId?: number;
}

/* ------------------------------- Servicio ------------------------------- */

@Injectable()
export class PagosProveedorService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /* ==================================================================== *
   * Recálculo — el corazón de la consistencia
   * ==================================================================== *
   * Los tres totales desnormalizados se rehacen SUMANDO las imputaciones que
   * existen ahora. Da igual si la operación fue alta, baja o corrección: el
   * resultado siempre es el que dice la tabla de imputaciones.
   */

  private async recalcularPago(tx: any, pagoId: number) {
    const [r] = await tx.select({ total: sql<number>`coalesce(sum(${proveedorImputaciones.importe}), 0)` })
      .from(proveedorImputaciones).where(eq(proveedorImputaciones.pagoId, pagoId));
    await tx.update(proveedorPagos).set({ aplicado: money(Number(r?.total) || 0) })
      .where(eq(proveedorPagos.id, pagoId));
  }

  private async recalcularGasto(tx: any, gastoId: number) {
    const [r] = await tx.select({ total: sql<number>`coalesce(sum(${proveedorImputaciones.importe}), 0)` })
      .from(proveedorImputaciones)
      .innerJoin(proveedorPagos, eq(proveedorPagos.id, proveedorImputaciones.pagoId))
      .where(and(eq(proveedorImputaciones.gastoId, gastoId), eq(proveedorPagos.estado, 'activo')));
    const pagado = money(Number(r?.total) || 0);
    const [g] = await tx.select().from(gastos).where(eq(gastos.id, gastoId)).limit(1);
    if (!g) return;
    await tx.update(gastos).set({
      pagado,
      // Un gasto anulado no vuelve a la vida por una imputación.
      estado: g.estado === 'anulado' ? 'anulado' : (pagado >= money(g.total) - EPS ? 'pagado' : 'pendiente'),
    }).where(eq(gastos.id, gastoId));
  }

  /**
   * EL AJUSTE QUE LE HICIERON SUS NOTAS a un comprobante: la ND suma, la NC
   * resta. Va con `tx` porque la validación de "no le podés aplicar más" corre
   * dentro de la transacción que imputa, y ahí el saldo tiene que ser el de este
   * instante — no el de cuando se pintó la pantalla.
   */
  private async ajusteDe(tx: any, comprobanteId: number) {
    const [r] = await tx.select({
      total: sql<number>`coalesce(sum(case when ${comprobantes.tipo} = 'nota_debito' then ${comprobantes.total} else -${comprobantes.total} end), 0)`,
    }).from(comprobantes).where(and(
      eq(comprobantes.refComprobanteId, comprobanteId),
      inArray(comprobantes.tipo, ['nota_credito', 'nota_debito']),
      eq(comprobantes.estado, 'confirmado'),
    ));
    return money(Number(r?.total) || 0);
  }

  private async recalcularComprobante(tx: any, comprobanteId: number) {
    const [r] = await tx.select({ total: sql<number>`coalesce(sum(${proveedorImputaciones.importe}), 0)` })
      .from(proveedorImputaciones)
      .innerJoin(proveedorPagos, eq(proveedorPagos.id, proveedorImputaciones.pagoId))
      .where(and(eq(proveedorImputaciones.comprobanteId, comprobanteId), eq(proveedorPagos.estado, 'activo')));
    await tx.update(comprobantes).set({ pagado: money(Number(r?.total) || 0) })
      .where(eq(comprobantes.id, comprobanteId));
  }

  /* ==================================================================== *
   * Lectura
   * ==================================================================== */

  /** Pago con las etiquetas ya resueltas: la UI no tiene que salir a buscarlas. */
  private get selectPago() {
    return {
      id: proveedorPagos.id,
      fecha: proveedorPagos.fecha,
      proveedorId: proveedorPagos.proveedorId,
      proveedorNombre: sql<string>`coalesce(${proveedores.nombre}, 'Sin proveedor')`,
      medio: proveedorPagos.medio,
      destino: proveedorPagos.destino,
      importe: proveedorPagos.importe,
      aplicado: proveedorPagos.aplicado,
      concepto: proveedorPagos.concepto,
      referencia: proveedorPagos.referencia,
      sucursalId: proveedorPagos.sucursalId,
      sucursalNombre: sql<string>`coalesce(${sucursales.nombre}, '')`,
      cajaSesionId: proveedorPagos.cajaSesionId,
      cajaMovimientoId: proveedorPagos.cajaMovimientoId,
      usuarioId: proveedorPagos.usuarioId,
      usuarioNombre: sql<string>`coalesce(${usuarios.nombre}, '')`,
      estado: proveedorPagos.estado,
      observaciones: proveedorPagos.observaciones,
    };
  }

  private baseQuery() {
    return this.db.select(this.selectPago).from(proveedorPagos)
      .leftJoin(proveedores, eq(proveedores.id, proveedorPagos.proveedorId))
      .leftJoin(sucursales, eq(sucursales.id, proveedorPagos.sucursalId))
      .leftJoin(usuarios, eq(usuarios.id, proveedorPagos.usuarioId));
  }

  async list(q: any = {}) {
    const conds: any[] = [];
    if (q.proveedorId) conds.push(eq(proveedorPagos.proveedorId, Number(q.proveedorId)));
    if (q.sucursalId) conds.push(eq(proveedorPagos.sucursalId, Number(q.sucursalId)));
    if (q.cajaSesionId) conds.push(eq(proveedorPagos.cajaSesionId, Number(q.cajaSesionId)));
    if (q.destino) conds.push(eq(proveedorPagos.destino, q.destino));
    if (q.estado) conds.push(eq(proveedorPagos.estado, q.estado));
    if (q.desde) conds.push(sql`${proveedorPagos.fecha} >= ${new Date(q.desde).toISOString()}`);
    if (q.hasta) conds.push(sql`${proveedorPagos.fecha} <= ${new Date(`${String(q.hasta).slice(0, 10)}T23:59:59.999`).toISOString()}`);
    // La bandeja que importa: lo que se pagó y todavía no se aplicó a nada.
    if (q.sinAplicar === 'true' || q.sinAplicar === true) {
      conds.push(eq(proveedorPagos.estado, 'activo'));
      conds.push(sql`${proveedorPagos.importe} - ${proveedorPagos.aplicado} > ${EPS}`);
    }
    const limit = Math.min(Math.max(Number(q.limit) || 300, 1), 1000);
    const filas = await this.baseQuery()
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(proveedorPagos.fecha), desc(proveedorPagos.id))
      .limit(limit);
    if (!filas.length) return [];

    /*
     * A qué documento fue cada pago, para TODOS los listados en una consulta.
     * Es la contracara de la traza que muestra la factura: desde el pago se ve
     * qué comprobante lo explica, y si quedó partido entre varios.
     */
    const destinos = await this.destinosDe(filas.map((p) => p.id));
    return filas.map((p) => ({
      ...p,
      saldo: money(p.importe - p.aplicado),
      imputadoA: destinos.get(p.id) ?? [],
    }));
  }

  /** `{ pagoId => [{ etiqueta, importe }] }` en una sola consulta. */
  private async destinosDe(ids: number[]) {
    const porId = new Map<number, Array<{ etiqueta: string; importe: number }>>();
    if (!ids.length) return porId;

    const filas = await this.db.select({
      pagoId: proveedorImputaciones.pagoId,
      importe: proveedorImputaciones.importe,
      gastoId: proveedorImputaciones.gastoId,
      gastoNumero: gastos.numero,
      comprobanteId: proveedorImputaciones.comprobanteId,
      tipo: comprobantes.tipo,
      letra: comprobantes.letra,
      puntoVenta: comprobantes.puntoVenta,
      numero: comprobantes.numero,
    })
      .from(proveedorImputaciones)
      .leftJoin(gastos, eq(gastos.id, proveedorImputaciones.gastoId))
      .leftJoin(comprobantes, eq(comprobantes.id, proveedorImputaciones.comprobanteId))
      .where(inArray(proveedorImputaciones.pagoId, ids))
      .orderBy(proveedorImputaciones.id);

    for (const f of filas) {
      const etiqueta = f.gastoId
        ? `Gasto #${f.gastoId}${f.gastoNumero ? ` · ${f.gastoNumero}` : ''}`
        : `${f.tipo === 'nota_debito' ? 'ND' : 'Factura'} ${f.letra ?? ''} ${f.puntoVenta ?? ''}-${f.numero ?? f.comprobanteId}`.trim();
      const arr = porId.get(f.pagoId) ?? [];
      arr.push({ etiqueta, importe: f.importe });
      porId.set(f.pagoId, arr);
    }
    return porId;
  }

  async get(id: number) {
    const [p] = await this.baseQuery().where(eq(proveedorPagos.id, id)).limit(1);
    if (!p) throw new NotFoundException('Pago inexistente.');
    return { ...p, saldo: money(p.importe - p.aplicado), imputaciones: await this.imputacionesDe(id) };
  }

  /** Imputaciones del pago con la identidad del documento al que fueron. */
  private async imputacionesDe(pagoId: number) {
    const filas = await this.db.select({
      id: proveedorImputaciones.id,
      importe: proveedorImputaciones.importe,
      fecha: proveedorImputaciones.fecha,
      gastoId: proveedorImputaciones.gastoId,
      comprobanteId: proveedorImputaciones.comprobanteId,
      gastoDescripcion: gastos.descripcion,
      gastoNumero: gastos.numero,
      comprobanteTipo: comprobantes.tipo,
      comprobantePv: comprobantes.puntoVenta,
      comprobanteNumero: comprobantes.numero,
    }).from(proveedorImputaciones)
      .leftJoin(gastos, eq(gastos.id, proveedorImputaciones.gastoId))
      .leftJoin(comprobantes, eq(comprobantes.id, proveedorImputaciones.comprobanteId))
      .where(eq(proveedorImputaciones.pagoId, pagoId))
      .orderBy(proveedorImputaciones.id);

    return filas.map((f) => ({
      id: f.id,
      importe: f.importe,
      fecha: f.fecha,
      tipo: f.gastoId ? 'gasto' : 'comprobante',
      docId: f.gastoId ?? f.comprobanteId,
      etiqueta: f.gastoId
        ? `Gasto #${f.gastoId}${f.gastoNumero ? ` · ${f.gastoNumero}` : ''}${f.gastoDescripcion ? ` · ${f.gastoDescripcion}` : ''}`
        : `${f.comprobanteTipo ?? 'comprobante'} ${f.comprobantePv ?? ''}-${f.comprobanteNumero ?? f.comprobanteId}`,
    }));
  }

  /** Pagos de un proveedor con saldo sin aplicar: lo que se puede usar hoy. */
  async disponibles(proveedorId: number, destino?: string) {
    return this.list({ proveedorId, destino, sinAplicar: true, limit: 200 });
  }

  /**
   * Documentos de ese proveedor que todavía deben plata: gastos y facturas o
   * notas de débito de compra. Las notas de crédito no se pagan (restan deuda),
   * así que no aparecen acá.
   *
   * `destino` acota al mundo del pago que se está por aplicar: un pago de
   * mercadería solo puede ir a comprobantes, uno de gastos solo a gastos —
   * listar lo que la aplicación va a rechazar sería ofrecer un botón roto.
   */
  async documentosPendientes(proveedorId: number, destino?: string) {
    const [gs, cs] = await Promise.all([
      destino === 'mercaderia' ? [] : this.db.select().from(gastos).where(and(
        eq(gastos.proveedorId, proveedorId),
        ne(gastos.estado, 'anulado'),
        sql`${gastos.total} - ${gastos.pagado} > ${EPS}`,
      )).orderBy(gastos.fecha),
      /*
       * EL SALDO DE LA FACTURA DESCUENTA SUS NOTAS.
       * ------------------------------------------------------------------------
       * `total - pagado` no alcanzaba: una NC de $50.000 contra una factura de
       * $200.000 restaba de la deuda TOTAL del proveedor, pero acá la factura
       * seguía ofreciendo $200.000 — y el que paga factura por factura le pagaba
       * de más. Ahora el saldo suma las ND y resta las NC que la referencian.
       *
       * Y la ND que referencia una factura NO se lista aparte: su importe ya
       * está sumado en el saldo de esa factura, así que listarla también sería
       * cobrarla dos veces. La ND sin referencia sí sigue siendo un documento
       * pagable por sí mismo (un ajuste general del proveedor).
       *
       * NO se filtra el saldo en SQL a propósito. Se probó con una subconsulta
       * correlacionada y **falló en silencio**: Drizzle renderiza la columna del
       * SELECT sin calificar (`"id"`), así que dentro de la subconsulta esa `id`
       * resolvía a la fila de ADENTRO y la condición quedaba
       * `n.ref_comprobante_id = n.id` — nunca verdadera, ajuste siempre 0, sin
       * ningún error. El ajuste se calcula abajo en JS: es una consulta más, el
       * conjunto es de UN proveedor, y no hay correlación que se rompa sola.
       *
       * Tampoco se prefiltra por `total - pagado > 0`: una factura ya pagada a la
       * que después le llega una ND vuelve a deber, y ese prefiltro la habría
       * escondido.
       */
      destino === 'gastos' ? [] : this.db.select().from(comprobantes).where(and(
        eq(comprobantes.proveedorId, proveedorId),
        eq(comprobantes.estado, 'confirmado'),
        inArray(comprobantes.tipo, ['factura', 'nota_debito']),
        // La ND que ajusta una factura vive dentro del saldo de esa factura.
        or(ne(comprobantes.tipo, 'nota_debito'), isNull(comprobantes.refComprobanteId)),
      )).orderBy(comprobantes.fecha),
    ]);

    /* Lo que las notas le sumaron o restaron a cada uno de esos documentos. */
    const ajustes = new Map<number, number>();
    if (cs.length) {
      const notas = await this.db.select({
        ref: comprobantes.refComprobanteId,
        tipo: comprobantes.tipo,
        total: comprobantes.total,
      }).from(comprobantes).where(and(
        inArray(comprobantes.refComprobanteId, cs.map((c) => c.id)),
        inArray(comprobantes.tipo, ['nota_credito', 'nota_debito']),
        eq(comprobantes.estado, 'confirmado'),
      ));
      for (const n of notas) {
        const signo = n.tipo === 'nota_debito' ? 1 : -1;
        ajustes.set(n.ref!, money((ajustes.get(n.ref!) ?? 0) + signo * n.total));
      }
    }

    return [
      ...gs.map((g) => ({
        tipo: 'gasto' as const,
        docId: g.id,
        fecha: g.fecha,
        vencimiento: g.vencimiento,
        etiqueta: `Gasto #${g.id}${g.numero ? ` · ${g.numero}` : ''}`,
        detalle: g.descripcion,
        total: g.total,
        pagado: g.pagado,
        saldo: money(g.total - g.pagado),
      })),
      ...cs.map((c) => {
        const ajuste = ajustes.get(c.id) ?? 0;
        return {
          tipo: 'comprobante' as const,
          docId: c.id,
          fecha: c.fecha,
          vencimiento: c.vencimientoPago,
          etiqueta: `${c.tipo === 'nota_debito' ? 'ND' : 'Factura'} ${c.letra} ${c.puntoVenta}-${c.numero ?? c.id}`,
          detalle: c.observaciones,
          total: c.total,
          pagado: c.pagado,
          // Lo que le sumaron o restaron sus notas. Viaja para que la pantalla
          // pueda decir POR QUÉ el saldo no es total − pagado.
          ajuste: money(ajuste),
          saldo: money(c.total + ajuste - c.pagado),
        };
      // Saldado (o dado vuelta por una NC grande) no se ofrece para pagar.
      }).filter((d) => d.saldo > EPS),
    ].sort((a, b) => new Date(a.fecha).getTime() - new Date(b.fecha).getTime());
  }

  /**
   * Cuenta corriente REAL del proveedor: lo que se le compró (mercadería y
   * gastos) menos lo que se le pagó. Hasta ahora el saldo solo podía crecer
   * porque no había dónde registrar los pagos.
   */
  async cuenta(proveedorId: number) {
    const [comp, gast, pag] = await Promise.all([
      this.db.select({
        deuda: sql<number>`coalesce(sum(case when ${comprobantes.tipo} in ('factura','nota_debito') then ${comprobantes.total} when ${comprobantes.tipo} = 'nota_credito' then -${comprobantes.total} else 0 end), 0)`,
      }).from(comprobantes).where(and(
        eq(comprobantes.proveedorId, proveedorId),
        eq(comprobantes.estado, 'confirmado'),
      )),
      this.db.select({ deuda: sql<number>`coalesce(sum(${gastos.total}), 0)` })
        .from(gastos).where(and(eq(gastos.proveedorId, proveedorId), ne(gastos.estado, 'anulado'))),
      this.db.select({
        pagado: sql<number>`coalesce(sum(${proveedorPagos.importe}), 0)`,
        sinAplicar: sql<number>`coalesce(sum(${proveedorPagos.importe} - ${proveedorPagos.aplicado}), 0)`,
      }).from(proveedorPagos).where(and(
        eq(proveedorPagos.proveedorId, proveedorId),
        eq(proveedorPagos.estado, 'activo'),
      )),
    ]);

    const mercaderia = money(Number(comp[0]?.deuda) || 0);
    const gastosTotal = money(Number(gast[0]?.deuda) || 0);
    const pagado = money(Number(pag[0]?.pagado) || 0);
    return {
      proveedorId,
      mercaderia,
      gastos: gastosTotal,
      comprado: money(mercaderia + gastosTotal),
      pagado,
      // Positivo = se le debe. Negativo = se le pagó de más (queda a favor).
      saldo: money(mercaderia + gastosTotal - pagado),
      sinAplicar: money(Number(pag[0]?.sinAplicar) || 0),
    };
  }

  /** Contador liviano para el aviso del CRM: cuánta plata está sin rendir. */
  async resumenSinAplicar(destino?: string) {
    const conds: any[] = [
      eq(proveedorPagos.estado, 'activo'),
      sql`${proveedorPagos.importe} - ${proveedorPagos.aplicado} > ${EPS}`,
    ];
    if (destino === 'mercaderia' || destino === 'gastos') {
      conds.push(eq(proveedorPagos.destino, destino));
    }
    const [r] = await this.db.select({
      cantidad: sql<number>`count(*)::int`,
      total: sql<number>`coalesce(sum(${proveedorPagos.importe} - ${proveedorPagos.aplicado}), 0)`,
    }).from(proveedorPagos).where(and(...conds));
    return { cantidad: Number(r?.cantidad) || 0, total: money(Number(r?.total) || 0) };
  }

  /* ==================================================================== *
   * Escritura
   * ==================================================================== */

  async crear(dto: CrearPagoDto) {
    const importe = money(dto.importe);
    if (importe <= 0) throw new BadRequestException('El importe del pago tiene que ser mayor a 0.');

    let proveedorId: number | null = null;
    let prov: any = null;
    if (dto.proveedorId) {
      [prov] = await this.db.select().from(proveedores).where(eq(proveedores.id, Number(dto.proveedorId))).limit(1);
      if (!prov) throw new BadRequestException('Proveedor inválido.');
      proveedorId = prov.id;
    }
    // Un pago que va a quedar a cuenta necesita saber DE QUIÉN es esa cuenta.
    if (!proveedorId && !dto.imputaciones?.length) {
      throw new BadRequestException(
        'Elegí el proveedor: un pago a cuenta necesita saber a quién se le pagó para poder aplicarlo después.',
      );
    }

    /*
     * El destino explícito manda. Sin él, la mejor evidencia es a qué se
     * imputa en el mismo acto; y si tampoco hay imputación, las marcas del
     * proveedor (el que SOLO factura gastos no puede ser de mercadería).
     */
    const provSoloGastos = prov?.proveeGastos && !prov?.proveeMercaderia;
    const destino: 'mercaderia' | 'gastos' = dto.destino
      ?? (dto.imputaciones?.some((x) => x.gastoId) ? 'gastos'
        : dto.imputaciones?.some((x) => x.comprobanteId) ? 'mercaderia'
          : (provSoloGastos || !proveedorId) ? 'gastos' : 'mercaderia');

    const medio = (dto.medio ?? 'efectivo') as any;
    const id = await this.db.transaction(async (tx) => {
      let cajaMovimientoId: number | null = null;
      let cajaSesionId: number | null = null;
      let sucursalId: number | null = dto.sucursalId ?? null;

      /*
       * Efectivo desde un turno abierto: la plata sale del cajón, así que el
       * arqueo lo tiene que ver. El egreso se crea en la MISMA transacción —
       * un pago registrado sin su egreso descuadraría la caja de esa noche.
       */
      if (medio === 'efectivo' && dto.cajaSesionId) {
        const [sesion] = await tx.select().from(cajaSesiones)
          .where(eq(cajaSesiones.id, Number(dto.cajaSesionId))).limit(1);
        if (!sesion) throw new BadRequestException('Turno de caja inexistente.');
        if (sesion.estado !== 'abierta') {
          throw new BadRequestException('Ese turno de caja está cerrado: no se le pueden cargar egresos.');
        }
        const nombreProv = prov?.nombre ?? '';
        const [mov] = await tx.insert(cajaMovimientos).values({
          cajaSesionId: sesion.id,
          tipo: 'egreso',
          importe,
          motivo: `Pago a proveedor${nombreProv ? ` · ${nombreProv}` : ''}${dto.concepto ? ` · ${dto.concepto.trim()}` : ''}`,
          usuarioId: dto.usuarioId ?? null,
        }).returning();
        cajaMovimientoId = mov.id;
        cajaSesionId = sesion.id;
        sucursalId = sucursalId ?? sesion.sucursalId;
      }

      const [pago] = await tx.insert(proveedorPagos).values({
        fecha: dto.fecha ? new Date(dto.fecha) : undefined,
        proveedorId,
        medio,
        destino,
        importe,
        aplicado: 0,
        concepto: (dto.concepto ?? '').trim(),
        referencia: (dto.referencia ?? '').trim(),
        sucursalId,
        cajaSesionId,
        cajaMovimientoId,
        usuarioId: dto.usuarioId ?? null,
        estado: 'activo',
        observaciones: (dto.observaciones ?? '').trim(),
      }).returning();

      if (dto.imputaciones?.length) {
        await this.aplicar(tx, pago.id, dto.imputaciones, dto.usuarioId);
      }
      return pago.id;
    });
    return this.get(id);
  }

  /**
   * Aplica un pago a uno o varios documentos. Cada imputación se valida contra
   * el saldo VIVO del pago y del documento (recalculados después de cada una),
   * así aplicar tres cosas de una no puede pasarse del total por redondeo ni
   * por dos pedidos simultáneos.
   */
  private async aplicar(tx: any, pagoId: number, items: ImputacionDto[], usuarioId?: number) {
    for (const item of items) {
      const importe = money(item.importe);
      if (importe <= 0) throw new BadRequestException('El importe a aplicar tiene que ser mayor a 0.');
      if (!item.gastoId && !item.comprobanteId) throw new BadRequestException('Indicá a qué documento se aplica.');
      if (item.gastoId && item.comprobanteId) throw new BadRequestException('Una imputación va a un solo documento.');

      const [pago] = await tx.select().from(proveedorPagos).where(eq(proveedorPagos.id, pagoId)).limit(1);
      if (!pago) throw new NotFoundException('Pago inexistente.');
      if (pago.estado !== 'activo') throw new BadRequestException('El pago está anulado.');
      const saldoPago = money(pago.importe - pago.aplicado);
      if (importe - saldoPago > EPS) {
        throw new BadRequestException(`El pago solo tiene ${saldoPago.toFixed(2)} sin aplicar.`);
      }

      /*
       * Cada pago se aplica SOLO a documentos de su mundo (decisión del
       * usuario): mercadería → comprobantes de compra, gastos → gastos. Si la
       * cajera eligió mal el tipo, el camino es corregir el destino del pago
       * (mientras no tenga nada aplicado), no cruzar la aplicación.
       */
      if (item.gastoId && pago.destino !== 'gastos') {
        throw new BadRequestException(
          'Ese pago se registró para MERCADERÍA: solo se aplica a facturas de compra. Si el tipo está mal, corregí el destino del pago.',
        );
      }
      if (item.comprobanteId && pago.destino !== 'mercaderia') {
        throw new BadRequestException(
          'Ese pago se registró para GASTOS: solo se aplica a gastos. Si el tipo está mal, corregí el destino del pago.',
        );
      }

      let docProveedorId: number | null;
      let saldoDoc: number;
      let etiqueta: string;

      if (item.gastoId) {
        const [g] = await tx.select().from(gastos).where(eq(gastos.id, item.gastoId)).limit(1);
        if (!g) throw new BadRequestException('Gasto inexistente.');
        if (g.estado === 'anulado') throw new BadRequestException('Ese gasto está anulado.');
        docProveedorId = g.proveedorId;
        saldoDoc = money(g.total - g.pagado);
        etiqueta = `gasto #${g.id}`;
      } else {
        const [c] = await tx.select().from(comprobantes).where(eq(comprobantes.id, item.comprobanteId!)).limit(1);
        if (!c) throw new BadRequestException('Comprobante inexistente.');
        if (c.estado !== 'confirmado') throw new BadRequestException('Ese comprobante no está confirmado.');
        if (c.tipo === 'nota_credito') throw new BadRequestException('Una nota de crédito no se paga: descuenta deuda.');
        docProveedorId = c.proveedorId;
        etiqueta = `${c.tipo === 'nota_debito' ? 'ND' : 'Factura'} ${c.letra} ${c.puntoVenta}-${c.numero ?? c.id}`;
        /*
         * ESTA es la guarda que de verdad impide pagar de más, y hasta ahora
         * ignoraba las notas: con `total - pagado` se le podían aplicar los
         * $200.000 enteros a una factura que una NC ya había bajado a $150.000.
         * Arreglar solo la bandeja no alcanzaba — la bandeja es lo que se ofrece,
         * esto es lo que se acepta.
         */
        const ajuste = await this.ajusteDe(tx, c.id);
        saldoDoc = money(c.total + ajuste - c.pagado);
        /*
         * Una ND que ajusta una factura no se paga por su cuenta: su importe ya
         * está sumado en el saldo de esa factura. Pagarla aparte sería pagar dos
         * veces el mismo ajuste.
         */
        if (c.tipo === 'nota_debito' && c.refComprobanteId) {
          throw new BadRequestException(
            `${etiqueta} ajusta a otra factura: se paga dentro del saldo de esa factura, no por separado.`,
          );
        }
      }

      // El pago de Coca-Cola no puede pagar la factura de otro proveedor.
      if ((pago.proveedorId ?? null) !== (docProveedorId ?? null)) {
        throw new BadRequestException(`Ese pago es de otro proveedor: no se puede aplicar a ${etiqueta}.`);
      }
      if (saldoDoc <= EPS) throw new BadRequestException(`${etiqueta} ya está saldado.`);
      if (importe - saldoDoc > EPS) {
        throw new BadRequestException(`A ${etiqueta} le faltan ${saldoDoc.toFixed(2)}: no se le puede aplicar más.`);
      }

      await tx.insert(proveedorImputaciones).values({
        pagoId,
        gastoId: item.gastoId ?? null,
        comprobanteId: item.comprobanteId ?? null,
        importe,
        usuarioId: usuarioId ?? null,
      });

      await this.recalcularPago(tx, pagoId);
      if (item.gastoId) await this.recalcularGasto(tx, item.gastoId);
      else await this.recalcularComprobante(tx, item.comprobanteId!);
    }
  }

  async imputar(pagoId: number, dto: ImputarDto) {
    if (!dto?.imputaciones?.length) throw new BadRequestException('No indicaste ninguna imputación.');
    const [p] = await this.db.select().from(proveedorPagos).where(eq(proveedorPagos.id, pagoId)).limit(1);
    if (!p) throw new NotFoundException('Pago inexistente.');
    // Un pago sin proveedor nació pegado a su documento y no tiene cuenta a la
    // cual pertenecer: no se puede reasignar a otra cosa después.
    if (!p.proveedorId) {
      throw new BadRequestException('Ese pago se registró sin proveedor: solo vale para el documento con el que nació.');
    }
    await this.db.transaction(async (tx) => this.aplicar(tx, pagoId, dto.imputaciones, dto.usuarioId));
    return this.get(pagoId);
  }

  /**
   * Desaplicar: el pago deja de estar imputado a ese documento y vuelve a la
   * bandeja de "sin aplicar". NO mueve plata, y por eso se permite aunque el
   * turno de caja esté cerrado.
   *
   * Excepción: un pago SIN proveedor no tiene existencia propia — nació pegado
   * a ese documento y sin él no puede aplicarse a nada. Desaplicarlo equivale
   * a anularlo, así que se anula entero (y ahí sí manda la regla de la caja).
   */
  async desimputar(imputacionId: number) {
    const pagoId = await this.db.transaction(async (tx) => {
      const [imp] = await tx.select().from(proveedorImputaciones)
        .where(eq(proveedorImputaciones.id, imputacionId)).limit(1);
      if (!imp) throw new NotFoundException('Imputación inexistente.');
      const [pago] = await tx.select().from(proveedorPagos).where(eq(proveedorPagos.id, imp.pagoId)).limit(1);

      if (pago && !pago.proveedorId) {
        if (pago.cajaMovimientoId) {
          const [sesion] = await tx.select().from(cajaSesiones)
            .where(eq(cajaSesiones.id, pago.cajaSesionId!)).limit(1);
          if (sesion && sesion.estado !== 'abierta') {
            throw new BadRequestException(
              'Ese pago salió de un turno de caja ya cerrado: quitarlo rompería el arqueo. Registrá el reintegro como ingreso de caja del turno actual.',
            );
          }
          await tx.delete(cajaMovimientos).where(eq(cajaMovimientos.id, pago.cajaMovimientoId));
        }
        await tx.update(proveedorPagos).set({ estado: 'anulado', cajaMovimientoId: null })
          .where(eq(proveedorPagos.id, pago.id));
      }

      await tx.delete(proveedorImputaciones).where(eq(proveedorImputaciones.id, imputacionId));
      await this.recalcularPago(tx, imp.pagoId);
      if (imp.gastoId) await this.recalcularGasto(tx, imp.gastoId);
      if (imp.comprobanteId) await this.recalcularComprobante(tx, imp.comprobanteId);
      return imp.pagoId;
    });
    return this.get(pagoId);
  }

  /**
   * Corregir el destino: la cajera eligió "mercadería" y era el plomero (o al
   * revés). Solo mientras el pago no tenga NADA aplicado — con imputaciones,
   * el destino ya se materializó en documentos y moverlo mentiría.
   */
  async cambiarDestino(id: number, destino: string) {
    if (destino !== 'mercaderia' && destino !== 'gastos') {
      throw new BadRequestException('Destino inválido: mercadería o gastos.');
    }
    const [p] = await this.db.select().from(proveedorPagos).where(eq(proveedorPagos.id, id)).limit(1);
    if (!p) throw new NotFoundException('Pago inexistente.');
    if (p.estado !== 'activo') throw new BadRequestException('El pago está anulado.');
    if (p.aplicado > EPS) {
      throw new BadRequestException('El pago ya tiene documentos aplicados: quitá las aplicaciones antes de moverlo de bandeja.');
    }
    await this.db.update(proveedorPagos).set({ destino }).where(eq(proveedorPagos.id, id));
    return this.get(id);
  }

  /**
   * Anular el pago. Dos candados:
   *   · Si tiene imputaciones, primero se desaplican — anular por arriba
   *     dejaría facturas figurando como pagadas sin pago detrás.
   *   · Si salió de un turno YA CERRADO no se puede: el arqueo se firmó con
   *     ese egreso adentro. La corrección va como ingreso de caja del turno
   *     actual, dejando rastro de las dos operaciones.
   */
  async anular(id: number, motivo?: string) {
    const [p] = await this.db.select().from(proveedorPagos).where(eq(proveedorPagos.id, id)).limit(1);
    if (!p) throw new NotFoundException('Pago inexistente.');
    if (p.estado === 'anulado') throw new BadRequestException('Ese pago ya está anulado.');
    if (p.aplicado > EPS) {
      throw new BadRequestException('El pago está aplicado a un documento: desaplicalo antes de anularlo.');
    }

    await this.db.transaction(async (tx) => {
      if (p.cajaMovimientoId) {
        const [sesion] = await tx.select().from(cajaSesiones)
          .where(eq(cajaSesiones.id, p.cajaSesionId!)).limit(1);
        if (sesion && sesion.estado !== 'abierta') {
          throw new BadRequestException(
            'Ese pago salió de un turno de caja ya cerrado: anularlo rompería el arqueo. Registrá el reintegro como ingreso de caja del turno actual.',
          );
        }
        await tx.delete(cajaMovimientos).where(eq(cajaMovimientos.id, p.cajaMovimientoId));
      }
      const nota = (motivo ?? '').trim();
      await tx.update(proveedorPagos).set({
        estado: 'anulado',
        cajaMovimientoId: null,
        observaciones: nota ? `${p.observaciones ? `${p.observaciones}\n` : ''}Anulado: ${nota}` : p.observaciones,
      }).where(eq(proveedorPagos.id, id));
    });
    return this.get(id);
  }

  /* ==================================================================== *
   * Consultas por documento (las usa Gastos y Compras)
   * ==================================================================== */

  /** Pagos imputados a un documento, con los datos del pago que los originó. */
  async pagosDe(doc: { gastoId?: number; comprobanteId?: number }) {
    const cond = doc.gastoId
      ? eq(proveedorImputaciones.gastoId, doc.gastoId)
      : eq(proveedorImputaciones.comprobanteId, doc.comprobanteId!);
    return this.db.select({
      imputacionId: proveedorImputaciones.id,
      importe: proveedorImputaciones.importe,
      fecha: proveedorPagos.fecha,
      pagoId: proveedorPagos.id,
      medio: proveedorPagos.medio,
      concepto: proveedorPagos.concepto,
      referencia: proveedorPagos.referencia,
      cajaSesionId: proveedorPagos.cajaSesionId,
      sucursalNombre: sql<string>`coalesce(${sucursales.nombre}, '')`,
      usuarioNombre: sql<string>`coalesce(${usuarios.nombre}, '')`,
      estado: proveedorPagos.estado,
    }).from(proveedorImputaciones)
      .innerJoin(proveedorPagos, eq(proveedorPagos.id, proveedorImputaciones.pagoId))
      .leftJoin(sucursales, eq(sucursales.id, proveedorPagos.sucursalId))
      .leftJoin(usuarios, eq(usuarios.id, proveedorPagos.usuarioId))
      .where(cond)
      .orderBy(proveedorImputaciones.id);
  }
}

/* ------------------------------- Controller ------------------------------- */

@Controller('pagos-proveedor')
export class PagosProveedorController {
  constructor(private readonly svc: PagosProveedorService) {}

  /* Rutas fijas antes de `:id` — Nest resuelve por orden de declaración. */
  @Get('sin-aplicar') sinAplicar(@Query('destino') destino?: string) {
    return this.svc.resumenSinAplicar(destino);
  }
  @Get('disponibles/:proveedorId') disponibles(
    @Param('proveedorId', ParseIntPipe) id: number,
    @Query('destino') destino?: string,
  ) {
    return this.svc.disponibles(id, destino);
  }
  @Get('pendientes/:proveedorId') pendientes(
    @Param('proveedorId', ParseIntPipe) id: number,
    @Query('destino') destino?: string,
  ) {
    return this.svc.documentosPendientes(id, destino);
  }
  @Get('cuenta/:proveedorId') cuenta(@Param('proveedorId', ParseIntPipe) id: number) {
    return this.svc.cuenta(id);
  }

  @Delete('imputaciones/:id') desimputar(@Param('id', ParseIntPipe) id: number) {
    return this.svc.desimputar(id);
  }

  @Get() list(@Query() q: any) { return this.svc.list(q ?? {}); }
  @Post() crear(@Body() dto: CrearPagoDto) { return this.svc.crear(dto); }

  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }
  @Post(':id/imputar') imputar(@Param('id', ParseIntPipe) id: number, @Body() dto: ImputarDto) {
    return this.svc.imputar(id, dto);
  }
  @Post(':id/anular') anular(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.anular(id, body?.motivo);
  }
  @Patch(':id/destino') destino(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.cambiarDestino(id, body?.destino);
  }
}

@Module({
  controllers: [PagosProveedorController],
  providers: [PagosProveedorService],
  exports: [PagosProveedorService],
})
export class PagosModule {}
