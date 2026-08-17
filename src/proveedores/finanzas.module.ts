/**
 * FINANZAS DEL PROVEEDOR (0068) — compromisos, echeqs y estado de cuenta
 * ============================================================================
 * Las tres vitrinas del módulo Proveedores que giran alrededor de la deuda.
 * La deuda MISMA no vive acá: nace en `comprobantes` y `gastos` y se cancela
 * en `proveedor_pagos` — este módulo la mira, la promete y la explica.
 *
 *  · COMPROMISOS ("Cuentas corrientes"): el vencimiento como entidad. Se
 *    listan los que NO son echeq — el echeq tiene su propia vitrina, y
 *    mostrarlo en las dos duplicaría gestión y contadores (regla heredada de
 *    la app externa, donde era un LIKE sobre el nombre de la forma; acá es
 *    el dato `esEcheq`).
 *  · ECHEQS: la cartera propia. "Cobrado" no es una etiqueta: ejecuta el
 *    pago real (imputado a su factura si la tiene) vía PagosProveedorService,
 *    que corre el puente y cierra el compromiso en la misma transacción.
 *  · ESTADO DE CUENTA: el mayor DEBE/HABER por proveedor (facturas,
 *    liquidaciones y ND al debe; NC y pagos al haber; gastos al debe;
 *    ajustes con signo), el saldo con la MISMA fórmula que `cuenta()` de
 *    pagos + ajustes, la antigüedad FIFO, la conciliación y el saldo
 *    proyectado (saldo − compromisos pendientes).
 *
 * El botón "Pagar" de un compromiso exige el MEDIO REAL (la promesa decía
 * "cta cte", la plata sale por transferencia o efectivo de caja) y crea un
 * pago común y corriente del sistema — con su candado de caja, su arqueo y
 * su bandeja. Nada de plata se mueve por un camino nuevo.
 */
