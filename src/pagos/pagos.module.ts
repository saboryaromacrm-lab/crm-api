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
  BadRequestException, Body, Controller, Delete, Get, ForbiddenException, Inject, Injectable, Module,
  NotFoundException, Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsBooleanString, IsIn, IsInt, IsNumber, IsOptional, IsString,
  Matches, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { esJefe } from '../auth/auth.guard';
import { DRIZZLE, Database } from '../db/drizzle';
import { ABREV_TIPO, etiquetaDoc } from '../common/documentos';
import {
  cajaMovimientos, cajaSesiones, comprobantes, gastos, pagoFormas, proveedorCompromisos,
  proveedorEcheqs, proveedorImputaciones, proveedorPagos, proveedores, sucursales, usuarios,
} from '../db/schema';

const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
/** Tolerancia de centavo: los importes son double y no hay que pelearse con eso. */
const EPS = 0.009;

// 0068: se suman 'deposito' y 'echeq' (los medios del módulo Proveedores).
const MEDIOS = ['efectivo', 'transferencia', 'tarjeta_debito', 'tarjeta_credito', 'cheque', 'qr', 'otro', 'deposito', 'echeq'] as const;

/* --------------------------------- DTOs --------------------------------- */

/**
 * Una fecha en formato 'AAAA-MM-DD' y nada más.
 *
 * No es cosmético: los filtros del listado hacían `new Date(q.desde).toISOString()`
 * sobre lo que llegara, y `new Date('abc').toISOString()` **tira una excepción**
 * (`RangeError: Invalid time value`) que salía como un 500. Validar el formato
 * acá convierte ese 500 en el 400 que corresponde.
 */
const SOLO_FECHA = /^\d{4}-\d{2}-\d{2}$/;

export class ImputacionDto {
  @IsOptional() @IsInt() gastoId?: number;
  @IsOptional() @IsInt() comprobanteId?: number;
  @IsNumber() @Min(0.01, { message: 'El importe a aplicar tiene que ser mayor a 0.' }) importe!: number;
}

/**
 * Una parte del pago MULTI-FORMA (0068): "mitad transferencia, mitad echeq".
 * `fecha` propia opcional — "transferí una parte hace 10 días y el resto hoy";
 * sin ella vale la fecha del pago. El mismo medio puede repetirse (dos
 * transferencias en fechas distintas son dos filas).
 */
export class FormaPagoDto {
  @IsIn(MEDIOS as unknown as string[]) medio!: string;
  @IsNumber() @Min(0.01, { message: 'Cada parte del pago tiene que ser mayor a 0.' }) importe!: number;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'La fecha de la parte va como AAAA-MM-DD.' }) fecha?: string;
}

/**
 * UN FLETE YA PAGADO QUE ESTE PAGO DESCUENTA (0069).
 * ----------------------------------------------------------------------------
 * La cajera le pagó $20.000 al fletero por cuenta del proveedor. La factura de
 * mercadería se cargó tal cual dice el papel: $100.000. Cuando se le paga la
 * cuenta corriente se transfieren $80.000, porque esos $20.000 ya se le
 * adelantaron — y para que la factura quede saldada, el flete se imputa contra
 * ella en el mismo acto.
 *
 * Es un pago que YA existe (por eso `pagoId`), no plata nueva: acá solo se dice
 * a qué documento se aplica y por cuánto.
 */
export class DescuentoFleteDto {
  @IsInt() pagoId!: number;
  @IsOptional() @IsInt() gastoId?: number;
  @IsOptional() @IsInt() comprobanteId?: number;
  @IsNumber() @Min(0.01, { message: 'El flete a descontar tiene que ser mayor a 0.' }) importe!: number;
}

export class CrearPagoDto {
  @IsOptional() @IsInt() proveedorId?: number;
  /**
   * A qué mundo va la plata: compras de mercadería o gastos. Lo elige quien
   * paga (la cajera sabe si le pagó al de las gaseosas o al plomero); si no
   * viene, se infiere de la imputación o de las marcas del proveedor.
   */
  @IsOptional() @IsIn(['mercaderia', 'gastos']) destino?: 'mercaderia' | 'gastos';
  @IsNumber() @Min(0.01, { message: 'El importe del pago tiene que ser mayor a 0.' }) importe!: number;
  @IsOptional() @IsIn(MEDIOS as unknown as string[]) medio?: string;
  @IsOptional() @Matches(SOLO_FECHA, { message: 'La fecha va como AAAA-MM-DD.' }) fecha?: string;
  @IsOptional() @IsString() @MaxLength(300) concepto?: string;
  @IsOptional() @IsString() @MaxLength(200) referencia?: string;
  /**
   * EL FLETE QUE EL PROVEEDOR DESCUENTA (0069). Lo tilda quien paga: "esto es
   * el flete de la entrega, se lo descuenta de su factura". Ver el comentario
   * de la columna en el schema y la exención en `aplicar`.
   */
  @IsOptional() @IsBoolean() esFlete?: boolean;
  @IsOptional() @IsInt() sucursalId?: number;
  /** Turno del que sale el efectivo: genera el egreso en esa caja. */
  @IsOptional() @IsInt() cajaSesionId?: number;
  @IsOptional() @IsInt() usuarioId?: number;
  @IsOptional() @IsString() @MaxLength(1000) observaciones?: string;
  /** Imputación en el mismo acto (pagar una factura que ya está cargada). */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ImputacionDto)
  imputaciones?: ImputacionDto[];
  /**
   * MULTI-FORMA (0068). Si viene, manda: la suma tiene que dar el importe del
   * pago, `medio` pasa a ser la PRIMERA forma (la "principal", para listados
   * simples) y el egreso de caja sale solo por la parte en EFECTIVO. Sin
   * `formas` vale el camino de siempre: un solo medio por el total.
   */
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => FormaPagoDto)
  formas?: FormaPagoDto[];
  /**
   * FLETES QUE ESTE PAGO DESCUENTA (0069). Se aplican DENTRO de la misma
   * transacción y ANTES que el pago propio: bajan el saldo del documento, así
   * el pago nuevo cae por el saldo exacto que queda.
   */
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => DescuentoFleteDto)
  fletes?: DescuentoFleteDto[];
}

export class ImputarDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ImputacionDto)
  imputaciones!: ImputacionDto[];
  @IsOptional() @IsInt() usuarioId?: number;
}

