/**
 * CASH FLOW — la caja central de efectivo físico del dueño (0133, 4/10/2026)
 * ============================================================================
 * Todo el efectivo que le LLEGA al dueño (los sobres de cada cierre de caja de
 * los locales, otros ingresos) y el que SACA (retiros, depósitos, y en la
 * parte 2 pagos a proveedores y gastos). La suma del libro es el saldo en mano.
 *
 * Reglas que protegen la plata (todas del lado del servidor):
 *   · Todo lo que mueve dinero pide `confirmado: true` (la pantalla confirma
 *     dos veces) y se graba en UNA transacción con la fila candada (`for
 *     update`): dos clics seguidos no controlan dos veces el mismo sobre ni
 *     sacan dos veces la misma plata.
 *   · Los sobres se controlan UNA vez (índice único vigente en la base). Si lo
 *     contado no coincide con lo enviado, la diferencia queda con su motivo y
 *     con el cajero que armó el sobre.
 *   · Nada se borra: se ANULA con motivo, quién y cuándo, y sigue a la vista.
 *   · Un egreso no puede dejar el saldo en negativo: no se saca plata que no
 *     está en la mano (lo que está en tránsito en sobres sin controlar no cuenta).
 *   · El arranque (fecha + saldo inicial) solo se cambia mientras no haya
 *     movimientos: después, la historia no se reescribe.
 *
 * SOLO EL SUPERADMIN: la llave `gerencia.cashflow` no está en el catálogo de
 * permisos (como `gerencia.metricas`), así que solo pasa el comodín `*`.
 */
import {
  BadRequestException, Body, ConflictException, Controller, Get, Inject, Injectable, Module, NotFoundException,
  Param, ParseIntPipe, Patch, Post, Put, Query,
} from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  cajaSesiones, cashflowCaja, cashflowConceptos, cashflowConteos, cashflowMovimientos, cashflowSobres, gastoCategorias,
  proveedorImputaciones, proveedorPagos, proveedores, sucursales,
} from '../db/schema';
import { DENOMINACIONES } from '../caja/caja.module';
import { PagosModule, PagosProveedorService } from '../pagos/pagos.module';
import { GastosModule, GastosService } from '../gastos/gastos.module';

/** La llave: fuera del catálogo, solo la tiene el superadmin (`*`). */
export const PERMISO_CASHFLOW = 'gerencia.cashflow';

const ZONA = 'America/Argentina/Buenos_Aires';
const money = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
const MAX_IMPORTE = 100_000_000_000;
const esDia = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v);
/** 'AAAA-MM-DD' del instante en hora argentina. */
const diaAr = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: ZONA });
const hoyAr = () => diaAr(new Date());
/** Un día argentino, como rango sobre una columna timestamptz (usa el índice). */
const desdeDia = (col: string, p: string) => sql.raw(`${col} >= ('${p}'::date::timestamp at time zone '${ZONA}')`);
const hastaDia = (col: string, p: string) => sql.raw(`${col} < (('${p}'::date + 1)::timestamp at time zone '${ZONA}')`);
const esUnico = (e: any) => e?.code === '23505' || e?.cause?.code === '23505';
const TIPOS = ['ingreso', 'egreso'] as const;
const CLASES = ['gasto', 'movimiento'] as const;
/** Más de esto abierta, la caja de un local se avisa como olvidada. */
const HORAS_CAJA_ABIERTA = 24;

/* ------------------------------ DTOs ------------------------------ */
class InicioDto {
  @IsString() fechaInicio!: string;
  @IsNumber() @Min(0) @Max(MAX_IMPORTE) saldoInicial!: number;
  @IsBoolean() confirmado!: boolean;
}
class ControlarSobreDto {
  @IsNumber() @Min(0) @Max(MAX_IMPORTE) contado!: number;
  @IsOptional() @IsString() @MaxLength(300) motivo?: string;
  @IsBoolean() confirmado!: boolean;
}
class AnularDto {
  @IsString() @MaxLength(300) motivo!: string;
}
class ConceptoDto {
  @IsOptional() @IsString() @MaxLength(60) nombre?: string;
  @IsOptional() @IsIn(TIPOS as unknown as string[]) tipo?: 'ingreso' | 'egreso';
  @IsOptional() @IsIn(CLASES as unknown as string[]) clase?: 'gasto' | 'movimiento';
  @IsOptional() @IsInt() gastoCategoriaId?: number | null;
  @IsOptional() @IsBoolean() activo?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(100000) orden?: number;
}
/** Una imputación del pago a proveedor: a qué factura (o gasto cargado) y cuánto. */
class ImputacionCfDto {
  @IsOptional() @IsInt() comprobanteId?: number;
  @IsOptional() @IsInt() gastoId?: number;
  @IsNumber() @Min(0.01) @Max(MAX_IMPORTE) importe!: number;
}
class PagoProveedorDto {
  @IsInt() proveedorId!: number;
  @IsIn(['mercaderia', 'gastos']) destino!: 'mercaderia' | 'gastos';
  @IsIn(['efectivo', 'deposito']) medio!: 'efectivo' | 'deposito';
  @IsNumber() @Min(0.01) @Max(MAX_IMPORTE) importe!: number;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ImputacionCfDto) imputaciones?: ImputacionCfDto[];
  @IsOptional() @IsString() @MaxLength(200) referencia?: string;
  @IsOptional() @IsString() @MaxLength(300) detalle?: string;
  @IsOptional() @IsString() fecha?: string;
  @IsBoolean() confirmado!: boolean;
}
/** «Contar mi caja»: los billetes por denominación (+ monedas y otros) y si la diferencia se ajusta en el libro. */
class ConteoDto {
  @IsOptional() billetes?: Record<string, number>;
  @IsOptional() @IsNumber() @Min(0) @Max(MAX_IMPORTE) otros?: number;
  @IsOptional() @IsBoolean() ajustar?: boolean;
  @IsOptional() @IsString() @MaxLength(300) motivo?: string;
  @IsBoolean() confirmado!: boolean;
}
class MovimientoDto {
  @IsIn(TIPOS as unknown as string[]) tipo!: 'ingreso' | 'egreso';
  @IsInt() conceptoId!: number;
  @IsNumber() @Min(0) @Max(MAX_IMPORTE) importe!: number;
  @IsOptional() @IsString() fecha?: string;
  @IsOptional() @IsString() @MaxLength(300) detalle?: string;
  @IsBoolean() confirmado!: boolean;
}