import {
  BadRequestException, Body, Controller, Delete, Get, Inject, Injectable, Module,
  NotFoundException, Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches,
  MaxLength, Min, ValidateNested,
} from 'class-validator';
import { and, desc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { esJefe } from '../auth/auth.guard';
import { DRIZZLE, Database } from '../db/drizzle';
import { etiquetaDoc } from '../common/documentos';
import {
  comprobantes, gastos, pagoFormas, proveedorAjustes, proveedorCompromisos,
  proveedorCuentas, proveedorEcheqs, proveedorPagos, proveedores,
} from '../db/schema';
import { FormaPagoDto, PagosModule, PagosProveedorService } from '../pagos/pagos.module';

const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const EPS = 0.009;
const SOLO_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Medianoche de HOY en hora del servidor — la misma convención T00:00:00 de
 *  todo el sistema (fechaLocal): las dos puntas de la comparación viven en el
 *  mismo huso y los "días restantes" no se corren de noche. */
const hoy0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const fecha0 = (s: string) => new Date(`${String(s).slice(0, 10)}T00:00:00`);
const aIso = (d: Date) => {
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const diasHasta = (venc: Date) => Math.round((venc.getTime() - hoy0().getTime()) / 86400000);

/* --------------------------------- DTOs --------------------------------- */

class CompromisoManualDto {
  @IsInt() proveedorId!: number;
  @IsNumber() @Min(0.01) importe!: number;
  @Matches(SOLO_FECHA, { message: 'El vencimiento va como AAAA-MM-DD.' }) fechaVenc!: string;
  @IsOptional() @Matches(SOLO_FECHA, { message: 'La emisión va como AAAA-MM-DD.' }) fechaEmision?: string;
  @IsOptional() @IsString() @MaxLength(300) obs?: string;
}

class EditarCompromisoDto {
  @IsOptional() @IsNumber() @Min(0.01) importe?: number;
  @IsOptional() @Matches(SOLO_FECHA) fechaVenc?: string;
  @IsOptional() @Matches(SOLO_FECHA) fechaEmision?: string;
  @IsOptional() @IsString() @MaxLength(300) obs?: string;
}

/** El pago REAL de un compromiso: la promesa decía "cta cte"; acá se dice con
 *  qué salió la plata de verdad (un medio simple, o el split multi-forma). */
class PagarCompromisoDto {
  @IsOptional() @IsIn(['efectivo', 'transferencia', 'deposito', 'cheque', 'echeq', 'otro']) medio?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => FormaPagoDto)
  formas?: FormaPagoDto[];
  @IsOptional() @Matches(SOLO_FECHA) fecha?: string;
  @IsOptional() @IsInt() cajaSesionId?: number;
  @IsOptional() @IsString() @MaxLength(200) referencia?: string;
  @IsOptional() @IsString() @MaxLength(300) obs?: string;
}

class EcheqDto {
  @IsOptional() @IsString() @MaxLength(40) numero?: string;
  @IsOptional() @IsString() @MaxLength(100) banco?: string;
  @IsOptional() @IsNumber() @Min(0.01) importe?: number;
  @IsOptional() @Matches(SOLO_FECHA) fechaEmision?: string;
  @IsOptional() @Matches(SOLO_FECHA) fechaVenc?: string;
  @IsOptional() @IsInt() proveedorId?: number;
  @IsOptional() @IsString() @MaxLength(2000) obs?: string;
}

class EstadoEcheqDto {
  @IsIn(['emitido', 'entregado', 'cobrado', 'anulado']) estado!: string;
}

class AjusteDto {
  @IsInt() proveedorId!: number;
  /** Siempre positivo; `tipo` pone el signo (debe suma deuda, haber la resta). */
  @IsNumber() @Min(0.01) monto!: number;
  @IsIn(['debe', 'haber']) tipo!: 'debe' | 'haber';
  @IsString() @MaxLength(500) motivo!: string;
  @IsOptional() @Matches(SOLO_FECHA) fecha?: string;
}

/* ------------------------------- Servicio ------------------------------- */

@Injectable()
export class FinanzasProveedorService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly pagos: PagosProveedorService,
  ) {}

  /* ==================================================================== *
   * Compromisos
   * ==================================================================== */

  private selectCompromiso() {
    return {
      id: proveedorCompromisos.id,
      proveedorId: proveedorCompromisos.proveedorId,
      proveedorNombre: sql<string>`coalesce(${proveedores.nombre}, '')`,
      comprobanteId: proveedorCompromisos.comprobanteId,
      compTipo: comprobantes.tipo,
      compLetra: comprobantes.letra,
      compPv: comprobantes.puntoVenta,
      compNumero: comprobantes.numero,
      importe: proveedorCompromisos.importe,
      fechaEmision: proveedorCompromisos.fechaEmision,
      fechaVenc: proveedorCompromisos.fechaVenc,
      origen: proveedorCompromisos.origen,
      esEcheq: proveedorCompromisos.esEcheq,
      cuota: proveedorCompromisos.cuota,
      cuotas: proveedorCompromisos.cuotas,
      pagado: proveedorCompromisos.pagado,
      pagoId: proveedorCompromisos.pagoId,
      obs: proveedorCompromisos.obs,
    };
  }

  private mapCompromiso(f: any) {
    return {
      ...f,
      comprobanteEtiqueta: f.comprobanteId && f.compTipo
        ? etiquetaDoc({ tipo: f.compTipo, letra: f.compLetra, puntoVenta: f.compPv, numero: f.compNumero, id: f.comprobanteId })
        : '',
      diasRest: f.fechaVenc ? diasHasta(f.fechaVenc) : null,
      diasPlazo: f.fechaVenc && f.fechaEmision
        ? Math.round((f.fechaVenc.getTime() - f.fechaEmision.getTime()) / 86400000)
        : null,
      compTipo: undefined, compLetra: undefined, compPv: undefined, compNumero: undefined,
    };
  }

  /** La vitrina "Cuentas corrientes": compromisos que NO son echeq. */
  async listarCompromisos(q: { filtro?: string; proveedorId?: number }) {
    const conds: any[] = [eq(proveedorCompromisos.esEcheq, false)];
    const hoy = hoy0();
    const filtro = q.filtro || 'pendientes';
    if (filtro === 'pendientes') conds.push(eq(proveedorCompromisos.pagado, false));
    else if (filtro === 'vencidos') {
      conds.push(eq(proveedorCompromisos.pagado, false), lt(proveedorCompromisos.fechaVenc, hoy));
    } else if (filtro === 'semana') {
      conds.push(eq(proveedorCompromisos.pagado, false), gte(proveedorCompromisos.fechaVenc, hoy));
      conds.push(lt(proveedorCompromisos.fechaVenc, new Date(hoy.getTime() + 8 * 86400000)));
    } else if (filtro === 'mes') {
      conds.push(eq(proveedorCompromisos.pagado, false));
      conds.push(gte(proveedorCompromisos.fechaVenc, new Date(hoy.getFullYear(), hoy.getMonth(), 1)));
      conds.push(lt(proveedorCompromisos.fechaVenc, new Date(hoy.getFullYear(), hoy.getMonth() + 1, 1)));
    } else if (filtro === 'futuros') {
      conds.push(eq(proveedorCompromisos.pagado, false), gte(proveedorCompromisos.fechaVenc, new Date(hoy.getTime() + 86400000)));
    } else if (filtro === 'pagados') conds.push(eq(proveedorCompromisos.pagado, true));
    // 'todos': sin filtro por pagado
    if (q.proveedorId) conds.push(eq(proveedorCompromisos.proveedorId, q.proveedorId));

    const filas = await this.db.select(this.selectCompromiso())
      .from(proveedorCompromisos)
      .leftJoin(proveedores, eq(proveedores.id, proveedorCompromisos.proveedorId))
      .leftJoin(comprobantes, eq(comprobantes.id, proveedorCompromisos.comprobanteId))
      .where(and(...conds))
      .orderBy(proveedorCompromisos.fechaVenc, proveedorCompromisos.id)
      .limit(500);
    return {
      filas: filas.map((f) => this.mapCompromiso(f)),
      total: filas.length,
      totalImporte: money(filas.reduce((a, f) => a + f.importe, 0)),
    };
  }

  /** Las alarmas de la sección y del sidebar (excluye echeqs — tienen las suyas). */
  async statsCompromisos() {
    const hoy = hoy0();
    const [r] = await this.db.select({
      vencidosN: sql<number>`count(*) filter (where ${proveedorCompromisos.fechaVenc} < ${hoy.toISOString()})::int`,
      vencidosM: sql<number>`coalesce(sum(${proveedorCompromisos.importe}) filter (where ${proveedorCompromisos.fechaVenc} < ${hoy.toISOString()}), 0)`,
      prox3N: sql<number>`count(*) filter (where ${proveedorCompromisos.fechaVenc} >= ${hoy.toISOString()} and ${proveedorCompromisos.fechaVenc} < ${new Date(hoy.getTime() + 4 * 86400000).toISOString()})::int`,
      prox3M: sql<number>`coalesce(sum(${proveedorCompromisos.importe}) filter (where ${proveedorCompromisos.fechaVenc} >= ${hoy.toISOString()} and ${proveedorCompromisos.fechaVenc} < ${new Date(hoy.getTime() + 4 * 86400000).toISOString()}), 0)`,
      semanaN: sql<number>`count(*) filter (where ${proveedorCompromisos.fechaVenc} >= ${hoy.toISOString()} and ${proveedorCompromisos.fechaVenc} < ${new Date(hoy.getTime() + 8 * 86400000).toISOString()})::int`,
      semanaM: sql<number>`coalesce(sum(${proveedorCompromisos.importe}) filter (where ${proveedorCompromisos.fechaVenc} >= ${hoy.toISOString()} and ${proveedorCompromisos.fechaVenc} < ${new Date(hoy.getTime() + 8 * 86400000).toISOString()}), 0)`,
      totalN: sql<number>`count(*)::int`,
      totalM: sql<number>`coalesce(sum(${proveedorCompromisos.importe}), 0)`,
    }).from(proveedorCompromisos)
      .where(and(eq(proveedorCompromisos.pagado, false), eq(proveedorCompromisos.esEcheq, false)));
    return {
      vencidos: { n: Number(r?.vencidosN) || 0, monto: money(Number(r?.vencidosM) || 0) },
      prox3: { n: Number(r?.prox3N) || 0, monto: money(Number(r?.prox3M) || 0) },
      semana: { n: Number(r?.semanaN) || 0, monto: money(Number(r?.semanaM) || 0) },
      total: { n: Number(r?.totalN) || 0, monto: money(Number(r?.totalM) || 0) },
    };
  }

  async getCompromiso(id: number) {
    const [f] = await this.db.select(this.selectCompromiso())
      .from(proveedorCompromisos)
      .leftJoin(proveedores, eq(proveedores.id, proveedorCompromisos.proveedorId))
      .leftJoin(comprobantes, eq(comprobantes.id, proveedorCompromisos.comprobanteId))
      .where(eq(proveedorCompromisos.id, id)).limit(1);
    if (!f) throw new NotFoundException('Compromiso inexistente.');
    return this.mapCompromiso(f);
  }

  async crearCompromisoManual(dto: CompromisoManualDto) {
    const [prov] = await this.db.select({ id: proveedores.id }).from(proveedores)
      .where(eq(proveedores.id, dto.proveedorId)).limit(1);
    if (!prov) throw new BadRequestException('Proveedor inválido.');
    const [k] = await this.db.insert(proveedorCompromisos).values({
      proveedorId: dto.proveedorId,
      importe: money(dto.importe),
      fechaEmision: dto.fechaEmision ? fecha0(dto.fechaEmision) : new Date(),
      fechaVenc: fecha0(dto.fechaVenc),
      origen: 'manual',
      obs: (dto.obs ?? '').trim(),
    }).returning();
    return this.getCompromiso(k.id);
  }

  async editarCompromiso(id: number, dto: EditarCompromisoDto) {
    const k = await this.getCompromiso(id);
    if (k.pagado) throw new BadRequestException('El compromiso ya se pagó: no se edita — la historia no se reescribe.');
    await this.db.update(proveedorCompromisos).set({
      ...(dto.importe != null ? { importe: money(dto.importe) } : {}),
      ...(dto.fechaVenc ? { fechaVenc: fecha0(dto.fechaVenc) } : {}),
      ...(dto.fechaEmision ? { fechaEmision: fecha0(dto.fechaEmision) } : {}),
      ...(dto.obs !== undefined ? { obs: dto.obs.trim() } : {}),
    }).where(eq(proveedorCompromisos.id, id));
    return this.getCompromiso(id);
  }

  async borrarCompromiso(id: number) {
    const k = await this.getCompromiso(id);
    if (k.pagado) throw new BadRequestException('El compromiso ya se pagó: quedó como historia del pago.');
    await this.db.transaction(async (tx) => {
      /* El echeq que nació con este compromiso queda ANULADO, no huérfano: un
       * echeq "a completar" cuya promesa murió no espera nada. */
      await tx.update(proveedorEcheqs).set({ estado: 'anulado' })
        .where(and(
          eq(proveedorEcheqs.compromisoId, id),
          inArray(proveedorEcheqs.estado, ['emitido', 'entregado']),
        ));
      await tx.delete(proveedorCompromisos).where(eq(proveedorCompromisos.id, id));
    });
    return { ok: true };
  }

  /**
   * PAGAR un compromiso: crea el pago REAL del sistema —con su candado de
   * caja, su arqueo, su bandeja— imputado a la factura si la hay. El puente
   * de pagos cierra el compromiso si la factura queda saldada; para la CUOTA
   * (la factura sigue debiendo) lo cierra este método, que sabe cuál era.
   */
  async pagarCompromiso(id: number, dto: PagarCompromisoDto, auth: Sesion, desdeEcheq = false) {
    const k = await this.getCompromiso(id);
    if (k.pagado) throw new BadRequestException('Ese compromiso ya está pagado.');
    if (k.esEcheq && !desdeEcheq) {
      throw new BadRequestException('Este compromiso es un echeq: se cobra desde la cartera de Echeqs.');
    }
    if (!dto.medio && !dto.formas?.length) {
      throw new BadRequestException('Indicá con qué medio REAL se pagó (la promesa decía cuenta corriente; la plata salió por algún lado).');
    }

    const concepto = `Compromiso #${k.id}`
      + (k.comprobanteEtiqueta ? ` · ${k.comprobanteEtiqueta}` : '')
      + (k.cuota ? ` · cuota ${k.cuota}/${k.cuotas}` : '')
      + (dto.obs?.trim() ? ` · ${dto.obs.trim()}` : '');
    const fecha = dto.fecha ?? aIso(new Date());

    let importePago = money(k.importe);
    let imputaciones: Array<{ comprobanteId: number; importe: number }> | undefined;
    if (k.comprobanteId) {
      /* El saldo VIVO de la factura (con sus notas descontadas): se paga lo
       * que la factura debe, no lo que el compromiso recuerda — una NC pudo
       * haber bajado la deuda después de pactar el vencimiento. */
      const pendientes = await this.pagos.documentosPendientes(k.proveedorId, 'mercaderia');
      const doc = pendientes.find((d: any) => d.tipo === 'comprobante' && d.docId === k.comprobanteId);
      const saldoDoc = doc ? money(doc.saldo) : 0;
      if (saldoDoc <= EPS) {
        // La factura ya estaba saldada por otro camino: cerrar sin mover plata.
        await this.db.update(proveedorCompromisos).set({ pagado: true })
          .where(and(eq(proveedorCompromisos.id, id), eq(proveedorCompromisos.pagado, false)));
        return { ...(await this.getCompromiso(id)), aviso: 'La factura ya estaba saldada: el compromiso se cerró sin generar un pago nuevo.' };
      }
      importePago = Math.min(importePago, saldoDoc);
      imputaciones = [{ comprobanteId: k.comprobanteId, importe: importePago }];
    }

    const pago = await this.pagos.crear({
      proveedorId: k.proveedorId,
      ...(k.comprobanteId ? { destino: 'mercaderia' as const } : {}),
      importe: importePago,
      medio: dto.formas?.length ? undefined : dto.medio,
      formas: dto.formas,
      fecha,
      concepto,
      referencia: dto.referencia,
      cajaSesionId: dto.cajaSesionId,
      usuarioId: auth.usuarioId,
      imputaciones,
    } as any, auth.sucursalId, esJefe(auth));

    /* La CUOTA: si la factura sigue con saldo, el puente no lo cerró — lo
     * cierra este método, que es el único que sabe qué compromiso se pagó. */
    await this.db.update(proveedorCompromisos).set({ pagado: true, pagoId: pago.id })
      .where(eq(proveedorCompromisos.id, id));
    await this.db.update(proveedorEcheqs).set({ estado: 'cobrado', pagoId: pago.id })
      .where(and(
        eq(proveedorEcheqs.compromisoId, id),
        inArray(proveedorEcheqs.estado, ['emitido', 'entregado']),
      ));
    return { ...(await this.getCompromiso(id)), pago };
  }

  /* ==================================================================== *
   * Echeqs
   * ==================================================================== */

  private selectEcheq() {
    return {
      id: proveedorEcheqs.id,
      numero: proveedorEcheqs.numero,
      banco: proveedorEcheqs.banco,
      importe: proveedorEcheqs.importe,
      fechaEmision: proveedorEcheqs.fechaEmision,
      fechaVenc: proveedorEcheqs.fechaVenc,
      proveedorId: proveedorEcheqs.proveedorId,
      proveedorNombre: sql<string>`coalesce(${proveedores.nombre}, '')`,
      compromisoId: proveedorEcheqs.compromisoId,
      pagoId: proveedorEcheqs.pagoId,
      estado: proveedorEcheqs.estado,
      obs: proveedorEcheqs.obs,
    };
  }

  async listarEcheqs(q: { filtro?: string; proveedorId?: number; buscar?: string }) {
    const conds: any[] = [];
    const hoy = hoy0();
    const filtro = q.filtro || 'activos';
    if (filtro === 'activos') conds.push(inArray(proveedorEcheqs.estado, ['emitido', 'entregado']));
    else if (filtro === 'vencidos') {
      conds.push(inArray(proveedorEcheqs.estado, ['emitido', 'entregado']), lt(proveedorEcheqs.fechaVenc, hoy));
    } else if (filtro === 'semana') {
      conds.push(inArray(proveedorEcheqs.estado, ['emitido', 'entregado']));
      conds.push(gte(proveedorEcheqs.fechaVenc, hoy), lt(proveedorEcheqs.fechaVenc, new Date(hoy.getTime() + 8 * 86400000)));
    } else if (filtro === 'cobrados') conds.push(eq(proveedorEcheqs.estado, 'cobrado'));
    else if (filtro === 'anulados') conds.push(eq(proveedorEcheqs.estado, 'anulado'));
    if (q.proveedorId) conds.push(eq(proveedorEcheqs.proveedorId, q.proveedorId));
    if (q.buscar?.trim()) {
      const like = `%${q.buscar.trim()}%`;
      conds.push(sql`(${proveedorEcheqs.numero} ILIKE ${like} OR ${proveedorEcheqs.banco} ILIKE ${like} OR ${proveedores.nombre} ILIKE ${like} OR ${proveedorEcheqs.obs} ILIKE ${like})`);
    }
    const filas = await this.db.select(this.selectEcheq())
      .from(proveedorEcheqs)
      .leftJoin(proveedores, eq(proveedores.id, proveedorEcheqs.proveedorId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(proveedorEcheqs.fechaVenc, desc(proveedorEcheqs.id))
      .limit(500);
    return {
      filas: filas.map((f) => ({ ...f, diasRest: diasHasta(f.fechaVenc) })),
      total: filas.length,
      totalImporte: money(filas.reduce((a, f) => a + f.importe, 0)),
    };
  }

  async statsEcheqs() {
    const hoy = hoy0();
    const activos = inArray(proveedorEcheqs.estado, ['emitido', 'entregado']);
    const [r] = await this.db.select({
      activosN: sql<number>`count(*)::int`,
      activosM: sql<number>`coalesce(sum(${proveedorEcheqs.importe}), 0)`,
      vencidosN: sql<number>`count(*) filter (where ${proveedorEcheqs.fechaVenc} < ${hoy.toISOString()})::int`,
      vencidosM: sql<number>`coalesce(sum(${proveedorEcheqs.importe}) filter (where ${proveedorEcheqs.fechaVenc} < ${hoy.toISOString()}), 0)`,
      prox3N: sql<number>`count(*) filter (where ${proveedorEcheqs.fechaVenc} >= ${hoy.toISOString()} and ${proveedorEcheqs.fechaVenc} < ${new Date(hoy.getTime() + 4 * 86400000).toISOString()})::int`,
      prox3M: sql<number>`coalesce(sum(${proveedorEcheqs.importe}) filter (where ${proveedorEcheqs.fechaVenc} >= ${hoy.toISOString()} and ${proveedorEcheqs.fechaVenc} < ${new Date(hoy.getTime() + 4 * 86400000).toISOString()}), 0)`,
    }).from(proveedorEcheqs).where(activos);
    const porBanco = await this.db.select({
      banco: proveedorEcheqs.banco,
      n: sql<number>`count(*)::int`,
      monto: sql<number>`coalesce(sum(${proveedorEcheqs.importe}), 0)`,
    }).from(proveedorEcheqs).where(activos)
      .groupBy(proveedorEcheqs.banco)
      .orderBy(desc(sql`coalesce(sum(${proveedorEcheqs.importe}), 0)`))
      .limit(5);
    return {
      activos: { n: Number(r?.activosN) || 0, monto: money(Number(r?.activosM) || 0) },
      vencidos: { n: Number(r?.vencidosN) || 0, monto: money(Number(r?.vencidosM) || 0) },
      prox3: { n: Number(r?.prox3N) || 0, monto: money(Number(r?.prox3M) || 0) },
      porBanco: porBanco.map((b) => ({ banco: b.banco, n: Number(b.n) || 0, monto: money(Number(b.monto) || 0) })),
    };
  }

  async getEcheq(id: number) {
    const [f] = await this.db.select(this.selectEcheq())
      .from(proveedorEcheqs)
      .leftJoin(proveedores, eq(proveedores.id, proveedorEcheqs.proveedorId))
      .where(eq(proveedorEcheqs.id, id)).limit(1);
    if (!f) throw new NotFoundException('Echeq inexistente.');
    return { ...f, diasRest: diasHasta(f.fechaVenc) };
  }

  async crearEcheq(dto: EcheqDto) {
    if (!dto.proveedorId) throw new BadRequestException('Elegí el proveedor del echeq.');
    if (!dto.fechaVenc) throw new BadRequestException('El echeq necesita su fecha de cobro.');
    if (!(Number(dto.importe) > 0)) throw new BadRequestException('El importe del echeq tiene que ser mayor a 0.');
    const [prov] = await this.db.select({ id: proveedores.id }).from(proveedores)
      .where(eq(proveedores.id, dto.proveedorId)).limit(1);
    if (!prov) throw new BadRequestException('Proveedor inválido.');
    const [e] = await this.db.insert(proveedorEcheqs).values({
      numero: (dto.numero ?? '').trim(),
      banco: (dto.banco ?? '').trim(),
      importe: money(dto.importe!),
      fechaEmision: dto.fechaEmision ? fecha0(dto.fechaEmision) : new Date(),
      fechaVenc: fecha0(dto.fechaVenc),
      proveedorId: dto.proveedorId,
      obs: (dto.obs ?? '').trim(),
    }).returning();
    return this.getEcheq(e.id);
  }

  async editarEcheq(id: number, dto: EcheqDto) {
    const e = await this.getEcheq(id);
    if (e.estado === 'cobrado') throw new BadRequestException('El echeq ya se cobró: el pago quedó registrado y no se reescribe.');
    /* El importe del echeq que nació de una factura ES el de su compromiso:
     * se corrige editando el compromiso (o la factura), no el papel. */
    if (dto.importe != null && e.compromisoId) {
      throw new BadRequestException('Este echeq nació de una factura: su importe es el del compromiso.');
    }
    await this.db.update(proveedorEcheqs).set({
      ...(dto.numero !== undefined ? { numero: dto.numero.trim() } : {}),
      ...(dto.banco !== undefined ? { banco: dto.banco.trim() } : {}),
      ...(dto.importe != null && !e.compromisoId ? { importe: money(dto.importe) } : {}),
      ...(dto.fechaEmision ? { fechaEmision: fecha0(dto.fechaEmision) } : {}),
      ...(dto.fechaVenc ? { fechaVenc: fecha0(dto.fechaVenc) } : {}),
      ...(dto.obs !== undefined ? { obs: dto.obs.trim() } : {}),
    }).where(eq(proveedorEcheqs.id, id));
    return this.getEcheq(id);
  }

  /**
   * El cambio de estado del echeq. 'cobrado' es EL momento contable: el banco
   * debitó — se crea el pago real (medio 'echeq', fecha = la del vencimiento,
   * que es cuando se debita de verdad) y se aplica a la factura vía su
   * compromiso. Los demás estados son seguimiento del papel.
   */
  async estadoEcheq(id: number, estado: string, auth: Sesion) {
    const e = await this.getEcheq(id);
    if (e.estado === estado) return e;
    if (e.estado === 'cobrado') {
      throw new BadRequestException('El echeq ya se cobró: si el pago está mal, se anula desde Pagos (eso lo devuelve a emitido).');
    }
    if (estado === 'cobrado') {
      if (e.pagoId) {
        await this.db.update(proveedorEcheqs).set({ estado: 'cobrado' }).where(eq(proveedorEcheqs.id, id));
        return this.getEcheq(id);
      }
      if (e.compromisoId) {
        const k = await this.getCompromiso(e.compromisoId);
        if (!k.pagado) {
          await this.pagarCompromiso(k.id, { medio: 'echeq', fecha: aIso(e.fechaVenc) }, auth, true);
        } else if (k.pagoId) {
          // El compromiso ya se pagó por otro camino: solo linkear el papel.
          await this.db.update(proveedorEcheqs).set({ estado: 'cobrado', pagoId: k.pagoId })
            .where(eq(proveedorEcheqs.id, id));
        }
        return this.getEcheq(id);
      }
      // Echeq suelto (sin compromiso): pago a cuenta del proveedor.
      const pago = await this.pagos.crear({
        proveedorId: e.proveedorId,
        importe: money(e.importe),
        medio: 'echeq',
        fecha: aIso(e.fechaVenc),
        concepto: `Cobro de echeq ${e.numero || `#${e.id}`}${e.banco ? ` (${e.banco})` : ''}`,
        usuarioId: auth.usuarioId,
      } as any, auth.sucursalId, esJefe(auth));
      await this.db.update(proveedorEcheqs).set({ estado: 'cobrado', pagoId: pago.id })
        .where(eq(proveedorEcheqs.id, id));
      return this.getEcheq(id);
    }
    await this.db.update(proveedorEcheqs).set({ estado: estado as any }).where(eq(proveedorEcheqs.id, id));
    return this.getEcheq(id);
  }

  async borrarEcheq(id: number) {
    const e = await this.getEcheq(id);
    if (e.estado === 'cobrado' || e.pagoId) {
      throw new BadRequestException('El echeq ya se cobró: tiene un pago atrás. Anulá el pago primero si está mal.');
    }
    await this.db.delete(proveedorEcheqs).where(eq(proveedorEcheqs.id, id));
    return { ok: true };
  }

  /* ==================================================================== *
   * Estado de cuenta (EDOC)
   * ==================================================================== */

  /**
   * La foto global: una fila por proveedor con movimiento. El saldo usa LA
   * MISMA fórmula que `cuenta()` de pagos (mercadería + gastos − pagos) más
   * los ajustes manuales — está una sola vez acá y una sola vez allá, y las
   * dos suman los mismos conjuntos: cambiarla en un lado sin el otro es el
   * bug de "los números no cuadran entre pantallas" de la app vieja.
   */
  async edocGlobal() {
    const [compAgg, gastoAgg, pagoAgg, ajusteAgg, compromAgg, provs] = await Promise.all([
      this.db.select({
        proveedorId: comprobantes.proveedorId,
        deuda: sql<number>`coalesce(sum(case when ${comprobantes.tipo} in ('factura','liquidacion','nota_debito') then ${comprobantes.total} when ${comprobantes.tipo} = 'nota_credito' then -${comprobantes.total} else 0 end), 0)`,
        // La factura impaga MÁS VIEJA: de acá sale el estado "vencido"
        // (fecha + días de pago del proveedor ya pasó).
        impagaDesde: sql<string | null>`min(${comprobantes.fecha}) filter (where ${comprobantes.tipo} in ('factura','liquidacion','nota_debito') and ${comprobantes.total} - ${comprobantes.pagado} > ${EPS})`,
      }).from(comprobantes)
        .where(eq(comprobantes.estado, 'confirmado'))
        .groupBy(comprobantes.proveedorId),
      this.db.select({
        proveedorId: gastos.proveedorId,
        deuda: sql<number>`coalesce(sum(${gastos.total}), 0)`,
        impagaDesde: sql<string | null>`min(${gastos.fecha}) filter (where ${gastos.total} - ${gastos.pagado} > ${EPS})`,
      }).from(gastos)
        .where(and(ne(gastos.estado, 'anulado'), sql`${gastos.proveedorId} is not null`))
        .groupBy(gastos.proveedorId),
      this.db.select({
        proveedorId: proveedorPagos.proveedorId,
        pagado: sql<number>`coalesce(sum(${proveedorPagos.importe}), 0)`,
        ultimoPago: sql<string | null>`max(${proveedorPagos.fecha})`,
      }).from(proveedorPagos)
        .where(and(eq(proveedorPagos.estado, 'activo'), sql`${proveedorPagos.proveedorId} is not null`))
        .groupBy(proveedorPagos.proveedorId),
      this.db.select({
        proveedorId: proveedorAjustes.proveedorId,
        ajustes: sql<number>`coalesce(sum(${proveedorAjustes.importe}), 0)`,
      }).from(proveedorAjustes).groupBy(proveedorAjustes.proveedorId),
      this.db.select({
        proveedorId: proveedorCompromisos.proveedorId,
        pendiente: sql<number>`coalesce(sum(${proveedorCompromisos.importe}), 0)`,
      }).from(proveedorCompromisos)
        .where(eq(proveedorCompromisos.pagado, false))
        .groupBy(proveedorCompromisos.proveedorId),
      this.db.select({
        id: proveedores.id, nombre: proveedores.nombre, diasPago: proveedores.diasPago,
        modoCuenta: proveedores.modoCuenta, medioHabitual: proveedores.medioHabitual,
        conciliadoHasta: proveedores.conciliadoHasta,
      }).from(proveedores).orderBy(proveedores.nombre),
    ]);

    const porId = <T extends { proveedorId: number | null }>(xs: T[]) =>
      new Map(xs.filter((x) => x.proveedorId != null).map((x) => [x.proveedorId as number, x]));
    const mComp = porId(compAgg); const mGasto = porId(gastoAgg);
    const mPago = porId(pagoAgg); const mAjuste = porId(ajusteAgg); const mComprom = porId(compromAgg);

    const hoy = hoy0();
    const filas: any[] = [];
    for (const p of provs) {
      const mercaderia = money(Number(mComp.get(p.id)?.deuda) || 0);
      const gastosTot = money(Number(mGasto.get(p.id)?.deuda) || 0);
      const pagado = money(Number(mPago.get(p.id)?.pagado) || 0);
      const ajustes = money(Number(mAjuste.get(p.id)?.ajustes) || 0);
      const pendientes = money(Number(mComprom.get(p.id)?.pendiente) || 0);
      if (!mercaderia && !gastosTot && !pagado && !ajustes && !pendientes) continue;
      const saldo = money(mercaderia + gastosTot + ajustes - pagado);

      let estado: 'a_favor' | 'al_dia' | 'pendiente' | 'vencido' = 'al_dia';
      if (saldo < -EPS) estado = 'a_favor';
      else if (saldo > EPS) {
        estado = 'pendiente';
        const desdeRaw = mComp.get(p.id)?.impagaDesde ?? mGasto.get(p.id)?.impagaDesde ?? null;
        if (desdeRaw && p.diasPago != null && p.diasPago > 0) {
          const desde = new Date(desdeRaw);
          if (!Number.isNaN(desde.getTime())
            && hoy.getTime() - desde.getTime() > p.diasPago * 86400000) estado = 'vencido';
        }
      }

      filas.push({
        id: p.id,
        nombre: p.nombre,
        diasPago: p.diasPago,
        modoCuenta: p.modoCuenta,
        medioHabitual: p.medioHabitual,
        conciliadoHasta: p.conciliadoHasta,
        mercaderia, gastos: gastosTot, ajustes, pagado,
        saldo,
        compromisosPendientes: pendientes,
        saldoProyectado: money(saldo - pendientes),
        ultimoPago: mPago.get(p.id)?.ultimoPago ?? null,
        estado,
      });
    }
    return filas;
  }

  /**
   * El mayor de UN proveedor: cada movimiento al DEBE o al HABER, la
   * antigüedad FIFO de la deuda, sus compromisos pendientes y sus cuentas.
   */
  async edocProveedor(proveedorId: number) {
    const [prov] = await this.db.select().from(proveedores)
      .where(eq(proveedores.id, proveedorId)).limit(1);
    if (!prov) throw new NotFoundException('Proveedor inexistente.');

    const [comps, gs, pgs, ajs, formasTodas, compromisos, cuentas] = await Promise.all([
      this.db.select().from(comprobantes).where(and(
        eq(comprobantes.proveedorId, proveedorId),
        eq(comprobantes.estado, 'confirmado'),
        inArray(comprobantes.tipo, ['factura', 'liquidacion', 'nota_debito', 'nota_credito']),
      )),
      this.db.select().from(gastos).where(and(
        eq(gastos.proveedorId, proveedorId), ne(gastos.estado, 'anulado'),
      )),
      this.db.select().from(proveedorPagos).where(and(
        eq(proveedorPagos.proveedorId, proveedorId), eq(proveedorPagos.estado, 'activo'),
      )),
      this.db.select().from(proveedorAjustes).where(eq(proveedorAjustes.proveedorId, proveedorId)),
      this.db.select().from(pagoFormas)
        .where(inArray(pagoFormas.pagoId,
          this.db.select({ id: proveedorPagos.id }).from(proveedorPagos)
            .where(and(eq(proveedorPagos.proveedorId, proveedorId), eq(proveedorPagos.estado, 'activo'))) as any)),
      this.db.select(this.selectCompromiso())
        .from(proveedorCompromisos)
        .leftJoin(proveedores, eq(proveedores.id, proveedorCompromisos.proveedorId))
        .leftJoin(comprobantes, eq(comprobantes.id, proveedorCompromisos.comprobanteId))
        .where(and(eq(proveedorCompromisos.proveedorId, proveedorId), eq(proveedorCompromisos.pagado, false)))
        .orderBy(proveedorCompromisos.fechaVenc),
      this.db.select().from(proveedorCuentas).where(eq(proveedorCuentas.proveedorId, proveedorId)),
    ]);

    const formasPorPago = new Map<number, any[]>();
    for (const f of formasTodas) {
      const arr = formasPorPago.get(f.pagoId) ?? [];
      arr.push({ medio: f.medio, importe: f.importe, fecha: f.fecha });
      formasPorPago.set(f.pagoId, arr);
    }

    const movs: any[] = [];
    for (const c of comps) {
      const esNc = c.tipo === 'nota_credito';
      movs.push({
        kind: esNc ? 'nc' : 'comprobante',
        id: c.id,
        fecha: c.fecha,
        etiqueta: etiquetaDoc(c),
        detalle: c.observaciones || '',
        debe: esNc ? 0 : money(c.total),
        haber: esNc ? money(c.total) : 0,
        saldoDoc: esNc ? null : money(c.total - c.pagado),
      });
    }
    for (const g of gs) {
      movs.push({
        kind: 'gasto',
        id: g.id,
        fecha: g.fecha,
        etiqueta: `Gasto #${g.id}${g.numero ? ` · ${g.numero}` : ''}`,
        detalle: g.descripcion || '',
        debe: money(g.total),
        haber: 0,
        saldoDoc: money(g.total - g.pagado),
      });
    }
    for (const p of pgs) {
      const formas = formasPorPago.get(p.id) ?? [];
      movs.push({
        kind: 'pago',
        id: p.id,
        fecha: p.fecha,
        etiqueta: formas.length > 1
          ? `Pago mixto (${formas.map((f) => f.medio).join(' + ')})`
          : `Pago (${p.medio})`,
        detalle: p.concepto || '',
        debe: 0,
        haber: money(p.importe),
        formas,
      });
    }
    for (const a of ajs) {
      const esDebe = a.importe >= 0;
      movs.push({
        kind: esDebe ? 'ajuste_debe' : 'ajuste_haber',
        id: a.id,
        fecha: a.fecha,
        etiqueta: `Ajuste ${esDebe ? 'DEBE' : 'HABER'}`,
        detalle: a.motivo,
        debe: esDebe ? money(a.importe) : 0,
        haber: esDebe ? 0 : money(-a.importe),
      });
    }
    movs.sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime() || b.id - a.id);

    const totDebe = money(movs.reduce((s, m) => s + m.debe, 0));
    const totHaber = money(movs.reduce((s, m) => s + m.haber, 0));
    const saldo = money(totDebe - totHaber);

    /*
     * ANTIGÜEDAD FIFO: ¿desde cuándo arrastra deuda? Se aplican los HABER
     * contra los DEBE en orden cronológico — lo cobrado cancela primero lo
     * más viejo — y el primer DEBE que queda sin cubrir marca el inicio de
     * la deuda actual. Es EL dato de los proveedores en modo libre (sus
     * pagos no dicen a qué factura fueron), y sirve igual para todos.
     */
    let deudaDesde: any = null;
    if (saldo > EPS) {
      const cron = [...movs].sort((a, b) => new Date(a.fecha).getTime() - new Date(b.fecha).getTime() || a.id - b.id);
      let haberDisp = totHaber;
      for (const m of cron) {
        if (m.debe <= EPS) continue;
        if (haberDisp >= m.debe - EPS) { haberDisp = money(haberDisp - m.debe); continue; }
        deudaDesde = m.fecha;
        break;
      }
    }

    return {
      proveedor: {
        id: prov.id, nombre: prov.nombre, cuit: prov.cuit,
        modoCuenta: prov.modoCuenta, medioHabitual: prov.medioHabitual, diasPago: prov.diasPago,
        conciliadoHasta: prov.conciliadoHasta, conciliadoAt: prov.conciliadoAt,
      },
      movs,
      totDebe,
      totHaber,
      saldo,
      deudaDesde,
      compromisos: compromisos.map((k) => this.mapCompromiso(k)),
      cuentas,
    };
  }

  async crearAjuste(dto: AjusteDto, usuarioId: number | null) {
    const [prov] = await this.db.select({ id: proveedores.id }).from(proveedores)
      .where(eq(proveedores.id, dto.proveedorId)).limit(1);
    if (!prov) throw new BadRequestException('Proveedor inválido.');
    if (!dto.motivo.trim()) throw new BadRequestException('El motivo del ajuste es obligatorio: sin explicación no se audita.');
    const importe = dto.tipo === 'haber' ? -money(dto.monto) : money(dto.monto);
    const [a] = await this.db.insert(proveedorAjustes).values({
      proveedorId: dto.proveedorId,
      importe,
      motivo: dto.motivo.trim(),
      fecha: dto.fecha ? fecha0(dto.fecha) : new Date(),
      usuarioId,
    }).returning();
    return a;
  }

  async borrarAjuste(id: number) {
    const [a] = await this.db.select().from(proveedorAjustes).where(eq(proveedorAjustes.id, id)).limit(1);
    if (!a) throw new NotFoundException('Ajuste inexistente.');
    await this.db.delete(proveedorAjustes).where(eq(proveedorAjustes.id, id));
    return { ok: true };
  }

  /** "Cuadré con el resumen del proveedor hasta hoy" — con quién y cuándo. */
  async conciliar(proveedorId: number, usuarioId: number) {
    const [p] = await this.db.update(proveedores).set({
      conciliadoHasta: new Date(),
      conciliadoPor: usuarioId,
      conciliadoAt: new Date(),
    }).where(eq(proveedores.id, proveedorId)).returning({ conciliadoHasta: proveedores.conciliadoHasta });
    if (!p) throw new NotFoundException('Proveedor inexistente.');
    return { proveedorId, conciliadoHasta: p.conciliadoHasta };
  }

  async desconciliar(proveedorId: number) {
    await this.db.update(proveedores).set({
      conciliadoHasta: null, conciliadoPor: null, conciliadoAt: null,
    }).where(eq(proveedores.id, proveedorId));
    return { proveedorId, conciliadoHasta: null };
  }
}