/**
 * Filtros del listado. Antes era `@Query() q: any`, y con eso el `whitelist` del
 * ValidationPipe global no filtraba nada: cualquier campo entraba al servicio.
 * Los números llegan como texto en la query string, de ahí los `IsNumberString`
 * en vez de `IsInt` — el servicio ya los pasa por `Number()`.
 */
export class ListarPagosDto {
  @IsOptional() @Matches(/^\d+$/) proveedorId?: string;
  @IsOptional() @Matches(/^\d+$/) sucursalId?: string;
  @IsOptional() @Matches(/^\d+$/) cajaSesionId?: string;
  @IsOptional() @IsIn(['mercaderia', 'gastos']) destino?: string;
  @IsOptional() @IsIn(['activo', 'anulado']) estado?: string;
  @IsOptional() @Matches(SOLO_FECHA, { message: 'El desde va como AAAA-MM-DD.' }) desde?: string;
  @IsOptional() @Matches(SOLO_FECHA, { message: 'El hasta va como AAAA-MM-DD.' }) hasta?: string;
  @IsOptional() @IsBooleanString() sinAplicar?: string;
  /** Solo los fletes: es lo que responde "¿cuánto pagué de fletes este mes?". */
  @IsOptional() @IsBooleanString() esFlete?: string;
  @IsOptional() @Matches(/^\d+$/) limit?: string;
}

export class AnularPagoDto {
  @IsOptional() @IsString() @MaxLength(300) motivo?: string;
}

/**
 * EL PAPEL DEL PAGO, completado después (0069).
 * ----------------------------------------------------------------------------
 * La cajera paga el flete con el camión en la puerta y no siempre tiene el
 * remito a mano; el que lo tiene es el administrativo, al día siguiente. Esto
 * deja completar el número de remito y el concepto SIN tocar un solo peso: no
 * cambia el importe, ni el medio, ni la fecha, ni a qué está aplicado. Es la
 * única edición que un pago admite, y por eso es un endpoint aparte.
 */
export class PapelPagoDto {
  @IsOptional() @IsString() @MaxLength(200) referencia?: string;
  @IsOptional() @IsString() @MaxLength(300) concepto?: string;
}

/** Solo fletes, sin pago nuevo (ver `descontarFletes`). */
export class DescontarFletesDto {
  @IsInt() proveedorId!: number;
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => DescuentoFleteDto)
  fletes!: DescuentoFleteDto[];
  @IsOptional() @IsInt() usuarioId?: number;
}

export class CambiarDestinoDto {
  @IsIn(['mercaderia', 'gastos'], { message: 'Destino inválido: mercadería o gastos.' })
  destino!: 'mercaderia' | 'gastos';
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
   * El puente con los COMPROMISOS (0068 · módulo Proveedores)
   * ==================================================================== */

  /**
   * La versión nativa del `sincronizarProximos()` de la app vieja de
   * proveedores — pero DENTRO de la transacción del pago: allá era
   * best-effort después de escribir (y tuvo que nacer un auto-reparador de
   * fantasmas históricos); acá, si el puente falla, falla el pago entero y
   * nunca queda medio mundo actualizado.
   *
   * Un compromiso es la promesa "esta factura se paga el día X". Dos caminos
   * la cumplen: el botón Pagar del compromiso, o un pago aplicado a la
   * factura desde cualquier otra pantalla. Sin este puente, el segundo camino
   * dejaría compromisos fantasma inflando el saldo proyectado y los avisos.
   *
   * Reglas, en las dos direcciones (se autocorrige):
   *  · Factura SALDADA (total + notas − pagado ≤ centavo) → se cierran todos
   *    sus compromisos pendientes firmados por el pago que la saldó, y sus
   *    echeqs pasan a cobrados en cascada.
   *  · Factura CON SALDO → se reabren los compromisos cuyo cerrador ya no
   *    está: pago anulado/desaplicado, o una NC (pagoId null) ahora anulada.
   *    El compromiso cerrado por un pago QUE SIGUE APLICADO no se toca — es
   *    una CUOTA pagada de verdad aunque el resto de la factura deba.
   */
  async sincronizarCompromisos(tx: any, comprobanteId: number, pagoCerradorId: number | null) {
    const comps = await tx.select().from(proveedorCompromisos)
      .where(eq(proveedorCompromisos.comprobanteId, comprobanteId));
    if (!comps.length) return;
    const [c] = await tx.select().from(comprobantes)
      .where(eq(comprobantes.id, comprobanteId)).limit(1);
    // Anulada no tiene saldo que sincronizar: sus pendientes los borra el
    // servicio de comprobantes al anular.
    if (!c || c.estado !== 'confirmado') return;
    const ajuste = await this.ajusteDe(tx, comprobanteId);
    const saldo = money(c.total + ajuste - c.pagado);

    if (saldo <= EPS) {
      for (const k of comps.filter((x: any) => !x.pagado)) {
        await tx.update(proveedorCompromisos)
          .set({ pagado: true, pagoId: pagoCerradorId })
          .where(eq(proveedorCompromisos.id, k.id));
        await tx.update(proveedorEcheqs)
          .set({ estado: 'cobrado', pagoId: pagoCerradorId })
          .where(and(
            eq(proveedorEcheqs.compromisoId, k.id),
            inArray(proveedorEcheqs.estado, ['emitido', 'entregado']),
          ));
      }
      return;
    }

    const cerrados = comps.filter((x: any) => x.pagado);
    if (!cerrados.length) return;
    const vivos = await tx.select({ pagoId: proveedorImputaciones.pagoId })
      .from(proveedorImputaciones)
      .innerJoin(proveedorPagos, eq(proveedorPagos.id, proveedorImputaciones.pagoId))
      .where(and(
        eq(proveedorImputaciones.comprobanteId, comprobanteId),
        eq(proveedorPagos.estado, 'activo'),
      ));
    const setVivos = new Set(vivos.map((v: any) => v.pagoId));
    for (const k of cerrados) {
      if (k.pagoId != null && setVivos.has(k.pagoId)) continue; // cuota pagada de verdad
      await tx.update(proveedorCompromisos)
        .set({ pagado: false, pagoId: null })
        .where(eq(proveedorCompromisos.id, k.id));
      await tx.update(proveedorEcheqs)
        .set({ estado: 'emitido', pagoId: null })
        .where(and(eq(proveedorEcheqs.compromisoId, k.id), eq(proveedorEcheqs.estado, 'cobrado')));
    }
  }