@Injectable()
export class CashflowService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly pagos: PagosProveedorService,
    private readonly gastos: GastosService,
  ) {}

  /** La caja (una sola fila) o null si todavía no arrancó. */
  private async caja(db: any = this.db) {
    const [c] = await db.select().from(cashflowCaja).limit(1);
    return c ?? null;
  }

  /** La suma del libro: ingresos − egresos vigentes. */
  private async saldo(db: any = this.db): Promise<number> {
    const [r] = await db.select({
      s: sql<number>`coalesce(sum(case when ${cashflowMovimientos.tipo} = 'ingreso' then ${cashflowMovimientos.importe} else -${cashflowMovimientos.importe} end), 0)`,
    }).from(cashflowMovimientos).where(isNull(cashflowMovimientos.anuladoEn));
    return money(r?.s);
  }

  /* ------------------------------ Arranque ------------------------------ */

  async inicio(dto: InicioDto, usuarioId: number | null) {
    if (dto.confirmado !== true) throw new BadRequestException('Confirmá el arranque.');
    if (!esDia(dto.fechaInicio)) throw new BadRequestException('La fecha de arranque tiene que ser un día válido (AAAA-MM-DD).');
    if (dto.fechaInicio > hoyAr()) throw new BadRequestException('La fecha de arranque no puede ser futura.');
    const saldo = money(dto.saldoInicial);
    await this.db.transaction(async (tx) => {
      const [actual] = await tx.select().from(cashflowCaja).limit(1).for('update');
      /* Con movimientos registrados (controles de sobres, egresos), la historia
       * no se reescribe: el saldo inicial es el punto de partida de todos ellos. */
      const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(cashflowMovimientos)
        .where(and(isNull(cashflowMovimientos.anuladoEn), sql`${cashflowMovimientos.origen} <> 'saldo_inicial'`));
      if (Number(n?.n) > 0) {
        throw new BadRequestException('Ya hay movimientos registrados: el arranque no se puede cambiar. Si hace falta corregir el efectivo en mano, registrá un ingreso o un egreso con su motivo.');
      }
      if (actual) {
        await tx.update(cashflowCaja).set({ fechaInicio: dto.fechaInicio, saldoInicial: saldo, abiertaEn: new Date(), abiertaPor: usuarioId })
          .where(eq(cashflowCaja.id, actual.id));
      } else {
        await tx.insert(cashflowCaja).values({ fechaInicio: dto.fechaInicio, saldoInicial: saldo, abiertaPor: usuarioId });
      }
      /* El saldo inicial es un movimiento más del libro: así la suma del libro ES el saldo. */
      await tx.update(cashflowMovimientos)
        .set({ anuladoEn: new Date(), anuladoPor: usuarioId, anuladoMotivo: 'Arranque cambiado' })
        .where(and(eq(cashflowMovimientos.origen, 'saldo_inicial'), isNull(cashflowMovimientos.anuladoEn)));
      await tx.insert(cashflowMovimientos).values({
        fecha: new Date(`${dto.fechaInicio}T12:00:00`), tipo: 'ingreso', origen: 'saldo_inicial', importe: saldo,
        detalle: 'Saldo inicial (efectivo contado al arrancar)', usuarioId,
      });
    });
    /* Recién DESPUÉS de grabar: el resumen lee por otra conexión y dentro de
     * la transacción todavía no veía la caja (respondía «sin arrancar»). */
    return this.resumen();
  }

  /* ------------------------------ Resumen ------------------------------ */

  /** Las cajas de los locales abiertas hace más de 24 h (un cierre olvidado: el sobre no llega). */
  private async cajasAbiertas() {
    const r = await this.db.execute(sql`
      select cs.id, cs.sucursal_id as "sucursalId", su.nombre as sucursal, cs.apertura, u.nombre as usuario,
        round(extract(epoch from (now() - cs.apertura)) / 3600)::int as horas
      from caja_sesiones cs join sucursales su on su.id = cs.sucursal_id left join usuarios u on u.id = cs.usuario_id
      where cs.estado = 'abierta' and cs.apertura < now() - (${HORAS_CAJA_ABIERTA} || ' hours')::interval
      order by cs.apertura`);
    return r.rows;
  }

  /** Lo que sondea el banner del ERP cada tanto: liviano a propósito (una consulta chica). */
  async alertas() {
    return { cajasAbiertas: await this.cajasAbiertas() };
  }

  async resumen() {
    const caja = await this.caja();
    const abiertas = await this.cajasAbiertas();
    if (!caja) return { caja: null, cajasAbiertas: abiertas };

    const mes = hoyAr().slice(0, 7);
    const [[saldoRow], [mesRow], pend] = await Promise.all([
      this.db.select({
        s: sql<number>`coalesce(sum(case when ${cashflowMovimientos.tipo} = 'ingreso' then ${cashflowMovimientos.importe} else -${cashflowMovimientos.importe} end), 0)`,
      }).from(cashflowMovimientos).where(isNull(cashflowMovimientos.anuladoEn)),
      this.db.select({
        ingresos: sql<number>`coalesce(sum(${cashflowMovimientos.importe}) filter (where ${cashflowMovimientos.tipo} = 'ingreso' and ${cashflowMovimientos.origen} <> 'saldo_inicial'), 0)`,
        egresos: sql<number>`coalesce(sum(${cashflowMovimientos.importe}) filter (where ${cashflowMovimientos.tipo} = 'egreso'), 0)`,
      }).from(cashflowMovimientos).where(and(
        isNull(cashflowMovimientos.anuladoEn),
        desdeDia('fecha', `${mes}-01`),
      )),
      this.db.execute(sql`
        select count(*)::int as n, coalesce(sum(cs.envio_efectivo), 0) as total
        from caja_sesiones cs
        where cs.estado = 'cerrada' and cs.envio_efectivo > 0
          and ${desdeDia('cs.cierre', caja.fechaInicio)}
          and not exists (select 1 from cashflow_sobres s where s.caja_sesion_id = cs.id and s.anulado_en is null)`),
    ]);
    const p: any = pend.rows[0] ?? {};
    return {
      caja,
      saldo: money(saldoRow?.s),
      enTransito: { sobres: Number(p.n) || 0, total: money(p.total) },
      mes: { periodo: mes, ingresos: money(mesRow?.ingresos), egresos: money(mesRow?.egresos) },
      cajasAbiertas: abiertas,
      ultimos: await this.movimientos({ limite: 8 }),
      conteos: await this.conteos(5),
    };
  }

  /* ------------------------------ Contar mi caja ------------------------------ */

  conteos(limite = 50) {
    return this.db.execute(sql`
      select c.id, c.fecha, c.billetes, c.otros, c.contado, c.esperado, c.diferencia, c.ajustado, c.motivo, u.nombre as usuario
      from cashflow_conteos c left join usuarios u on u.id = c.usuario_id
      order by c.id desc limit ${Math.min(Math.max(Number(limite) || 50, 1), 500)}`).then((r) => r.rows.map((x: any) => ({
      ...x, otros: money(x.otros), contado: money(x.contado), esperado: money(x.esperado), diferencia: money(x.diferencia),
    })));
  }

  /**
   * «CONTAR MI CAJA»: lo contado (billetes + monedas/otros) contra el saldo del
   * libro. El conteo queda siempre; si hay diferencia y se pide ajustar, el
   * ajuste es un movimiento del libro (ingreso si sobró, egreso si faltó) con
   * su motivo, para que el saldo vuelva a ser lo que hay en la mano.
   */
  async contar(dto: ConteoDto, usuarioId: number | null) {
    if (dto.confirmado !== true) throw new BadRequestException('Confirmá el conteo.');
    const billetes: Record<string, number> = {};
    let suma = 0;
    for (const [d, n] of Object.entries(dto.billetes ?? {})) {
      const den = Number(d); const cant = Number(n);
      if (!(DENOMINACIONES as readonly number[]).includes(den)) throw new BadRequestException(`No existe el billete de $${d}.`);
      if (!Number.isInteger(cant) || cant < 0 || cant > 100000) throw new BadRequestException(`La cantidad de billetes de $${den.toLocaleString('es-AR')} no es válida.`);
      if (cant > 0) { billetes[String(den)] = cant; suma += den * cant; }
    }
    const otros = money(dto.otros ?? 0);
    const contado = money(suma + otros);
    const motivo = String(dto.motivo ?? '').trim();
    return this.db.transaction(async (tx) => {
      const [caja] = await tx.select().from(cashflowCaja).limit(1).for('update');
      if (!caja) throw new BadRequestException('Primero arrancá el Cash Flow con la fecha y el saldo inicial.');
      const esperado = await this.saldo(tx);
      const diferencia = money(contado - esperado);
      const hayDif = Math.abs(diferencia) > 0.009;
      const ajustar = hayDif && dto.ajustar === true;
      if (ajustar && !motivo) throw new BadRequestException(`Contaste $${contado.toLocaleString('es-AR')} y el libro dice $${esperado.toLocaleString('es-AR')}: para ajustar, escribí el motivo de la diferencia.`);
      const [c] = await tx.insert(cashflowConteos).values({
        billetes, otros, contado, esperado, diferencia, ajustado: ajustar, motivo, usuarioId,
      }).returning();
      if (ajustar) {
        await tx.insert(cashflowMovimientos).values({
          tipo: diferencia > 0 ? 'ingreso' : 'egreso', origen: 'conteo', importe: money(Math.abs(diferencia)), conteoId: c.id, usuarioId,
          detalle: `Ajuste por conteo: contado $${contado.toLocaleString('es-AR')}, el libro decía $${esperado.toLocaleString('es-AR')} · ${motivo}`,
        });
      }
      return { ok: true, conteoId: c.id, contado, esperado, diferencia, ajustado: ajustar, saldo: await this.saldo(tx) };
    });
  }

  /* ------------------------------ Reporte ------------------------------ */

  /**
   * El período en números: saldo al inicio y al fin, ingresos/egresos por
   * concepto, los sobres por sucursal, las diferencias por cajero y la serie
   * por día / semana / mes. Todo sale del libro y de los sobres: no hay
   * tablas resumen que puedan quedar viejas.
   */
  async reporte(q: { desde?: string; hasta?: string }) {
    const caja = await this.caja();
    const hoy = hoyAr();
    const desde = esDia(q.desde) ? q.desde : `${hoy.slice(0, 7)}-01`;
    const hasta = esDia(q.hasta) ? q.hasta : hoy;
    if (hasta < desde) throw new BadRequestException('«Hasta» es anterior a «desde».');
    const dias = Math.round((Date.parse(`${hasta}T12:00:00Z`) - Date.parse(`${desde}T12:00:00Z`)) / 86_400_000) + 1;
    if (dias > 1100) throw new BadRequestException('El período puede ser de hasta 3 años.');
    const paso = dias <= 45 ? 'day' : dias <= 200 ? 'week' : 'month';
    if (!caja) return { caja: null, desde, hasta };
    const vivo = sql`m.anulado_en is null`;
    const [antes, periodo, porConcepto, serie, sobresSuc, cajeros] = await Promise.all([
      this.db.execute(sql`select coalesce(sum(case when m.tipo = 'ingreso' then m.importe else -m.importe end), 0) as s
        from cashflow_movimientos m where ${vivo} and m.fecha < ('${sql.raw(desde)}'::date::timestamp at time zone '${sql.raw(ZONA)}')`),
      this.db.execute(sql`select
          coalesce(sum(m.importe) filter (where m.tipo = 'ingreso' and m.origen <> 'saldo_inicial'), 0) as ingresos,
          coalesce(sum(m.importe) filter (where m.tipo = 'ingreso' and m.origen = 'saldo_inicial'), 0) as "saldoInicial",
          coalesce(sum(m.importe) filter (where m.tipo = 'egreso'), 0) as egresos,
          count(*) filter (where m.origen <> 'saldo_inicial')::int as movimientos
        from cashflow_movimientos m where ${vivo} and ${desdeDia('m.fecha', desde)} and ${hastaDia('m.fecha', hasta)}`),
      this.db.execute(sql`select m.tipo, m.origen, coalesce(c.nombre, '') as concepto,
          coalesce(sum(m.importe), 0) as importe, count(*)::int as cantidad
        from cashflow_movimientos m left join cashflow_conceptos c on c.id = m.concepto_id
        where ${vivo} and m.origen <> 'saldo_inicial' and ${desdeDia('m.fecha', desde)} and ${hastaDia('m.fecha', hasta)}
        group by 1, 2, 3 order by 1, 4 desc`),
      this.db.execute(sql`select to_char(date_trunc('${sql.raw(paso)}', m.fecha at time zone '${sql.raw(ZONA)}'), 'YYYY-MM-DD') as periodo,
          coalesce(sum(m.importe) filter (where m.tipo = 'ingreso' and m.origen <> 'saldo_inicial'), 0) as ingresos,
          coalesce(sum(m.importe) filter (where m.tipo = 'egreso'), 0) as egresos
        from cashflow_movimientos m
        where ${vivo} and ${desdeDia('m.fecha', desde)} and ${hastaDia('m.fecha', hasta)}
        group by 1 order by 1`),
      this.db.execute(sql`select su.id as "sucursalId", su.nombre as sucursal,
          count(*)::int as sobres, count(s.id)::int as controlados,
          coalesce(sum(cs.envio_efectivo), 0) as enviado, coalesce(sum(s.contado), 0) as contado, coalesce(sum(s.diferencia), 0) as diferencia
        from caja_sesiones cs join sucursales su on su.id = cs.sucursal_id
        left join cashflow_sobres s on s.caja_sesion_id = cs.id and s.anulado_en is null
        where cs.estado = 'cerrada' and cs.envio_efectivo > 0 and ${desdeDia('cs.cierre', caja.fechaInicio)}
          and ${desdeDia('cs.cierre', desde)} and ${hastaDia('cs.cierre', hasta)}
        group by 1, 2 order by 2`),
      this.db.execute(sql`select coalesce(uc.id, ua.id) as "usuarioId", coalesce(uc.nombre, ua.nombre, 'Sin cajero') as cajero,
          count(*)::int as sobres, count(*) filter (where abs(s.diferencia) > 0.009)::int as "conDiferencia",
          coalesce(sum(s.diferencia), 0) as diferencia,
          coalesce(sum(s.diferencia) filter (where s.diferencia < 0), 0) as faltantes,
          coalesce(sum(s.diferencia) filter (where s.diferencia > 0), 0) as sobrantes
        from cashflow_sobres s join caja_sesiones cs on cs.id = s.caja_sesion_id
        left join usuarios ua on ua.id = cs.usuario_id
        left join lateral (select cc.usuario_id from caja_controles cc where cc.caja_sesion_id = cs.id and cc.observaciones like 'Cierre por envío%' order by cc.id desc limit 1) cx on true
        left join usuarios uc on uc.id = cx.usuario_id
        where s.anulado_en is null and ${desdeDia('cs.cierre', desde)} and ${hastaDia('cs.cierre', hasta)}
        group by 1, 2 order by 5 asc`),
    ]);
    const p: any = periodo.rows[0] ?? {};
    const saldoInicio = money((antes.rows[0] as any)?.s);
    const ingresos = money(p.ingresos); const egresos = money(p.egresos); const saldoInicial = money(p.saldoInicial);
    return {
      caja, desde, hasta, paso: paso === 'day' ? 'dia' : paso === 'week' ? 'semana' : 'mes',
      saldoInicio, saldoInicial, ingresos, egresos, movimientos: Number(p.movimientos) || 0,
      saldoFin: money(saldoInicio + saldoInicial + ingresos - egresos),
      porConcepto: porConcepto.rows.map((x: any) => ({ ...x, importe: money(x.importe) })),
      serie: serie.rows.map((x: any) => ({ periodo: x.periodo, ingresos: money(x.ingresos), egresos: money(x.egresos) })),
      sobresPorSucursal: sobresSuc.rows.map((x: any) => ({ ...x, enviado: money(x.enviado), contado: money(x.contado), diferencia: money(x.diferencia) })),
      porCajero: cajeros.rows.map((x: any) => ({ ...x, diferencia: money(x.diferencia), faltantes: money(x.faltantes), sobrantes: money(x.sobrantes) })),
    };
  }

  /* ------------------------------ Sobres ------------------------------ */

  /**
   * Los sobres desde el arranque: pendientes (sin control vigente) o
   * controlados. El cajero es quien CERRÓ (firma el control de cierre); si no
   * hay, quien abrió. «Pagos del local» son los egresos en efectivo de ese
   * turno (pagos a proveedor, gastos, retiros): informativos, no restan de la
   * caja central porque esa plata nunca llegó al sobre.
   */
  async sobres(q: { estado?: string; desde?: string; hasta?: string; sucursalId?: string; cajaSesionId?: number }) {
    const caja = await this.caja();
    if (!caja) return [];
    const estado = q.estado === 'controlados' ? 'controlados' : 'pendientes';
    const cond: any[] = [
      sql`cs.estado = 'cerrada' and cs.envio_efectivo > 0`,
      desdeDia('cs.cierre', caja.fechaInicio),
      estado === 'controlados' ? sql`s.id is not null` : sql`s.id is null`,
    ];
    if (esDia(q.desde)) cond.push(desdeDia('cs.cierre', q.desde));
    if (esDia(q.hasta)) cond.push(hastaDia('cs.cierre', q.hasta));
    const suc = Number(q.sucursalId);
    if (Number.isInteger(suc) && suc > 0) cond.push(sql`cs.sucursal_id = ${suc}`);
    if (q.cajaSesionId) cond.push(sql`cs.id = ${q.cajaSesionId}`);
    const r = await this.db.execute(sql`
      select cs.id as "cajaSesionId", cs.sucursal_id as "sucursalId", su.nombre as sucursal, cs.cierre, cs.apertura,
        cs.envio_efectivo as enviado, cs.billetes_envio as "billetesEnvio", cs.fondo_queda as "fondoQueda",
        cs.declarado_efectivo as "contadoCajero", cs.sistema_efectivo as "esperadoCajero", cs.diferencia as "diferenciaCajero",
        coalesce(uc.nombre, ua.nombre, '') as cajero,
        s.id as "sobreId", s.contado, s.diferencia, s.motivo, s.controlado_en as "controladoEn", up.nombre as "controladoPor",
        coalesce(pl.total, 0) as "pagosLocal", coalesce(pl.detalle, '[]'::json) as "pagosLocalDetalle"
      from caja_sesiones cs
      join sucursales su on su.id = cs.sucursal_id
      left join usuarios ua on ua.id = cs.usuario_id
      left join lateral (
        select cc.usuario_id from caja_controles cc
        where cc.caja_sesion_id = cs.id and cc.observaciones like 'Cierre por envío%' order by cc.id desc limit 1
      ) cx on true
      left join usuarios uc on uc.id = cx.usuario_id
      left join cashflow_sobres s on s.caja_sesion_id = cs.id and s.anulado_en is null
      left join usuarios up on up.id = s.controlado_por
      left join lateral (
        select sum(cm.importe) as total,
          json_agg(json_build_object('motivo', cm.motivo, 'importe', cm.importe) order by cm.id) as detalle
        from caja_movimientos cm where cm.caja_sesion_id = cs.id and cm.tipo = 'egreso'
      ) pl on true
      where ${sql.join(cond, sql` and `)}
      order by cs.cierre desc
      limit 300`);
    return r.rows.map((x: any) => ({
      ...x,
      enviado: money(x.enviado), contado: x.contado == null ? null : money(x.contado),
      diferencia: x.diferencia == null ? null : money(x.diferencia), pagosLocal: money(x.pagosLocal),
    }));
  }

  async controlar(cajaSesionId: number, dto: ControlarSobreDto, usuarioId: number | null) {
    if (dto.confirmado !== true) throw new BadRequestException('Confirmá el control del sobre.');
    const contado = money(dto.contado);
    const motivo = String(dto.motivo ?? '').trim();
    try {
      return await this.db.transaction(async (tx) => {
        const caja = await this.caja(tx);
        if (!caja) throw new BadRequestException('Primero arrancá el Cash Flow con la fecha y el saldo inicial.');
        const [cs] = await tx.select({
          id: cajaSesiones.id, estado: cajaSesiones.estado, cierre: cajaSesiones.cierre, envio: cajaSesiones.envioEfectivo,
          sucursalId: cajaSesiones.sucursalId,
        }).from(cajaSesiones).where(eq(cajaSesiones.id, cajaSesionId)).limit(1).for('update');
        if (!cs) throw new NotFoundException('Ese turno de caja no existe.');
        if (cs.estado !== 'cerrada' || cs.envio == null || !cs.cierre) throw new BadRequestException('Ese turno no tiene un sobre: no se cerró por envío.');
        if (money(cs.envio) <= 0) throw new BadRequestException('Ese cierre no envió efectivo: no hay sobre que controlar.');
        if (diaAr(cs.cierre) < caja.fechaInicio) throw new BadRequestException(`Ese sobre es anterior al arranque del Cash Flow (${caja.fechaInicio}).`);
        const [ya] = await tx.select({ id: cashflowSobres.id }).from(cashflowSobres)
          .where(and(eq(cashflowSobres.cajaSesionId, cajaSesionId), isNull(cashflowSobres.anuladoEn))).limit(1);
        if (ya) throw new ConflictException('Ese sobre ya está controlado. Si hay que corregirlo, deshacé el control con su motivo.');
        const enviado = money(cs.envio);
        const diferencia = money(contado - enviado);
        if (Math.abs(diferencia) > 0.009 && !motivo) {
          throw new BadRequestException(`Contaste ${contado.toLocaleString('es-AR')} y el sobre dice ${enviado.toLocaleString('es-AR')}: escribí el motivo de la diferencia.`);
        }
        const [su] = await tx.select({ nombre: sucursales.nombre }).from(sucursales).where(eq(sucursales.id, cs.sucursalId)).limit(1);
        const [s] = await tx.insert(cashflowSobres).values({
          cajaSesionId, enviado, contado, diferencia, motivo, controladoPor: usuarioId,
        }).returning();
        await tx.insert(cashflowMovimientos).values({
          tipo: 'ingreso', origen: 'sobre', importe: contado, sobreId: s.id, usuarioId,
          detalle: `Sobre ${su?.nombre ?? ''} · cierre ${diaAr(cs.cierre)}`,
        });
        return { ok: true, sobreId: s.id, enviado, contado, diferencia, saldo: await this.saldo(tx) };
      });
    } catch (e) {
      if (esUnico(e)) throw new ConflictException('Ese sobre ya está controlado.');
      throw e;
    }
  }

  async anularSobre(id: number, dto: AnularDto, usuarioId: number | null) {
    const motivo = String(dto.motivo ?? '').trim();
    if (!motivo) throw new BadRequestException('Escribí por qué se deshace el control.');
    return this.db.transaction(async (tx) => {
      const [s] = await tx.select().from(cashflowSobres).where(eq(cashflowSobres.id, id)).limit(1).for('update');
      if (!s) throw new NotFoundException('Ese control no existe.');
      if (s.anuladoEn) throw new BadRequestException('Ese control ya estaba deshecho.');
      const ahora = new Date();
      await tx.update(cashflowSobres).set({ anuladoEn: ahora, anuladoPor: usuarioId, anuladoMotivo: motivo }).where(eq(cashflowSobres.id, id));
      await tx.update(cashflowMovimientos).set({ anuladoEn: ahora, anuladoPor: usuarioId, anuladoMotivo: `Control del sobre deshecho: ${motivo}` })
        .where(and(eq(cashflowMovimientos.sobreId, id), isNull(cashflowMovimientos.anuladoEn)));
      return { ok: true, saldo: await this.saldo(tx) };
    });
  }

  /* ------------------------------ Conceptos ------------------------------ */

  conceptos() {
    return this.db.select({
      id: cashflowConceptos.id, nombre: cashflowConceptos.nombre, tipo: cashflowConceptos.tipo, clase: cashflowConceptos.clase,
      gastoCategoriaId: cashflowConceptos.gastoCategoriaId, activo: cashflowConceptos.activo, orden: cashflowConceptos.orden,
      gastoCategoria: gastoCategorias.nombre,
      usos: sql<number>`(select count(*)::int from cashflow_movimientos m where m.concepto_id = ${cashflowConceptos.id})`,
    }).from(cashflowConceptos)
      .leftJoin(gastoCategorias, eq(gastoCategorias.id, cashflowConceptos.gastoCategoriaId))
      .orderBy(asc(cashflowConceptos.tipo), asc(cashflowConceptos.orden), asc(cashflowConceptos.nombre));
  }

  private async validarConcepto(dto: ConceptoDto, actual?: any) {
    const nombre = String(dto.nombre ?? actual?.nombre ?? '').trim().replace(/\s+/g, ' ');
    if (!nombre) throw new BadRequestException('El concepto necesita un nombre.');
    const tipo = dto.tipo ?? actual?.tipo;
    if (!TIPOS.includes(tipo)) throw new BadRequestException('El tipo es ingreso o egreso.');
    const clase = dto.clase ?? actual?.clase ?? 'movimiento';
    if (clase === 'gasto' && tipo !== 'egreso') throw new BadRequestException('Un concepto de gasto es siempre un egreso.');
    let gastoCategoriaId: number | null = dto.gastoCategoriaId === undefined ? (actual?.gastoCategoriaId ?? null) : dto.gastoCategoriaId;
    if (clase !== 'gasto') gastoCategoriaId = null;
    if (gastoCategoriaId != null) {
      const [cat] = await this.db.select({ id: gastoCategorias.id }).from(gastoCategorias).where(eq(gastoCategorias.id, gastoCategoriaId)).limit(1);
      if (!cat) throw new BadRequestException('Esa categoría de gasto no existe.');
    }
    return { nombre, tipo, clase, gastoCategoriaId, activo: dto.activo ?? actual?.activo ?? true, orden: dto.orden ?? actual?.orden ?? 0 };
  }

  async crearConcepto(dto: ConceptoDto) {
    const v = await this.validarConcepto(dto);
    try {
      const [c] = await this.db.insert(cashflowConceptos).values(v).returning();
      return c;
    } catch (e) {
      if (esUnico(e)) throw new ConflictException(`Ya hay un concepto llamado «${v.nombre}».`);
      throw e;
    }
  }

  async editarConcepto(id: number, dto: ConceptoDto) {
    const [actual] = await this.db.select().from(cashflowConceptos).where(eq(cashflowConceptos.id, id)).limit(1);
    if (!actual) throw new NotFoundException('Ese concepto no existe.');
    const v = await this.validarConcepto(dto, actual);
    /* Con movimientos registrados el tipo no cambia: un egreso no se vuelve ingreso por detrás. */
    if (v.tipo !== actual.tipo || v.clase !== actual.clase) {
      const [n] = await this.db.select({ n: sql<number>`count(*)::int` }).from(cashflowMovimientos).where(eq(cashflowMovimientos.conceptoId, id));
      if (Number(n?.n) > 0) throw new BadRequestException('Ese concepto ya tiene movimientos: no se le cambia el tipo ni la clase. Desactivalo y creá otro.');
    }
    try {
      const [c] = await this.db.update(cashflowConceptos).set(v).where(eq(cashflowConceptos.id, id)).returning();
      return c;
    } catch (e) {
      if (esUnico(e)) throw new ConflictException(`Ya hay un concepto llamado «${v.nombre}».`);
      throw e;
    }
  }

  /* ------------------------------ Movimientos ------------------------------ */

  async movimientos(q: { desde?: string; hasta?: string; tipo?: string; origen?: string; conceptoId?: string | number; anulados?: string; limite?: number }) {
    const cond: any[] = [];
    if (q.anulados !== '1') cond.push(sql`m.anulado_en is null`);
    if (esDia(q.desde)) cond.push(desdeDia('m.fecha', q.desde));
    if (esDia(q.hasta)) cond.push(hastaDia('m.fecha', q.hasta));
    if (q.tipo && (TIPOS as readonly string[]).includes(q.tipo)) cond.push(sql`m.tipo = ${q.tipo}`);
    if (q.origen) cond.push(sql`m.origen = ${String(q.origen)}`);
    const cid = Number(q.conceptoId);
    if (Number.isInteger(cid) && cid > 0) cond.push(sql`m.concepto_id = ${cid}`);
    const limite = Math.min(Math.max(Number(q.limite) || 500, 1), 2000);
    const r = await this.db.execute(sql`
      select m.id, m.fecha, m.tipo, m.origen, m.importe, m.detalle, m.concepto_id as "conceptoId", c.nombre as concepto,
        m.sobre_id as "sobreId", s.caja_sesion_id as "cajaSesionId", su.nombre as sucursal, s.diferencia as "sobreDiferencia",
        m.pago_id as "pagoId", m.gasto_id as "gastoId", u.nombre as usuario,
        pr.nombre as proveedor, pp.medio, pp.referencia, pp.aplicado as "pagoAplicado", g.descripcion as "gastoDescripcion", gc.nombre as "gastoCategoria",
        m.anulado_en as "anuladoEn", m.anulado_motivo as "anuladoMotivo", ua.nombre as "anuladoPor"
      from cashflow_movimientos m
      left join cashflow_conceptos c on c.id = m.concepto_id
      left join proveedor_pagos pp on pp.id = m.pago_id
      left join proveedores pr on pr.id = pp.proveedor_id
      left join gastos g on g.id = m.gasto_id
      left join gasto_categorias gc on gc.id = g.categoria_id
      left join cashflow_sobres s on s.id = m.sobre_id
      left join caja_sesiones cs on cs.id = s.caja_sesion_id
      left join sucursales su on su.id = cs.sucursal_id
      left join usuarios u on u.id = m.usuario_id
      left join usuarios ua on ua.id = m.anulado_por
      ${cond.length ? sql`where ${sql.join(cond, sql` and `)}` : sql``}
      order by m.fecha desc, m.id desc
      limit ${limite}`);
    return r.rows.map((x: any) => ({ ...x, importe: money(x.importe), sobreDiferencia: x.sobreDiferencia == null ? null : money(x.sobreDiferencia) }));
  }

  async crearMovimiento(dto: MovimientoDto, sesion: Sesion) {
    const usuarioId = sesion?.usuarioId ?? null;
    if (dto.confirmado !== true) throw new BadRequestException('Confirmá el movimiento.');
    const importe = money(dto.importe);
    if (importe <= 0) throw new BadRequestException('El importe tiene que ser mayor a cero.');
    const fecha = dto.fecha ?? hoyAr();
    if (!esDia(fecha)) throw new BadRequestException('La fecha tiene que ser un día válido.');
    if (fecha > hoyAr()) throw new BadRequestException('La fecha no puede ser futura.');
    const detalle = String(dto.detalle ?? '').trim();
    return this.db.transaction(async (tx) => {
      /* El candado es la fila de la caja: dos egresos a la vez no pueden pasar
       * los dos el control del saldo. */
      const [caja] = await tx.select().from(cashflowCaja).limit(1).for('update');
      if (!caja) throw new BadRequestException('Primero arrancá el Cash Flow con la fecha y el saldo inicial.');
      if (fecha < caja.fechaInicio) throw new BadRequestException(`La fecha es anterior al arranque del Cash Flow (${caja.fechaInicio}).`);
      const [c] = await tx.select().from(cashflowConceptos).where(eq(cashflowConceptos.id, dto.conceptoId)).limit(1);
      if (!c) throw new NotFoundException('Ese concepto no existe.');
      if (!c.activo) throw new BadRequestException('Ese concepto está desactivado.');
      if (c.tipo !== dto.tipo) throw new BadRequestException(`«${c.nombre}» es un concepto de ${c.tipo}.`);
      const esGasto = c.clase === 'gasto';
      if (esGasto && !c.gastoCategoriaId) throw new BadRequestException(`«${c.nombre}» es un concepto de gasto pero no tiene rubro: asignale uno en la pestaña Conceptos.`);
      if (dto.tipo === 'egreso') {
        const saldo = await this.saldo(tx);
        if (importe > saldo + 0.009) {
          throw new BadRequestException(`No hay tanto efectivo en mano: el saldo es $${saldo.toLocaleString('es-AR')} y querés sacar $${importe.toLocaleString('es-AR')}. Lo que está en sobres sin controlar no cuenta hasta que lo controles.`);
        }
      }
      const esHoy = fecha === hoyAr();
      const [m] = await tx.insert(cashflowMovimientos).values({
        fecha: esHoy ? new Date() : new Date(`${fecha}T12:00:00`),
        tipo: dto.tipo, origen: esGasto ? 'gasto' : 'concepto', importe, conceptoId: c.id, detalle, usuarioId,
      }).returning();
      /*
       * EL CONCEPTO DE GASTO CREA EL GASTO EN GASTOS (decisión del dueño): sin
       * factura (recibo, letra X, sin IVA), con su rubro, pagado en el acto en
       * efectivo. Así aparece en rentabilidad y no se carga dos veces. Si el
       * alta del gasto falla, esta transacción se deshace y el egreso no queda.
       */
      if (esGasto) {
        const g: any = await this.gastos.crear({
          fecha, tipoDoc: 'recibo', letra: 'X', categoriaId: c.gastoCategoriaId!, descripcion: detalle || c.nombre,
          condicionPago: 'contado', neto: importe, iva: 0, observaciones: 'Registrado desde Cash Flow (efectivo del dueño)',
          usuarioId: usuarioId ?? undefined, pagoInmediato: { importe, medio: 'efectivo', fecha },
        } as any, sesion);
        const [imp] = await tx.select({ pagoId: proveedorImputaciones.pagoId }).from(proveedorImputaciones)
          .where(eq(proveedorImputaciones.gastoId, g.id)).limit(1);
        await tx.update(cashflowMovimientos).set({ gastoId: g.id, pagoId: imp?.pagoId ?? null }).where(eq(cashflowMovimientos.id, m.id));
      }
      return { ok: true, id: m.id, saldo: await this.saldo(tx) };
    });
  }

  /* ------------------------------ Pago a proveedor ------------------------------ */

  /** Los proveedores (no hay baja lógica en la tabla), para elegir a quién se le paga. */
  proveedoresActivos() {
    return this.db.select({ id: proveedores.id, nombre: proveedores.nombre, proveeMercaderia: proveedores.proveeMercaderia, proveeGastos: proveedores.proveeGastos })
      .from(proveedores).orderBy(asc(proveedores.nombre));
  }

  /** Las facturas (o los gastos cargados) de ese proveedor que todavía deben plata: lo que se tilda al pagar. */
  pendientesDe(proveedorId: number, destino?: string) {
    return this.pagos.documentosPendientes(proveedorId, destino === 'gastos' ? 'gastos' : 'mercaderia');
  }

  gastoCategorias() {
    return this.db.select({ id: gastoCategorias.id, nombre: gastoCategorias.nombre, tipo: gastoCategorias.tipo })
      .from(gastoCategorias).where(eq(gastoCategorias.activa, true)).orderBy(asc(gastoCategorias.orden), asc(gastoCategorias.nombre));
  }

  /**
   * EL PAGO A PROVEEDOR SALE DE LA CAJA CENTRAL. Es el MISMO pago de siempre
   * (`pagos.crear`: queda en la cuenta del proveedor, aplicado a las facturas
   * tildadas, con su medio efectivo o depósito), más el egreso en el libro.
   * No lleva turno de caja: la plata sale de la mano del dueño, no del cajón
   * de un local. Un depósito también resta: es efectivo que se lleva al banco.
   */
  async pagarProveedor(dto: PagoProveedorDto, sesion: Sesion) {
    if (dto.confirmado !== true) throw new BadRequestException('Confirmá el pago.');
    const importe = money(dto.importe);
    if (importe <= 0) throw new BadRequestException('El importe tiene que ser mayor a cero.');
    const fecha = dto.fecha ?? hoyAr();
    if (!esDia(fecha)) throw new BadRequestException('La fecha tiene que ser un día válido.');
    if (fecha > hoyAr()) throw new BadRequestException('La fecha no puede ser futura.');
    const imputaciones = (dto.imputaciones ?? []).map((i) => ({
      comprobanteId: dto.destino === 'mercaderia' ? i.comprobanteId : undefined,
      gastoId: dto.destino === 'gastos' ? i.gastoId : undefined,
      importe: money(i.importe),
    })).filter((i) => (i.comprobanteId || i.gastoId) && i.importe > 0);
    const aplicado = money(imputaciones.reduce((a, i) => a + i.importe, 0));
    if (aplicado > importe + 0.009) throw new BadRequestException(`Lo aplicado a documentos (${aplicado.toLocaleString('es-AR')}) supera el importe del pago (${importe.toLocaleString('es-AR')}).`);
    const [prov] = await this.db.select({ id: proveedores.id, nombre: proveedores.nombre }).from(proveedores).where(eq(proveedores.id, dto.proveedorId)).limit(1);
    if (!prov) throw new NotFoundException('Ese proveedor no existe.');
    const usuarioId = sesion?.usuarioId ?? null;
    const detalle = String(dto.detalle ?? '').trim();
    return this.db.transaction(async (tx) => {
      const [caja] = await tx.select().from(cashflowCaja).limit(1).for('update');
      if (!caja) throw new BadRequestException('Primero arrancá el Cash Flow con la fecha y el saldo inicial.');
      if (fecha < caja.fechaInicio) throw new BadRequestException(`La fecha es anterior al arranque del Cash Flow (${caja.fechaInicio}).`);
      const saldo = await this.saldo(tx);
      if (importe > saldo + 0.009) {
        throw new BadRequestException(`No hay tanto efectivo en mano: el saldo es $${saldo.toLocaleString('es-AR')} y el pago es de $${importe.toLocaleString('es-AR')}.`);
      }
      const esHoy = fecha === hoyAr();
      const [m] = await tx.insert(cashflowMovimientos).values({
        fecha: esHoy ? new Date() : new Date(`${fecha}T12:00:00`),
        tipo: 'egreso', origen: 'pago_proveedor', importe, usuarioId,
        detalle: `Pago a ${prov.nombre} (${dto.medio === 'deposito' ? 'depósito' : 'efectivo'})${detalle ? ` · ${detalle}` : ''}`,
      }).returning();
      /* El pago de siempre. Si falla, esta transacción se deshace y el egreso no queda. */
      const pago: any = await this.pagos.crear({
        proveedorId: prov.id, destino: dto.destino, importe, medio: dto.medio, fecha,
        referencia: String(dto.referencia ?? '').trim() || undefined,
        concepto: `Cash Flow${detalle ? `: ${detalle}` : ''}`,
        usuarioId: usuarioId ?? undefined,
        imputaciones: imputaciones.length ? imputaciones : undefined,
      } as any, sesion.sucursalId, true);
      await tx.update(cashflowMovimientos).set({ pagoId: pago.id }).where(eq(cashflowMovimientos.id, m.id));
      return { ok: true, id: m.id, pagoId: pago.id, saldo: await this.saldo(tx) };
    });
  }

  /** Deshace un pago de proveedor: desaplica sus imputaciones y lo anula (el camino de siempre, en orden). */
  private async anularPago(pagoId: number, motivo: string) {
    const imps = await this.db.select({ id: proveedorImputaciones.id }).from(proveedorImputaciones).where(eq(proveedorImputaciones.pagoId, pagoId));
    for (const i of imps) await this.pagos.desimputar(i.id);
    /* Un pago SIN proveedor (el de un gasto suelto) no puede quedar a cuenta
     * de nadie: desaplicarlo ya lo anula. Solo se anula acá si sigue vivo. */
    const [p] = await this.db.select({ estado: proveedorPagos.estado }).from(proveedorPagos).where(eq(proveedorPagos.id, pagoId)).limit(1);
    if (p && p.estado !== 'anulado') await this.pagos.anular(pagoId, `Cash Flow: ${motivo}`);
  }

  async anularMovimiento(id: number, dto: AnularDto, usuarioId: number | null) {
    const motivo = String(dto.motivo ?? '').trim();
    if (!motivo) throw new BadRequestException('Escribí por qué se anula.');
    return this.db.transaction(async (tx) => {
      const [m] = await tx.select().from(cashflowMovimientos).where(eq(cashflowMovimientos.id, id)).limit(1).for('update');
      if (!m) throw new NotFoundException('Ese movimiento no existe.');
      if (m.anuladoEn) throw new BadRequestException('Ese movimiento ya estaba anulado.');
      /* Cada origen se anula por su camino: el sobre desde su control, el
       * saldo inicial desde el arranque. El pago a proveedor y el gasto se
       * deshacen PRIMERO por su circuito (desaplicar + anular el pago, anular
       * el gasto); si eso falla, el egreso sigue vigente y el saldo no miente. */
      if (!['concepto', 'pago_proveedor', 'gasto', 'conteo'].includes(m.origen)) throw new BadRequestException('Ese movimiento no se anula desde acá: es el saldo inicial o un sobre.');
      if (m.origen === 'pago_proveedor' && m.pagoId) await this.anularPago(m.pagoId, motivo);
      if (m.origen === 'gasto') {
        if (m.pagoId) await this.anularPago(m.pagoId, motivo);
        if (m.gastoId) await this.gastos.anular(m.gastoId, `Cash Flow: ${motivo}`);
      }
      await tx.update(cashflowMovimientos).set({ anuladoEn: new Date(), anuladoPor: usuarioId, anuladoMotivo: motivo }).where(eq(cashflowMovimientos.id, id));
      return { ok: true, saldo: await this.saldo(tx) };
    });
  }
}