/* ------------------------------ Controllers ------------------------------ */

@Controller('compromisos')
@Permiso('proveedores.ctasctes')
export class CompromisosController {
  constructor(private readonly svc: FinanzasProveedorService) {}

  @Get() list(@Query('filtro') filtro?: string, @Query('proveedorId') proveedorId?: string) {
    return this.svc.listarCompromisos({ filtro, proveedorId: proveedorId ? Number(proveedorId) : undefined });
  }
  @Get('stats') stats() { return this.svc.statsCompromisos(); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.getCompromiso(id); }
  @Post() crear(@Body() dto: CompromisoManualDto) { return this.svc.crearCompromisoManual(dto); }
  @Patch(':id') editar(@Param('id', ParseIntPipe) id: number, @Body() dto: EditarCompromisoDto) {
    return this.svc.editarCompromiso(id, dto);
  }
  @Post(':id/pagar') pagar(
    @Param('id', ParseIntPipe) id: number, @Body() dto: PagarCompromisoDto, @Auth() auth: Sesion,
  ) {
    return this.svc.pagarCompromiso(id, dto, auth);
  }
  @Delete(':id') borrar(@Param('id', ParseIntPipe) id: number) { return this.svc.borrarCompromiso(id); }
}

@Controller('echeqs')
@Permiso('proveedores.echeqs')
export class EcheqsController {
  constructor(private readonly svc: FinanzasProveedorService) {}