  /** El puente con transacción propia: lo llama Comprobantes cuando una NC/ND
   *  confirmada o anulada cambia el saldo de la factura que ajusta. */
  async sincronizarComprobante(comprobanteId: number) {
    await this.db.transaction(async (tx) => this.sincronizarCompromisos(tx, comprobanteId, null));
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
      esFlete: proveedorPagos.esFlete,
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
    /* Las dos puntas se arman en hora LOCAL. El `desde` usaba la fecha pelada,
     * que JavaScript interpreta como medianoche UTC: en UTC−3 eso arrancaba a
     * las 21:00 del día anterior y el filtro se comía tres horas de más. */
    if (q.desde) conds.push(sql`${proveedorPagos.fecha} >= ${new Date(`${String(q.desde).slice(0, 10)}T00:00:00`).toISOString()}`);
    if (q.hasta) conds.push(sql`${proveedorPagos.fecha} <= ${new Date(`${String(q.hasta).slice(0, 10)}T23:59:59.999`).toISOString()}`);
    if (q.esFlete === 'true' || q.esFlete === true) conds.push(eq(proveedorPagos.esFlete, true));
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
    const formasPorPago = await this.formasDe(filas.map((p) => p.id));
    return filas.map((p) => ({
      ...p,
      saldo: money(p.importe - p.aplicado),
      imputadoA: destinos.get(p.id) ?? [],
      formas: formasPorPago.get(p.id) ?? [],
    }));
  }