@Controller('cashflow')
@Permiso(PERMISO_CASHFLOW)
export class CashflowController {
  constructor(private readonly svc: CashflowService) {}

  @Get('resumen') resumen() { return this.svc.resumen(); }
  @Get('alertas') alertas() { return this.svc.alertas(); }
  @Get('reporte') reporte(@Query() q: any) { return this.svc.reporte(q ?? {}); }
  @Get('conteos') conteos(@Query('limite') limite?: string) { return this.svc.conteos(Number(limite) || 50); }
  @Post('conteos') contar(@Body() dto: ConteoDto, @Auth() s: Sesion) { return this.svc.contar(dto, s?.usuarioId ?? null); }
  @Put('inicio') inicio(@Body() dto: InicioDto, @Auth() s: Sesion) { return this.svc.inicio(dto, s?.usuarioId ?? null); }

  @Get('sobres') sobres(@Query() q: any) { return this.svc.sobres(q ?? {}); }
  @Post('sobres/:cajaSesionId/controlar')
  controlar(@Param('cajaSesionId', ParseIntPipe) id: number, @Body() dto: ControlarSobreDto, @Auth() s: Sesion) {
    return this.svc.controlar(id, dto, s?.usuarioId ?? null);
  }
  @Post('sobres/:id/anular')
  anularSobre(@Param('id', ParseIntPipe) id: number, @Body() dto: AnularDto, @Auth() s: Sesion) {
    return this.svc.anularSobre(id, dto, s?.usuarioId ?? null);
  }