  @Get() list(
    @Query('filtro') filtro?: string,
    @Query('proveedorId') proveedorId?: string,
    @Query('buscar') buscar?: string,
  ) {
    return this.svc.listarEcheqs({ filtro, proveedorId: proveedorId ? Number(proveedorId) : undefined, buscar });
  }
  @Get('stats') stats() { return this.svc.statsEcheqs(); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.getEcheq(id); }
  @Post() crear(@Body() dto: EcheqDto) { return this.svc.crearEcheq(dto); }
  @Patch(':id') editar(@Param('id', ParseIntPipe) id: number, @Body() dto: EcheqDto) {
    return this.svc.editarEcheq(id, dto);
  }
  @Post(':id/estado') estado(
    @Param('id', ParseIntPipe) id: number, @Body() dto: EstadoEcheqDto, @Auth() auth: Sesion,
  ) {
    return this.svc.estadoEcheq(id, dto.estado, auth);
  }
  @Delete(':id') borrar(@Param('id', ParseIntPipe) id: number) { return this.svc.borrarEcheq(id); }
}

@Controller('proveedores-edoc')
@Permiso('proveedores.edoc')
export class EdocController {
  constructor(private readonly svc: FinanzasProveedorService) {}

  @Get() global() { return this.svc.edocGlobal(); }
  @Get(':proveedorId') detalle(@Param('proveedorId', ParseIntPipe) id: number) {
    return this.svc.edocProveedor(id);
  }
  @Post('ajustes') ajuste(@Body() dto: AjusteDto, @Auth() auth: Sesion) {
    return this.svc.crearAjuste(dto, auth.usuarioId ?? null);
  }
  @Delete('ajustes/:id') borrarAjuste(@Param('id', ParseIntPipe) id: number) {
    return this.svc.borrarAjuste(id);
  }
  @Post(':proveedorId/conciliar') conciliar(@Param('proveedorId', ParseIntPipe) id: number, @Auth() auth: Sesion) {
    return this.svc.conciliar(id, auth.usuarioId);
  }
  @Delete(':proveedorId/conciliar') desconciliar(@Param('proveedorId', ParseIntPipe) id: number) {
    return this.svc.desconciliar(id);
  }
}

@Module({
  imports: [PagosModule],
  controllers: [CompromisosController, EcheqsController, EdocController],
  providers: [FinanzasProveedorService],
})
export class FinanzasProveedorModule {}