  /** `{ pagoId => [{medio, importe, fecha}] }` — el split multi-forma, en una consulta. */
  private async formasDe(ids: number[]) {
    const porId = new Map<number, Array<{ medio: string; importe: number; fecha: Date | null }>>();
    if (!ids.length) return porId;
    const filas = await this.db.select().from(pagoFormas)
      .where(inArray(pagoFormas.pagoId, ids))
      .orderBy(pagoFormas.id);
    for (const f of filas) {
      const arr = porId.get(f.pagoId) ?? [];
      arr.push({ medio: f.medio, importe: f.importe, fecha: f.fecha });
      porId.set(f.pagoId, arr);
    }
    return porId;
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
        : etiquetaDoc({ tipo: f.tipo!, letra: f.letra, puntoVenta: f.puntoVenta, numero: f.numero, id: f.comprobanteId! });
      const arr = porId.get(f.pagoId) ?? [];
      arr.push({ etiqueta, importe: f.importe });
      porId.set(f.pagoId, arr);
    }
    return porId;
  }

  async get(id: number) {
    const [p] = await this.baseQuery().where(eq(proveedorPagos.id, id)).limit(1);
    if (!p) throw new NotFoundException('Pago inexistente.');
    return {
      ...p,
      saldo: money(p.importe - p.aplicado),
      imputaciones: await this.imputacionesDe(id),
      formas: (await this.formasDe([id])).get(id) ?? [],
    };
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
      comprobanteLetra: comprobantes.letra,
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
      // Acá se veía `nota_debito 0001-123`: el valor crudo del enum, en pantalla.
      etiqueta: f.gastoId
        ? `Gasto #${f.gastoId}${f.gastoNumero ? ` · ${f.gastoNumero}` : ''}${f.gastoDescripcion ? ` · ${f.gastoDescripcion}` : ''}`
        : etiquetaDoc({
          tipo: f.comprobanteTipo ?? 'comprobante',
          letra: f.comprobanteLetra,
          puntoVenta: f.comprobantePv,
          numero: f.comprobanteNumero,
          id: f.comprobanteId!,
        }),
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
        // LISTA DE TIPOS · documentos pagables. La liquidación (la mitad sin
        // factura) se paga como cualquier otra deuda del proveedor.
        inArray(comprobantes.tipo, ['factura', 'liquidacion', 'nota_debito']),
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
          etiqueta: etiquetaDoc(c),
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
        // LISTA DE TIPOS · la cuenta corriente del proveedor, incluida la
        // liquidación: se le debe igual, y se le paga en el mismo acto.
        deuda: sql<number>`coalesce(sum(case when ${comprobantes.tipo} in ('factura','liquidacion','nota_debito') then ${comprobantes.total} when ${comprobantes.tipo} = 'nota_credito' then -${comprobantes.total} else 0 end), 0)`,
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

  /**
   * `sucursalSesion`: la sucursal con la que se LOGUEÓ quien pide. Es lo que
   * cierra la mitad que faltaba del candado del turno de caja (ver adentro).
   *
   * Es OBLIGATORIO a propósito, aunque haga más ruido en los tres llamadores
   * internos (el pago contado de una factura y los dos de Gastos): si fuera
   * opcional, cada uno de ellos sería un desvío que se saltea el candado sin
   * que nada lo avise — y son justamente caminos que aceptan un `cajaSesionId`.
   *
   * `cruzaSucursales` es `esJefe(sesion)`: habilita imputar el pago a un
   * documento de otra sucursal (ver la guarda en `aplicar`). Va como bandera y
   * no como sesión entera porque este servicio no debe conocer el modelo de
   * permisos: le alcanza con saber si esta operación puede cruzar o no.
   */
  async crear(
    dto: CrearPagoDto, sucursalSesion: number, cruzaSucursales = false, enAltaComprobante = false,
  ) {
    const importe = money(dto.importe);
    if (importe <= 0) throw new BadRequestException('El importe del pago tiene que ser mayor a 0.');

    let proveedorId: number | null = null;
    let prov: any = null;
    if (dto.proveedorId) {
      [prov] = await this.db.select().from(proveedores).where(eq(proveedores.id, Number(dto.proveedorId))).limit(1);
      if (!prov) throw new BadRequestException('Proveedor inválido.');
      proveedorId = prov.id;
    }
    /* El pago queda firmado con un usuario, y esa firma es lo que se mira en el
     * arqueo cuando falta plata: tiene que ser alguien que exista y esté activo.
     * No prueba QUIÉN pidió la operación —eso lo declara el cliente hasta que
     * haya sesión autenticada—, pero cierra la puerta a firmar con un id
     * cualquiera o con uno dado de baja. */
    if (dto.usuarioId) {
      const [u] = await this.db.select({ id: usuarios.id, activo: usuarios.activo })
        .from(usuarios).where(eq(usuarios.id, Number(dto.usuarioId))).limit(1);
      if (!u) throw new BadRequestException('El usuario que registra el pago no existe.');
      if (!u.activo) throw new BadRequestException('Ese usuario está dado de baja: no puede registrar pagos.');
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

    /*
     * EL FLETE (0069) ES SIEMPRE DE LA CUENTA DE MERCADERÍA.
     * ----------------------------------------------------------------------
     * Marcarlo dice "esta plata la puso el proveedor y él la descuenta de su
     * factura", y de ahí sale la exención del candado del modo "por facturas"
     * en `aplicar`. Dejar que se marque un pago de GASTOS abriría esa exención
     * a un mundo donde no aplica; y sin proveedor no hay cuenta de la cual
     * descontarlo, así que el flete no tendría a quién pertenecer.
     *
     * El flete que se le paga a un fletero propio —el que factura a nombre
     * nuestro y nadie nos reintegra— es un gasto de verdad y va por Gastos.
     */
    const esFlete = dto.esFlete === true;
    if (esFlete && destino !== 'mercaderia') {
      throw new BadRequestException(
        'El flete que el proveedor descuenta se registra contra su cuenta de MERCADERÍA. '
        + 'Si es un flete propio que nadie te reintegra, va como gasto.',
      );
    }
    if (esFlete && !proveedorId) {
      throw new BadRequestException(
        'Elegí el proveedor: el flete se descuenta de la factura de alguien.',
      );
    }
    // Que el mayor y el arqueo digan "Flete" aunque nadie haya escrito nada.
    const concepto = ((dto.concepto ?? '').trim() || (esFlete ? 'Flete de la entrega' : ''));

    /*
     * MULTI-FORMA (0068): si vienen partes, la suma TIENE que dar el importe
     * del pago — un split que no cuadra con la cabecera es el bug clásico de
     * los reportes por medio. El medio "principal" pasa a ser la primera
     * parte, para que los listados simples sigan teniendo qué mostrar sin
     * agregar sobre el split.
     */
    const formas = (dto.formas ?? []).map((f) => ({
      medio: f.medio as any,
      importe: money(f.importe),
      fecha: f.fecha ? new Date(`${f.fecha}T00:00:00`) : null,
    }));
    if (formas.length) {
      const suma = money(formas.reduce((a, f) => a + f.importe, 0));
      if (Math.abs(suma - importe) > EPS) {
        throw new BadRequestException(
          `Las partes del pago suman ${suma.toFixed(2)} pero el pago dice ${importe.toFixed(2)}: tienen que coincidir.`,
        );
      }
    }
    const medio = (formas[0]?.medio ?? dto.medio ?? 'efectivo') as any;
    /** Lo que sale del CAJÓN: la parte en efectivo del split — o todo, si el
     *  pago es simple y en efectivo. Es lo único que el arqueo tiene que ver. */
    const importeEfectivo = formas.length
      ? money(formas.filter((f) => f.medio === 'efectivo').reduce((a, f) => a + f.importe, 0))
      : (medio === 'efectivo' ? importe : 0);
    const id = await this.db.transaction(async (tx) => {
      let cajaMovimientoId: number | null = null;
      let cajaSesionId: number | null = null;
      let sucursalId: number | null = dto.sucursalId ?? null;

      /*
       * Efectivo desde un turno abierto: la plata sale del cajón, así que el
       * arqueo lo tiene que ver. El egreso se crea en la MISMA transacción —
       * un pago registrado sin su egreso descuadraría la caja de esa noche.
       * Con multi-forma, el egreso es SOLO la parte en efectivo: la
       * transferencia no salió de ningún cajón.
       */
      if (importeEfectivo > EPS && dto.cajaSesionId) {
        /*
         * EL TURNO SE LEE CON CANDADO, y no es por el saldo: es contra el CIERRE.
         *
         * Sin candado, un cierre de caja simultáneo sumaba el arqueo, este egreso
         * entraba después, y el turno quedaba cerrado con un egreso que
         * `sistemaEfectivo` no contaba. La diferencia del arqueo quedaba mal por
         * ese importe y **congelada en la fila**, así que no se detectaba más.
         * Con el candado, uno de los dos espera: o el cierre cuenta el egreso, o
         * el pago se rechaza porque el turno ya cerró. Las dos son correctas.
         */
        const [sesion] = await tx.select().from(cajaSesiones)
          .where(eq(cajaSesiones.id, Number(dto.cajaSesionId))).limit(1).for('update');
        if (!sesion) throw new BadRequestException('Turno de caja inexistente.');
        if (sesion.estado !== 'abierta') {
          throw new BadRequestException('Ese turno de caja está cerrado: no se le pueden cargar egresos.');
        }
        /*
         * LA SUCURSAL DEL PAGO ES LA DEL TURNO, no la que dice el pedido.
         *
         * Antes era `sucursalId ?? sesion.sucursalId`: si el pedido mandaba otra
         * sucursal, ganaba la del pedido y el egreso quedaba registrado en el
         * arqueo de un turno de una sucursal, con el pago diciendo que fue de
         * otra. Con eso se le podía cargar un egreso al cajón de cualquier
         * sucursal con turno abierto. Ahora manda el turno y la discrepancia se
         * rechaza en vez de resolverse sola.
         *
         * Y ACÁ ESTÁ LA MITAD QUE FALTABA, cerrada el 12/8 con la sesión ya
         * autenticada: **el turno tiene que ser el de la sucursal con la que se
         * logueó quien pide**. Sin esto, el candado de arriba no servía de nada:
         * bastaba con NO mandar `sucursalId` y pasar el `cajaSesionId` de un
         * turno abierto de otra sucursal para cargarle un egreso al cajón
         * ajeno — la cajera de Fontana cerraba el arqueo en falta y la
         * diferencia quedaba congelada en la fila.
         *
         * Los ids de turno se ven en cualquier listado de pagos, así que no
         * había que adivinar nada.
         */
        if (sesion.sucursalId !== sucursalSesion) {
          throw new ForbiddenException(
            'Ese turno de caja es de otra sucursal. El egreso en efectivo sale del cajón de la sucursal '
            + 'con la que entraste.',
          );
        }
        if (sucursalId != null && sucursalId !== sesion.sucursalId) {
          throw new BadRequestException(
            'Ese turno de caja es de otra sucursal: el egreso sale del cajón donde está abierto el turno.',
          );
        }
        sucursalId = sesion.sucursalId;
        const nombreProv = prov?.nombre ?? '';
        const [mov] = await tx.insert(cajaMovimientos).values({
          cajaSesionId: sesion.id,
          tipo: 'egreso',
          importe: importeEfectivo,
          motivo: `${esFlete ? 'Flete a cuenta del proveedor' : 'Pago a proveedor'}`
            + `${nombreProv ? ` · ${nombreProv}` : ''}${concepto ? ` · ${concepto}` : ''}`
            + (formas.length && importeEfectivo < importe - EPS ? ` · efectivo de un pago mixto de ${importe.toFixed(2)}` : ''),
          usuarioId: dto.usuarioId ?? null,
        }).returning();
        cajaMovimientoId = mov.id;
        cajaSesionId = sesion.id;
      }

      const [pago] = await tx.insert(proveedorPagos).values({
        // T00:00:00 = hora LOCAL: 'AAAA-MM-DD' pelado se parsea UTC y el día
        // se corre uno para atrás en UTC−3 (el pago de hoy figuraba ayer).
        fecha: dto.fecha ? new Date(`${dto.fecha.slice(0, 10)}T00:00:00`) : undefined,
        proveedorId,
        medio,
        destino,
        importe,
        aplicado: 0,
        esFlete,
        concepto,
        referencia: (dto.referencia ?? '').trim(),
        sucursalId,
        cajaSesionId,
        cajaMovimientoId,
        usuarioId: dto.usuarioId ?? null,
        estado: 'activo',
        observaciones: (dto.observaciones ?? '').trim(),
      }).returning();

      // El split del pago, en la misma transacción que su cabecera.
      if (formas.length) {
        await tx.insert(pagoFormas).values(formas.map((f) => ({
          pagoId: pago.id, medio: f.medio, importe: f.importe, fecha: f.fecha ?? undefined,
        })));
      }

      /*
       * LOS FLETES SE APLICAN PRIMERO, y el orden no es un detalle.
       * ----------------------------------------------------------------------
       * La factura dice $100.000 y se le transfieren $80.000 porque ya se le
       * adelantaron $20.000 de flete. Si el pago propio entrara primero, sería
       * un pago PARCIAL contra una factura que todavía debe $100.000 — y el
       * candado del modo "por facturas" lo rechazaría con razón. Aplicando el
       * flete antes, el saldo queda en $80.000 y el pago cae por el saldo
       * exacto: pasa el candado sin ninguna excepción.
       *
       * Todo dentro de la MISMA transacción: si el pago falla, el flete vuelve
       * a estar disponible. Quedarse a mitad de camino sería lo peor —el flete
       * imputado a una factura que nadie terminó de pagar.
       */
      await this.aplicarFletes(tx, dto.fletes ?? [], proveedorId, dto.usuarioId, cruzaSucursales);

      if (dto.imputaciones?.length) {
        await this.aplicar(tx, pago.id, dto.imputaciones, dto.usuarioId, cruzaSucursales, enAltaComprobante);
      }
      return pago.id;
    });
    return this.get(id);
  }

  /**
   * DESCONTAR FLETES: imputar pagos de flete YA HECHOS contra los documentos
   * que se están pagando. No mueve plata nueva — esa salió del cajón el día que
   * la cajera le pagó al fletero.
   *
   * Se valida que cada uno sea de verdad un flete y del mismo proveedor: sin
   * eso, este camino sería una puerta lateral para imputar cualquier pago ajeno
   * salteándose el candado del modo de cuenta.
   */
  private async aplicarFletes(
    tx: any, fletes: DescuentoFleteDto[], proveedorId: number | null,
    usuarioId?: number, cruzaSucursales = false,
  ) {
    for (const f of fletes) {
      const [fp] = await tx.select().from(proveedorPagos)
        .where(eq(proveedorPagos.id, Number(f.pagoId))).limit(1);
      if (!fp) throw new BadRequestException('El flete que se quiere descontar no existe.');
      if (!fp.esFlete) {
        throw new BadRequestException(
          'Ese pago no está marcado como flete: los pagos comunes se aplican desde el documento, no descontándolos de otro pago.',
        );
      }
      if (!proveedorId || fp.proveedorId !== proveedorId) {
        throw new BadRequestException('Ese flete es de otro proveedor: no se puede descontar acá.');
      }
      await this.aplicar(
        tx, fp.id,
        [{ gastoId: f.gastoId, comprobanteId: f.comprobanteId, importe: money(f.importe) }],
        usuarioId, cruzaSucursales,
      );
    }
  }

  /**
   * SOLO FLETES, sin pago nuevo: pasa cuando lo adelantado alcanza para cubrir
   * el documento entero (la factura es de $20.000 y el flete fue de $20.000).
   * No hay plata que transferir, pero la factura tiene que quedar saldada — y
   * todo en una transacción, como cuando hay pago.
   */
  async descontarFletes(
    proveedorId: number, fletes: DescuentoFleteDto[], usuarioId?: number, cruzaSucursales = false,
  ) {
    if (!fletes?.length) throw new BadRequestException('No indicaste ningún flete a descontar.');
    await this.db.transaction(
      async (tx) => this.aplicarFletes(tx, fletes, proveedorId, usuarioId, cruzaSucursales),
    );
    return { ok: true, descontados: fletes.length };
  }

  /**
   * Aplica un pago a uno o varios documentos. Cada imputación se valida contra
   * el saldo VIVO del pago y del documento (recalculados después de cada una),
   * así aplicar tres cosas de una no puede pasarse del total por redondeo.
   *
   * DOS PEDIDOS SIMULTÁNEOS: hacen falta los `FOR UPDATE` de abajo.
   * ------------------------------------------------------------------------
   * Antes esta guarda se podía pasar dos veces y el comentario afirmaba lo
   * contrario, que es peor que no decir nada: nadie lo revisa. Con el nivel de
   * aislamiento de Postgres por defecto (READ COMMITTED) un `select` pelado
   * **no espera** a la transacción de al lado — lee la última versión
   * confirmada. Dos `imputar` simultáneos del mismo pago leían los dos
   * `aplicado = 0`, los dos pasaban la validación, y las dos imputaciones
   * entraban: la tabla de imputaciones y los totales quedaban en desacuerdo,
   * que es exactamente el invariante que este módulo declara como su corazón.
   * Un doble click en una conexión lenta alcanza.
   *
   * `.for('update')` bloquea la fila hasta el fin de la transacción, así el
   * segundo pedido espera y recién entonces lee el saldo ya actualizado.
   *
   * ORDEN DE BLOQUEO: primero el pago, después el documento. Siempre igual, en
   * las tres funciones que bloquean (`aplicar`, `desimputar`, `anular`): dos
   * caminos que tomen los mismos dos candados en orden distinto se abrazan.
   */
  private async aplicar(
    tx: any, pagoId: number, items: ImputacionDto[], usuarioId?: number, cruzaSucursales = false,
    enAltaComprobante = false,
  ) {
    for (const item of items) {
      const importe = money(item.importe);
      if (importe <= 0) throw new BadRequestException('El importe a aplicar tiene que ser mayor a 0.');
      if (!item.gastoId && !item.comprobanteId) throw new BadRequestException('Indicá a qué documento se aplica.');
      if (item.gastoId && item.comprobanteId) throw new BadRequestException('Una imputación va a un solo documento.');

      // Candado 1 de 2 (ver el comentario del método). Sin esto el saldo que se
      // valida abajo puede ser el de hace un instante.
      const [pago] = await tx.select().from(proveedorPagos)
        .where(eq(proveedorPagos.id, pagoId)).limit(1).for('update');
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
      let docSucursalId: number | null;
      let saldoDoc: number;
      let etiqueta: string;

      /* Candado 2 de 2: el documento. El candado del pago solo evita que se
       * pase el MISMO pago dos veces; sin este, dos pagos distintos aplicados a
       * la vez a la misma factura leen los dos el mismo `pagado` y la
       * sobre-pagan entre ambos. */
      if (item.gastoId) {
        const [g] = await tx.select().from(gastos)
          .where(eq(gastos.id, item.gastoId)).limit(1).for('update');
        if (!g) throw new BadRequestException('Gasto inexistente.');
        if (g.estado === 'anulado') throw new BadRequestException('Ese gasto está anulado.');
        docProveedorId = g.proveedorId;
        docSucursalId = g.sucursalId;
        saldoDoc = money(g.total - g.pagado);
        etiqueta = `gasto #${g.id}`;
      } else {
        const [c] = await tx.select().from(comprobantes)
          .where(eq(comprobantes.id, item.comprobanteId!)).limit(1).for('update');
        if (!c) throw new BadRequestException('Comprobante inexistente.');
        if (c.estado !== 'confirmado') throw new BadRequestException('Ese comprobante no está confirmado.');
        if (c.tipo === 'nota_credito') throw new BadRequestException('Una nota de crédito no se paga: descuenta deuda.');
        /*
         * Solo la factura y la ND generan deuda. Antes solo se rechazaba la NC,
         * así que una orden de compra o un remito se podían imputar por API
         * directa y salían etiquetados como "Factura" — la pantalla no los
         * ofrece (`documentosPendientes` filtra por tipo), pero lo que se acepta
         * no puede depender de lo que se ofrece.
         */
        // LISTA DE TIPOS · lo que se ACEPTA imputar (lo que se ofrece está en
        // `documentosPendientes`; las dos tienen que decir lo mismo).
        if (c.tipo !== 'factura' && c.tipo !== 'liquidacion' && c.tipo !== 'nota_debito') {
          throw new BadRequestException(
            `Un documento de tipo ${ABREV_TIPO[c.tipo] ?? c.tipo} no genera deuda: solo se pagan facturas, liquidaciones y notas de débito.`,
          );
        }
        docProveedorId = c.proveedorId;
        docSucursalId = c.sucursalId;
        etiqueta = etiquetaDoc(c);
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

        /*
         * EL MODO DE CUENTA DEL PROVEEDOR (0068). En modo 'facturas' —el
         * default, y la regla de la app vieja de proveedores— la factura se
         * paga COMPLETA: aplicar montos sueltos deja saldos de centavos que
         * nadie reconcilia. La excepción son las CUOTAS pactadas: un importe
         * que coincide con un compromiso pendiente de esta factura es
         * exactamente el pago acordado. En modo 'libre' se aplica lo que sea
         * (proveedores a los que se les va pagando a cuenta).
         */
        /*
         * LAS DOS EXCEPCIONES AL CANDADO (0069).
         *
         * 1) EL FLETE. La cajera le pagó $20.000 al fletero del cajón y el
         *    proveedor lo reconoce descontándolo de su factura de $100.000.
         *    Ese pago NO puede ser el saldo completo ni una cuota pactada: es
         *    un adelanto por cuenta del proveedor, y su naturaleza está
         *    declarada en el pago. Rechazarlo no evitaba nada —la plata ya
         *    salió del cajón igual— y forzaba lo peor de los dos mundos: el
         *    flete quedaba sin aplicar y la factura figuraba debiendo $100.000
         *    cuando en los hechos se le iban a pagar $80.000.
         *
         * 2) EL ALTA DE LA FACTURA. Ahí el total ya se valida por otra vía y
         *    más fuerte: contado + pagos tomados + cuotas tienen que sumar el
         *    total EXACTO del comprobante (ver `comprobantes.module`), así que
         *    no puede quedar el saldo suelto que este candado previene. Pedir
         *    además que cada pago tomado sea el saldo entero convertía en
         *    imposible lo más común del mostrador: "le adelanté algo al
         *    repartidor y el resto queda en cuenta corriente".
         *
         * Fuera de estos dos casos el modo 'facturas' sigue mandando: pagar
         * sueltos contra una factura abierta se sigue rechazando.
         */
        const exentoDelModo = pago.esFlete || enAltaComprobante;
        if (!exentoDelModo && pago.proveedorId && Math.abs(importe - saldoDoc) > EPS) {
          const [provModo] = await tx.select({ modoCuenta: proveedores.modoCuenta })
            .from(proveedores).where(eq(proveedores.id, pago.proveedorId)).limit(1);
          if (provModo?.modoCuenta === 'facturas') {
            const cuotas = await tx.select({ importe: proveedorCompromisos.importe })
              .from(proveedorCompromisos)
              .where(and(
                eq(proveedorCompromisos.comprobanteId, c.id),
                eq(proveedorCompromisos.pagado, false),
              ));
            const esCuota = cuotas.some((q: any) => Math.abs(money(q.importe) - importe) <= EPS);
            if (!esCuota) {
              throw new BadRequestException(
                `${etiqueta} se paga por su saldo completo (${saldoDoc.toFixed(2)}) o por una cuota pactada: `
                + 'el proveedor está en modo "por facturas". Para pagos parciales a cuenta, pasalo a modo "libre" en su ficha.',
              );
            }
          }
        }
      }

      // El pago de Coca-Cola no puede pagar la factura de otro proveedor.
      if ((pago.proveedorId ?? null) !== (docProveedorId ?? null)) {
        throw new BadRequestException(`Ese pago es de otro proveedor: no se puede aplicar a ${etiqueta}.`);
      }

      /*
       * NI LA DE OTRA SUCURSAL. Esta regla existía solo en el frontend, que
       * filtra la lista de pagos por la sucursal del documento — y lo que se
       * ofrece no puede ser lo único que decide qué se acepta.
       *
       * Sirve para tapar un faltante: se saca plata del cajón de Fontana, se
       * busca un gasto legítimo de Centro por el mismo importe y se lo imputa
       * ahí. El pago desaparece de la bandeja de "sin aplicar" —que es JUSTO el
       * contador que mira el dueño— y el egreso queda explicado por un
       * comprobante de otro mostrador. Nadie lo vuelve a mirar.
       *
       * `null` de cualquiera de los dos lados no restringe: es "sin sucursal"
       * (el gasto de toda la empresa, o un pago por transferencia que no salió
       * de ninguna caja). Y el jefe cruza, porque corregir lo que se cargó en
       * el mostrador equivocado es exactamente su trabajo.
       */
      if (
        !cruzaSucursales
        && pago.sucursalId != null && docSucursalId != null
        && pago.sucursalId !== docSucursalId
      ) {
        throw new BadRequestException(
          `Ese pago se registró en otra sucursal: no se puede aplicar a ${etiqueta}, que es de otra. `
          + 'Si está mal cargado, lo corrige un administrador.',
        );
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
      else {
        await this.recalcularComprobante(tx, item.comprobanteId!);
        // El puente (0068): si esta aplicación saldó la factura, sus
        // compromisos se cierran acá mismo, firmados por este pago.
        await this.sincronizarCompromisos(tx, item.comprobanteId!, pagoId);
      }
    }
  }

  /**
   * `enAltaComprobante` lo pone SOLO `comprobantes.module` cuando la factura se
   * está creando: ahí el total ya se valida completo por otra vía y el candado
   * del modo "por facturas" no corresponde. No viaja por el DTO a propósito —
   * un cliente no puede declararse a sí mismo exento.
   */
  async imputar(pagoId: number, dto: ImputarDto, cruzaSucursales = false, enAltaComprobante = false) {
    if (!dto?.imputaciones?.length) throw new BadRequestException('No indicaste ninguna imputación.');
    const [p] = await this.db.select().from(proveedorPagos).where(eq(proveedorPagos.id, pagoId)).limit(1);
    if (!p) throw new NotFoundException('Pago inexistente.');
    // Un pago sin proveedor nació pegado a su documento y no tiene cuenta a la
    // cual pertenecer: no se puede reasignar a otra cosa después.
    if (!p.proveedorId) {
      throw new BadRequestException('Ese pago se registró sin proveedor: solo vale para el documento con el que nació.');
    }
    await this.db.transaction(
      async (tx) => this.aplicar(
        tx, pagoId, dto.imputaciones, dto.usuarioId, cruzaSucursales, enAltaComprobante,
      ),
    );
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
      // Mismo candado que en `aplicar`: dos desaplicaciones simultáneas del
      // mismo pago recalculaban las dos sobre el estado viejo y una de las dos
      // sobrevivía en `aplicado`.
      const [pago] = await tx.select().from(proveedorPagos)
        .where(eq(proveedorPagos.id, imp.pagoId)).limit(1).for('update');

      if (pago && !pago.proveedorId) {
        if (pago.cajaMovimientoId) {
          // Con candado, igual que al crear: el cierre no puede colarse entre el
          // chequeo de "sigue abierta" y el borrado del movimiento.
          const [sesion] = await tx.select().from(cajaSesiones)
            .where(eq(cajaSesiones.id, pago.cajaSesionId!)).limit(1).for('update');
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

      /*
       * CANDADO 2 DE 2: el documento. Faltaba, y el comentario de `aplicar`
       * afirmaba que las tres funciones bloqueaban las dos filas — peor que no
       * decir nada, porque nadie lo revisa.
       *
       * Sin este candado, un `desimputar` y un `imputar` simultáneos sobre la
       * MISMA factura recalculan los dos su `pagado` desde el estado viejo y el
       * último pisa al otro: la factura queda con menos pagado del que recibió,
       * vuelve a la bandeja de pendientes y se paga dos veces.
       *
       * Mismo orden que en `aplicar` (pago → documento) para no abrazarse.
       */
      if (imp.gastoId) {
        await tx.select({ id: gastos.id }).from(gastos)
          .where(eq(gastos.id, imp.gastoId)).limit(1).for('update');
      }
      if (imp.comprobanteId) {
        await tx.select({ id: comprobantes.id }).from(comprobantes)
          .where(eq(comprobantes.id, imp.comprobanteId)).limit(1).for('update');
      }

      await tx.delete(proveedorImputaciones).where(eq(proveedorImputaciones.id, imputacionId));
      await this.recalcularPago(tx, imp.pagoId);
      if (imp.gastoId) await this.recalcularGasto(tx, imp.gastoId);
      if (imp.comprobanteId) {
        await this.recalcularComprobante(tx, imp.comprobanteId);
        // El puente (0068): la factura recupera saldo → sus compromisos
        // cerrados por ESTE pago se reabren (y el echeq vuelve a emitido).
        await this.sincronizarCompromisos(tx, imp.comprobanteId, null);
      }
      return imp.pagoId;
    });
    return this.get(pagoId);
  }

  /**
   * Corregir el destino: la cajera eligió "mercadería" y era el plomero (o al
   * revés). Solo mientras el pago no tenga NADA aplicado — con imputaciones,
   * el destino ya se materializó en documentos y moverlo mentiría.
   */
  async cambiarDestino(id: number, destino: 'mercaderia' | 'gastos') {
    // El destino ya viene validado por el DTO del controlador.
    await this.db.transaction(async (tx) => {
      /* Con candado y adentro de la transacción, como las otras tres: leído
       * afuera, una imputación que entraba en el medio dejaba el pago movido de
       * bandeja DESPUÉS de haberse materializado en un documento del otro mundo. */
      const [p] = await tx.select().from(proveedorPagos)
        .where(eq(proveedorPagos.id, id)).limit(1).for('update');
      if (!p) throw new NotFoundException('Pago inexistente.');
      if (p.estado !== 'activo') throw new BadRequestException('El pago está anulado.');
      if (p.aplicado > EPS) {
        throw new BadRequestException('El pago ya tiene documentos aplicados: quitá las aplicaciones antes de moverlo de bandeja.');
      }
      await tx.update(proveedorPagos).set({ destino }).where(eq(proveedorPagos.id, id));
    });
    return this.get(id);
  }

  /**
   * Completar el PAPEL del pago: el número de remito y el concepto. No toca
   * plata —ni importe, ni medio, ni fecha, ni imputaciones—, así que se permite
   * con el pago ya aplicado y con el turno de caja cerrado. El caso: la cajera
   * pagó el flete con el camión en la puerta y el remito lo tiene el
   * administrativo al otro día.
   *
   * Un pago ANULADO no se toca: su historia quedó cerrada.
   */
  async actualizarPapel(id: number, dto: { referencia?: string; concepto?: string }) {
    const [p] = await this.db.select().from(proveedorPagos).where(eq(proveedorPagos.id, id)).limit(1);
    if (!p) throw new NotFoundException('Pago inexistente.');
    if (p.estado !== 'activo') throw new BadRequestException('El pago está anulado: no se le cambian los datos.');
    const set: any = {};
    // "Ausente conserva": mandar solo el campo que se está corrigiendo no puede
    // borrar el otro (el contrato que ya rige en `proveedores.update`).
    if (dto.referencia !== undefined) set.referencia = String(dto.referencia).trim();
    if (dto.concepto !== undefined) set.concepto = String(dto.concepto).trim();
    if (!Object.keys(set).length) return this.get(id);
    await this.db.update(proveedorPagos).set(set).where(eq(proveedorPagos.id, id));
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
    await this.db.transaction(async (tx) => {
      /* El chequeo de `aplicado` va DENTRO de la transacción y con candado.
       * Leído afuera, una imputación que entraba en el medio dejaba el pago
       * anulado CON imputaciones vivas — exactamente lo que el primer candado
       * dice evitar, y encima el `pagado` del comprobante seguía contando un
       * pago anulado porque el recálculo no se vuelve a correr acá. */
      const [p] = await tx.select().from(proveedorPagos)
        .where(eq(proveedorPagos.id, id)).limit(1).for('update');
      if (!p) throw new NotFoundException('Pago inexistente.');
      if (p.estado === 'anulado') throw new BadRequestException('Ese pago ya está anulado.');
      if (p.aplicado > EPS) {
        throw new BadRequestException('El pago está aplicado a un documento: desaplicalo antes de anularlo.');
      }

      if (p.cajaMovimientoId) {
        // Con candado: ver `crear`. El cierre y este borrado se pelean la misma fila.
        const [sesion] = await tx.select().from(cajaSesiones)
          .where(eq(cajaSesiones.id, p.cajaSesionId!)).limit(1).for('update');
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

      /*
       * El puente (0068), rama de los compromisos MANUALES: los de factura ya
       * se reabrieron al desaplicar (anular exige aplicado = 0), pero el
       * compromiso manual se cerró con este pago SIN imputación — se reabre
       * acá, y su echeq cobrado vuelve a emitido. El echeq cobrado "suelto"
       * (sin compromiso) también revierte por su pagoId.
       */
      await tx.update(proveedorCompromisos)
        .set({ pagado: false, pagoId: null })
        .where(eq(proveedorCompromisos.pagoId, id));
      await tx.update(proveedorEcheqs)
        .set({ estado: 'emitido', pagoId: null })
        .where(and(eq(proveedorEcheqs.pagoId, id), eq(proveedorEcheqs.estado, 'cobrado')));
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
      // Para que el detalle de la factura pueda decir "de esto, $20.000 fue el
      // flete que se le adelantó al fletero", y no solo "un pago".
      esFlete: proveedorPagos.esFlete,
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

/**
 * PLATA QUE SALE: TRES PERMISOS, PORQUE SON TRES CAMINOS LEGÍTIMOS.
 * ============================================================================
 * Este controller no tenía NINGÚN permiso, así que cualquier sesión —incluida
 * la del rol Cafetería, que ve una sola pantalla— podía crear un egreso de
 * efectivo, anular un pago ajeno o leer la cuenta corriente de un proveedor.
 *
 * Las tres claves son un OR, y ninguna está de más:
 *   * `compras.pagos` — administración pagando facturas.
 *   * `gastos.pagos_proveedor` — el mismo padrón de proveedores del lado de
 *     Gastos (el modelo es UN padrón con flags mercadería/gastos).
 *   * `ventas.caja` — **la cajera le paga al proveedor cuando llega el
 *     camión**. Es el caso más común de todos y sale de la pantalla de Caja
 *     (CajaModals, egreso con destino "proveedor"); dejarlo afuera habría roto
 *     el circuito real del mostrador.
 *
 * Lo que el permiso NO puede resolver es de qué cajón sale la plata: eso lo
 * cierra el candado de `crear`, que exige que el turno sea de la sucursal de la
 * sesión.
 */
@Controller('pagos-proveedor')
@Permiso('compras.pagos', 'gastos.pagos_proveedor', 'ventas.caja')
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

  @Get() list(@Query() q: ListarPagosDto) { return this.svc.list(q ?? {}); }
  // La sucursal sale de la SESIÓN, no del body: es con lo que se compara el
  // turno de caja para que el egreso no pueda salir del cajón de otra sucursal.
  @Post() crear(@Body() dto: CrearPagoDto, @Auth() auth: Sesion) {
    return this.svc.crear(dto, auth.sucursalId, esJefe(auth));
  }

  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }
  // El jefe puede imputar cruzando sucursales; el mostrador, no (ver `aplicar`).
  @Post(':id/imputar') imputar(
    @Param('id', ParseIntPipe) id: number, @Body() dto: ImputarDto, @Auth() auth: Sesion,
  ) {
    return this.svc.imputar(id, dto, esJefe(auth));
  }
  @Post('descontar-fletes') descontarFletes(@Body() dto: DescontarFletesDto, @Auth() auth: Sesion) {
    return this.svc.descontarFletes(dto.proveedorId, dto.fletes, dto.usuarioId, esJefe(auth));
  }
  @Post(':id/anular') anular(@Param('id', ParseIntPipe) id: number, @Body() dto: AnularPagoDto) {
    return this.svc.anular(id, dto?.motivo);
  }
  @Patch(':id/destino') destino(@Param('id', ParseIntPipe) id: number, @Body() dto: CambiarDestinoDto) {
    return this.svc.cambiarDestino(id, dto.destino);
  }
  @Patch(':id/papel') papel(@Param('id', ParseIntPipe) id: number, @Body() dto: PapelPagoDto) {
    return this.svc.actualizarPapel(id, dto);
  }
}

@Module({
  controllers: [PagosProveedorController],
  providers: [PagosProveedorService],
  exports: [PagosProveedorService],
})
export class PagosModule {}