  @Get('conceptos') conceptos() { return this.svc.conceptos(); }
  @Post('conceptos') crearConcepto(@Body() dto: ConceptoDto) { return this.svc.crearConcepto(dto); }
  @Patch('conceptos/:id') editarConcepto(@Param('id', ParseIntPipe) id: number, @Body() dto: ConceptoDto) { return this.svc.editarConcepto(id, dto); }

  @Get('movimientos') movimientos(@Query() q: any) { return this.svc.movimientos(q ?? {}); }
  @Post('movimientos') crearMovimiento(@Body() dto: MovimientoDto, @Auth() s: Sesion) { return this.svc.crearMovimiento(dto, s); }

  @Get('proveedores') proveedores() { return this.svc.proveedoresActivos(); }
  @Get('proveedores/:id/pendientes') pendientes(@Param('id', ParseIntPipe) id: number, @Query('destino') destino?: string) { return this.svc.pendientesDe(id, destino); }
  @Get('gasto-categorias') gastoCategorias() { return this.svc.gastoCategorias(); }
  @Post('pagos') pagar(@Body() dto: PagoProveedorDto, @Auth() s: Sesion) { return this.svc.pagarProveedor(dto, s); }
  @Post('movimientos/:id/anular')
  anularMovimiento(@Param('id', ParseIntPipe) id: number, @Body() dto: AnularDto, @Auth() s: Sesion) {
    return this.svc.anularMovimiento(id, dto, s?.usuarioId ?? null);
  }
}

@Module({
  imports: [PagosModule, GastosModule],
  controllers: [CashflowController],
  providers: [CashflowService],
  exports: [CashflowService],
})
export class CashflowModule {}
