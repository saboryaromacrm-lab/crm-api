/**
 * CAJA — turnos del punto de venta
 * ============================================================================
 * Se modela ANTES que el ticket a propósito: un POS sin turno de caja no se
 * puede arquear, y arreglar eso después obliga a migrar datos.
 *
 * Invariantes:
 *  - Una sola sesión `abierta` por sucursal. Abrir con otra abierta es error.
 *  - El turno no se borra ni se reabre: se cierra con su arqueo y queda como
 *    registro. La diferencia (contado − sistema) se guarda tal cual, incluso
 *    negativa: ocultarla haría inútil el control.
 *  - Al cerrar se cuenta el EFECTIVO. Los demás medios se concilian por reporte
 *    contra el resumen del banco/posnet, así que se guardan como foto.
 */
import {
  Body, ConflictException, Controller, ForbiddenException, Get, Inject, Injectable, Module, BadRequestException,
  NotFoundException, Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { Auth, Permiso, Sesion } from '../auth/auth.decoradores';
import { esJefe, soloSuSucursal, sucursalDeOperacion, tienePermiso } from '../auth/auth.guard';
import { MarcaDto, PERMISO_CASHFLOW, marcarCaja } from '../cashflow/a-controlar';
import { resolverOperador } from '../usuarios/usuarios.module';
import { AuditoriaModule, AuditoriaService } from '../auditoria/auditoria.module';
import {
  cajaControles, cajaMovimientos, cajaSesiones, cobranzaPagos, cobranzas, mpCobros, sucursales, ventaPagos, ventas,
} from '../db/schema';

export const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

class AbrirCajaDto {
  /*
   * PISTA, no orden: para el cajero la sucursal sale de su sesión (ver
   * `sucursalDeOperacion`). Sigue en el DTO porque el jefe abre la caja de
   * cualquier sucursal, que es justamente lo que un cajero no puede hacer.
   */
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsInt() usuarioId?: number;
  /* El fondo con que arranca. Con FONDO FIJO en la sucursal (0111), el que no
   * es jefe no lo escribe: confirma que está (`fondoCompleto`) o lo cuenta
   * billete por billete (`billetes`). Ver `abrir`. */
  @IsOptional() @IsNumber() montoInicial?: number;
  @IsOptional() @IsBoolean() fondoCompleto?: boolean;
  @IsOptional() @IsObject() billetes?: Record<string, number>;
  @IsOptional() @IsString() observaciones?: string;
}

/** El cierre del cajero (0111): el cajón contado billete por billete, confirmado dos veces. */
class EnviarCierreDto {
  @IsObject() billetes!: Record<string, number>;
  /**
   * Los billetes que van en el SOBRE (0130). Salen de los contados; lo que
   * queda en la caja es la resta. Sin esto (una pantalla vieja), el servidor
   * separa solo con `proponerSeparacion`.
   */
  @IsOptional() @IsObject() billetesEnvio?: Record<string, number>;
  /** La segunda confirmación de la pantalla, también exigida acá. */
  @IsBoolean() confirmado!: boolean;
  @IsOptional() @IsInt() usuarioId?: number;
  @IsOptional() @IsInt() operadorId?: number;
  /** El tilde «Mandar a Cajas a controlar» (0145): solo el dueño, en la misma transacción del cierre. */
  @IsOptional() @ValidateNested() @Type(() => MarcaDto) aControlar?: MarcaDto;
}

/**
 * LOS BILLETES QUE SE CUENTAN (0111), los mismos que el contador de la caja.
 * De $10 para abajo no circula nada en el cajón (decisión del dueño).
 */
export const DENOMINACIONES = [20000, 10000, 2000, 1000, 500, 200, 100, 50, 20] as const;

/**
 * El total de un conteo por billete, validado: solo denominaciones que
 * existen, cantidades enteras y no negativas. Es lo que hace que el monto NO se
 * pueda tipear: el servidor recibe billetes y suma él.
 */
export function totalDeBilletes(billetes: Record<string, unknown> | null | undefined) {
  const limpio: Record<string, number> = {};
  let total = 0;
  for (const [k, v] of Object.entries(billetes ?? {})) {
    const d = Number(k);
    if (!(DENOMINACIONES as readonly number[]).includes(d)) {
      throw new BadRequestException(`No existe el billete de $${k}: se cuentan ${DENOMINACIONES.map((x) => `$${x.toLocaleString('es-AR')}`).join(', ')}.`);
    }
    const n = Number(v ?? 0);
    if (!Number.isInteger(n) || n < 0 || n > 100000) {
      throw new BadRequestException(`La cantidad de billetes de $${d.toLocaleString('es-AR')} tiene que ser un número entero (llegó ${String(v)}).`);
    }
    if (n > 0) { limpio[String(d)] = n; total += d * n; }
  }
  return { billetes: limpio, total };
}

/**
 * QUÉ BILLETES QUEDAN EN LA CAJA Y CUÁLES VAN AL SOBRE (0130, pedido del dueño).
 *
 * De lo contado, se apartan billetes que sumen EXACTO lo que tiene que quedar
 * (el fondo); si con esos billetes no se puede exacto, lo más cerca POR ARRIBA
 * (queda un poco más, nunca menos). Entre las formas de llegar, la que deja
 * los billetes MÁS CHICOS en la caja: son los del cambio del turno siguiente.
 * El resto va al sobre. Contó menos que el fondo: queda todo, sobre vacío.
 *
 * Cuenta en unidades de $10 (todos los billetes son múltiplos). Es la misma
 * regla que la pantalla (`separarEnvio` del POS), duplicada porque son
 * proyectos separados.
 */
export function proponerSeparacion(billetes: Record<string, number>, objetivoQueda: number) {
  const den = [...DENOMINACIONES].sort((a, b) => b - a);
  const cant = den.map((d) => Math.max(0, Math.floor(Number(billetes[String(d)]) || 0)));
  const total = den.reduce((a, d, i) => a + d * cant[i], 0);
  const objetivo = Math.max(0, Math.min(total, objetivoQueda));
  const todos = () => ({ queda: { ...soloPositivos(den, cant) }, envio: {} as Record<string, number> });
  if (objetivo >= total - 0.009) return todos();
  const U = 10;
  const meta = Math.ceil(objetivo / U - 1e-9);
  const tope = Math.min(Math.round(total / U), meta + 2000);
  /* alcanza[i][v]: se puede armar v con los billetes de i en adelante (los más chicos). */
  const alcanza: Uint8Array[] = new Array(den.length + 1);
  alcanza[den.length] = new Uint8Array(tope + 1); alcanza[den.length][0] = 1;
  for (let i = den.length - 1; i >= 0; i--) {
    const paso = den[i] / U; const c = cant[i]; const prev = alcanza[i + 1]; const cur = new Uint8Array(tope + 1);
    for (let r = 0; r < paso; r++) {
      let ultimo = -Infinity; // la última posición (en pasos) donde `prev` era verdadero
      for (let k = 0, v = r; v <= tope; k++, v += paso) {
        if (prev[v]) ultimo = k;
        if (k - ultimo <= c) cur[v] = 1;
      }
    }
    alcanza[i] = cur;
  }
  let v = -1;
  for (let x = meta; x <= tope; x++) if (alcanza[0][x]) { v = x; break; }
  if (v < 0) return todos();
  const quedaCant = den.map(() => 0);
  for (let i = 0; i < den.length; i++) {
    const paso = den[i] / U;
    for (let k = 0; k <= cant[i]; k++) {
      if (v - k * paso < 0) break;
      if (alcanza[i + 1][v - k * paso]) { quedaCant[i] = k; v -= k * paso; break; }
    }
  }
  return { queda: soloPositivos(den, quedaCant), envio: soloPositivos(den, cant.map((c, i) => c - quedaCant[i])) };
}
const soloPositivos = (den: number[], cant: number[]) => {
  const o: Record<string, number> = {};
  den.forEach((d, i) => { if (cant[i] > 0) o[String(d)] = cant[i]; });
  return o;
};

/**
 * EL TURNO SIN LOS NÚMEROS DEL SISTEMA, para el que no es jefe (0111).
 * "En ningún momento ven el efectivo que tienen que tener": ni con el turno
 * abierto ni después, en el historial. Se van el esperado, la diferencia y el
 * efectivo de los totales guardados (con ese y el fondo se reconstruye el
 * esperado). Queda lo que él mismo contó, envió y dejó de fondo.
 */
export function sesionCiega<T extends Record<string, any> | null | undefined>(s: T): T {
  if (!s) return s;
  const totales = (s as any).totales ?? {};
  const { efectivo: _e, ...otros } = (totales.medios ?? {}) as Record<string, unknown>;
  return {
    ...s,
    sistemaEfectivo: null,
    diferencia: null,
    totales: { ...totales, medios: otros },
    ciego: true,
  } as T;
}

class CerrarCajaDto {
  @IsNumber() declaradoEfectivo!: number;
  @IsOptional() @IsString() observaciones?: string;
}

class ControlCajaDto {
  @IsNumber() contadoEfectivo!: number;
  @IsOptional() @IsString() observaciones?: string;
  @IsOptional() @IsInt() usuarioId?: number;
  /** El relevo de caja (0088): quién está en la registradora. El interceptor
   *  no lo toca (significa OTRO usuario) y el servidor valida la marca. */
  @IsOptional() @IsInt() operadorId?: number;
}

class ExplicarControlDto {
  @IsString() observaciones!: string;
}

class MovimientoCajaDto {
  @IsIn(['ingreso', 'egreso']) tipo!: 'ingreso' | 'egreso';
  @IsNumber() importe!: number;
  @IsOptional() @IsString() motivo?: string;
  @IsOptional() @IsInt() usuarioId?: number;
  /** Ídem `ControlCajaDto`: el relevo firma el movimiento manual. */
  @IsOptional() @IsInt() operadorId?: number;
}

/** Un movimiento que el cajero se olvidó de asentar, cargado por el superadmin en un turno YA CERRADO (0137). */
class MovimientoPosteriorDto {
  @IsIn(['ingreso', 'egreso']) tipo!: 'ingreso' | 'egreso';
  @IsNumber() @Min(0.01) @Max(100_000_000_000) importe!: number;
  @IsString() @MaxLength(300) motivo!: string;
  @IsBoolean() confirmado!: boolean;
}
class AnularPosteriorDto {
  @IsString() @MaxLength(300) motivo!: string;
}

/** La llave de los movimientos después del cierre: fuera del catálogo, solo el superadmin (`*`). */
export const PERMISO_CAJA_POSTERIOR = 'caja.posterior';

/**
 * EL ARQUEO SIN EL EFECTIVO ESPERADO, para el turno abierto de quien cuenta.
 *
 * No alcanza con borrar `esperadoEfectivo`: se deduce de lo que queda. Por eso
 * se van también el efectivo cobrado (con fondo + movimientos da el esperado),
 * el total cobrado (menos los otros medios da el efectivo) y el esperado y la
 * diferencia de los controles ya hechos (con los movimientos posteriores, lo
 * mismo). Queda lo que el cajero ya sabe o no le sirve para adivinar: el fondo,
 * sus movimientos manuales, los otros medios y lo que él contó.
 */
function arqueoCiego<T extends { medios: Record<string, unknown>; controles: any[] }>(a: T) {
  const { efectivo: _efectivo, ...otrosMedios } = a.medios;
  return {
    ...a,
    sesion: sesionCiega((a as any).sesion),
    medios: otrosMedios,
    esperadoEfectivo: null,
    totalCobrado: null,
    controles: a.controles.map((c) => ({ ...c, esperadoEfectivo: null, diferencia: null })),
    ciego: true,
  };
}

/**
 * NO SE CIERRA UN TURNO CON UN COBRO POR QR ESPERANDO (0126). El pago puede
 * entrar después del cierre y su plata quedaría fuera del arqueo firmado.
 */
async function sinCobrosQrVivos(tx: any, sucursalId: number) {
  const [f] = await tx.select({ n: sql<number>`count(*)::int` }).from(mpCobros)
    .where(and(eq(mpCobros.sucursalId, sucursalId), sql`${mpCobros.estado} in ('esperando', 'procesando', 'error')`));
  if (Number(f?.n) > 0) {
    throw new BadRequestException(
      'Hay un cobro por QR de Mercado Pago sin terminar en esta sucursal (esperando el pago, o pagado sin cerrar la venta): resolvelo antes de cerrar la caja.',
    );
  }
}

@Injectable()
export class CajaService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditoriaService,
  ) {}

  /**
   * ¿El cajero ve lo que tiene que haber en caja? (`ventas.cajaVeEsperado`,
   * 1/10/2026). Se lee de la base en cada pedido —no del caché de la
   * configuración de otro proceso—: apagarlo tiene que cegar la caja ya.
   */
  async cajeroVeEsperado(): Promise<boolean> {
    const r: any = await this.db.execute(sql`SELECT (valor->>'cajaVeEsperado') = 'true' AS ve FROM configuracion WHERE clave = 'ventas'`);
    return !!(r.rows ?? r)[0]?.ve;
  }

  /* ------------------------------ Lectura ------------------------------ */

  async get(id: number) {
    const c = await this.getOpcional(id);
    if (!c) throw new NotFoundException('Turno de caja inexistente.');
    return c;
  }

  /**
   * Igual que `get` pero devuelve `null` en vez de romper. Lo usa la venta: el
   * id de turno que manda el punto de venta puede haber quedado viejo (se cerró
   * la caja en otra pantalla, se resembró la base) y eso no debería hacer
   * fracasar un cobro — se recalcula por sucursal.
   */
  async getOpcional(id: number) {
    const [c] = await this.db.select().from(cajaSesiones).where(eq(cajaSesiones.id, id)).limit(1);
    return c ?? null;
  }

  /** Turno abierto de la sucursal, o `null` si no hay ninguno. */
  async actual(sucursalId: number) {
    const [c] = await this.db.select().from(cajaSesiones)
      .where(and(eq(cajaSesiones.sucursalId, sucursalId), eq(cajaSesiones.estado, 'abierta')))
      .limit(1);
    return c ?? null;
  }

  async list(q: { sucursalId?: number; estado?: string; limit?: number; desde?: string; hasta?: string }) {
    const conds: any[] = [];
    if (q.sucursalId) conds.push(eq(cajaSesiones.sucursalId, Number(q.sucursalId)));
    if (q.estado) conds.push(eq(cajaSesiones.estado, q.estado as any));
    /* POR FECHA DE APERTURA, día argentino (6/10/2026, pedido del dueño: anteayer,
     * ayer o un rango a mano). La fecha se valida antes de entrar al SQL. */
    const esDia = (v?: string) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && (() => { const d = new Date(`${v}T12:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; })();
    if (esDia(q.desde)) conds.push(sql`${cajaSesiones.apertura} >= (${q.desde}::date::timestamp at time zone 'America/Argentina/Buenos_Aires')`);
    if (esDia(q.hasta)) conds.push(sql`${cajaSesiones.apertura} < ((${q.hasta}::date + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires')`);
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    return this.db.select().from(cajaSesiones)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(cajaSesiones.id))
      .limit(limit);
  }

  /**
   * Arqueo del turno: qué entró por cada medio y cuánto efectivo debería haber
   * en el cajón. Se calcula siempre en vivo (nunca se cachea) para que el
   * cajero vea el número real al momento de contar.
   */
  async arqueo(id: number, opts: { ciego?: boolean } = {}) {
    const sesion = await this.get(id);

    const [porVenta, porCobranza, movs, controles] = await Promise.all([
      this.db.select({
        medio: ventaPagos.medio,
        total: sql<number>`coalesce(sum(${ventaPagos.importe}), 0)`,
        /* Cuánto de lo que entró por ese medio NO es venta de mercadería sino
         * recargo por financiación (0100). Viaja con el medio y no aparte
         * porque es plata del MISMO cobro: separarla en otra consulta obligaría
         * a cruzarlas de nuevo para leer cualquiera de los dos números. */
        recargo: sql<number>`coalesce(sum(${ventaPagos.recargo}), 0)`,
      })
        .from(ventaPagos)
        .innerJoin(ventas, eq(ventas.id, ventaPagos.ventaId))
        .where(and(eq(ventas.cajaSesionId, id), eq(ventas.estado, 'confirmada')))
        .groupBy(ventaPagos.medio),
      this.db.select({ medio: cobranzaPagos.medio, total: sql<number>`coalesce(sum(${cobranzaPagos.importe}), 0)` })
        .from(cobranzaPagos)
        .innerJoin(cobranzas, eq(cobranzas.id, cobranzaPagos.cobranzaId))
        .where(and(eq(cobranzas.cajaSesionId, id), eq(cobranzas.estado, 'confirmada')))
        .groupBy(cobranzaPagos.medio),
      this.db.select().from(cajaMovimientos).where(eq(cajaMovimientos.cajaSesionId, id)).orderBy(cajaMovimientos.id),
      this.db.select().from(cajaControles).where(eq(cajaControles.cajaSesionId, id)).orderBy(cajaControles.id),
    ]);

    /** { efectivo: {ventas, cobranzas, total, recargo}, … } */
    const medios: Record<string, { ventas: number; cobranzas: number; total: number; recargo: number }> = {};
    const acumular = (filas: any[], campo: 'ventas' | 'cobranzas') => {
      for (const f of filas) {
        const m = (medios[f.medio] ??= { ventas: 0, cobranzas: 0, total: 0, recargo: 0 });
        m[campo] = money(Number(f.total) || 0);
        if (f.recargo != null) m.recargo = money(Number(f.recargo) || 0);
        m.total = money(m.ventas + m.cobranzas);
      }
    };
    acumular(porVenta, 'ventas');
    acumular(porCobranza, 'cobranzas');

    /*
     * LO QUE ENTRÓ POR FINANCIAR, separado de lo que entró por vender.
     *
     * Es el número que el turno no tenía: sin esto, el recargo se mezcla con
     * la venta en el total de la tarjeta y el día cierra igual, pero nadie
     * puede decir cuánto de eso fue mercadería. Y no es un detalle contable:
     * ese dinero es el que la tarjeta se va a quedar cuando liquide.
     */
    const recargos = money(Object.values(medios).reduce((a, m) => a + (m.recargo || 0), 0));

    /* Los anulados (0137: solo los asentados después del cierre) se muestran tachados pero no suman. */
    const vivos = movs.filter((m) => !m.anuladoEn);
    const ingresos = money(vivos.filter((m) => m.tipo === 'ingreso').reduce((a, m) => a + m.importe, 0));
    const egresos = money(vivos.filter((m) => m.tipo === 'egreso').reduce((a, m) => a + m.importe, 0));

    const efectivo = medios.efectivo ?? { ventas: 0, cobranzas: 0, total: 0 };
    const esperadoEfectivo = money(sesion.montoInicial + efectivo.total + ingresos - egresos);

    /* Ventas en cuenta corriente: no entran a la caja, pero el cajero necesita
     * verlas. Las notas de crédito del turno RESTAN — son deuda que se borró,
     * no venta nueva (la plata devuelta, si la hubo, ya viajó como egreso). */
    const [ctaCte] = await this.db
      .select({
        total: sql<number>`coalesce(sum(${ventas.total} * (case when ${ventas.tipo}::text like 'nota_credito%' then -1 else 1 end)), 0)`,
        n: sql<number>`count(*) filter (where ${ventas.tipo}::text not like 'nota_credito%')::int`,
      })
      .from(ventas)
      .where(and(
        eq(ventas.cajaSesionId, id), eq(ventas.estado, 'confirmada'),
        eq(ventas.condicionPago, 'cuenta_corriente'),
      ));

    const completo = {
      sesion,
      medios,
      movimientos: movs,
      controles,
      ingresos,
      egresos,
      montoInicial: sesion.montoInicial,
      esperadoEfectivo,
      totalCobrado: money(Object.values(medios).reduce((a, m) => a + m.total, 0)),
      /** De lo cobrado, cuánto fue recargo por cuotas y no venta (0100). */
      recargos,
      ctaCte: { total: money(Number(ctaCte?.total) || 0), cantidad: Number(ctaCte?.n) || 0 },
      ciego: false,
    };
    /* Ciego SIEMPRE para el que no es jefe (0111): también el turno cerrado,
     * que antes mostraba el esperado y la diferencia en el historial. */
    return opts.ciego ? arqueoCiego(completo) : completo;
  }

  /**
   * EL CONTEO DEL CIERRE, A CIEGAS (25/9/2026, pedido del dueño).
   *
   * Es la única puerta por la que el cajero ve el efectivo esperado de su turno
   * abierto: declara lo que contó y recién ahí recibe el arqueo completo. Si el
   * conteo NO coincide, queda registrado como control del turno ANTES de mostrar
   * el esperado — así, si después "vuelve a contar" y aparece justo el número
   * del sistema, el primer conteo sigue ahí para quien revise. Si coincide no se
   * registra nada: el cierre mismo ya lo firma, y un control repetido sería ruido.
   */
  async conteoCierre(id: number, dto: ControlCajaDto, sucursalSesion: number | null) {
    const sesion = await this.get(id);
    if (sucursalSesion != null && sesion.sucursalId !== sucursalSesion) throw new ForbiddenException('Ese turno es de otra sucursal.');
    if (sesion.estado !== 'abierta') throw new BadRequestException('El turno ya está cerrado.');
    const contado = money(dto.contadoEfectivo);
    if (contado < 0) throw new BadRequestException('El efectivo contado no puede ser negativo.');

    const a = await this.arqueo(id);
    const diferencia = money(contado - a.esperadoEfectivo);
    let control: typeof cajaControles.$inferSelect | null = null;
    if (Math.abs(diferencia) > 0.009) {
      const extra = (dto.observaciones ?? '').trim();
      [control] = await this.db.insert(cajaControles).values({
        cajaSesionId: id,
        esperadoEfectivo: a.esperadoEfectivo,
        contadoEfectivo: contado,
        diferencia,
        observaciones: `Conteo del cierre, antes de ver el esperado${extra ? ` · ${extra}` : ''}`,
        usuarioId: await resolverOperador(this.db, dto.operadorId, dto.usuarioId),
      }).returning();
      a.controles = [...a.controles, control];
    }
    return { arqueo: a, contado, diferencia, control };
  }

  /**
   * La explicación de un control con diferencia. A ciegas, el cajero se entera
   * de la diferencia DESPUÉS de registrar el conteo, así que el porqué llega en
   * un segundo paso. Solo el texto: el conteo y el esperado no se tocan nunca.
   */
  async explicarControl(id: number, controlId: number, dto: ExplicarControlDto, sucursalSesion: number | null) {
    const sesion = await this.get(id);
    if (sucursalSesion != null && sesion.sucursalId !== sucursalSesion) throw new ForbiddenException('Ese turno es de otra sucursal.');
    if (sesion.estado !== 'abierta') throw new BadRequestException('El turno ya está cerrado: la explicación va en el cierre.');
    const texto = (dto.observaciones ?? '').trim();
    if (!texto) throw new BadRequestException('Escribí por qué hay diferencia.');
    const [c] = await this.db.update(cajaControles).set({ observaciones: texto })
      .where(and(eq(cajaControles.id, controlId), eq(cajaControles.cajaSesionId, id))).returning();
    if (!c) throw new NotFoundException('Ese control no es de este turno.');
    return c;
  }

  /**
   * CON CUÁNTO DEBERÍA ABRIR LA CAJA (0111, pedido del dueño: "que quede por
   * defecto lo que dejó de cambio en caja"). Lo que el último cierre por envío
   * dejó apartado en el cajón; si el último turno lo cerró un jefe con el
   * cierre de siempre (no se sabe cuánto quedó), el fondo fijo de la sucursal.
   *
   * Es la MISMA respuesta para la pantalla y para `abrir`: la pantalla la pide
   * fresca cada vez que se abre el modal (la lista de sucursales del arranque
   * puede estar vieja — fue el error del 26/9: la primera apertura fijó el
   * fondo y la pantalla seguía creyendo que no había).
   */
  async datosApertura(sucursalId: number) {
    const [suc] = await this.db.select({ fondo: sucursales.fondoCaja })
      .from(sucursales).where(eq(sucursales.id, sucursalId)).limit(1);
    const [ultimo] = await this.db.select({
      id: cajaSesiones.id, cierre: cajaSesiones.cierre, fondoQueda: cajaSesiones.fondoQueda,
    }).from(cajaSesiones)
      .where(and(eq(cajaSesiones.sucursalId, sucursalId), eq(cajaSesiones.estado, 'cerrada')))
      .orderBy(desc(cajaSesiones.id)).limit(1);
    const fondoFijo = suc?.fondo != null ? money(suc.fondo) : null;
    const dejadoEnCaja = ultimo?.fondoQueda != null ? money(ultimo.fondoQueda) : null;
    return {
      fondoFijo,
      dejadoEnCaja,
      ultimoTurnoId: ultimo?.id ?? null,
      ultimoCierre: ultimo?.cierre ?? null,
      /** Lo que se propone (y lo que el cajero confirma): lo que quedó, o el fondo fijo. */
      propuesto: dejadoEnCaja ?? fondoFijo,
    };
  }

  /* ------------------------------ Escritura ------------------------------ */

  /**
   * `sucursalId` lo resuelve el CONTROLLER contra la sesión, no el DTO: un
   * cajero abría el turno de otra sucursal mandando otro número, y con eso le
   * arruinaba el fondo inicial del día o le bloqueaba la apertura.
   */
  async abrir(dto: AbrirCajaDto, sucursalId: number, jefe = true) {
    const abierta = await this.actual(sucursalId);
    if (abierta) {
      throw new BadRequestException('Ya hay un turno de caja abierto en esta sucursal. Cerralo antes de abrir otro.');
    }
    /*
     * EL FONDO FIJO DE LA SUCURSAL (0111, pedido del dueño): "si abrí con
     * $50.000, que quede eso". Con fondo cargado, el que no es jefe NO escribe
     * el monto: confirma que están los $50.000 o, si no, los cuenta billete por
     * billete — y lo que falte queda registrado como control del turno, que es
     * lo que ve el administrador. El turno arranca con lo que HAY (no con lo que
     * debería haber): si faltan $10.000, el faltante es de antes de abrir y no
     * se le carga al que cierra hoy.
     *
     * Sin fondo cargado, la primera apertura lo fija. El jefe abre con el monto
     * que quiera (viene propuesto el fondo) sin cambiarlo: el fondo lo cambia
     * solo el superadmin, desde la sucursal.
     */
    /* Lo que debería haber: lo que dejó el último cierre, o el fondo fijo. */
    const ap = await this.datosApertura(sucursalId);
    const fondo = ap.fondoFijo;
    const propuesto = ap.propuesto;
    const $ = (n: number) => `$${n.toLocaleString('es-AR')}`;
    let montoInicial: number;
    let conteoApertura: number | null = null;
    if (propuesto != null && !jefe) {
      if (dto.fondoCompleto === true) {
        montoInicial = propuesto;
      } else {
        if (!dto.billetes || !Object.keys(dto.billetes).length) {
          throw new BadRequestException(
            `Confirmá que están los ${$(propuesto)} ${ap.dejadoEnCaja != null ? 'que quedaron en la caja' : 'del fondo'}, o contalos billete por billete si no están.`,
          );
        }
        conteoApertura = totalDeBilletes(dto.billetes).total;
        montoInicial = conteoApertura;
      }
    } else {
      montoInicial = money(dto.montoInicial ?? propuesto ?? 0);
      // El fondo inicial es OBLIGATORIO y positivo: un turno sin fondo declarado
      // no se puede arquear (no hay punto de partida contra el cual comparar).
      if (!(montoInicial > 0)) throw new BadRequestException('Declará el fondo inicial: la caja siempre arranca con un monto.');
    }

    /*
     * EL CHEQUEO DE ARRIBA ES CORTESÍA; EL CANDADO ES LA BASE (0085). Entre el
     * select y el insert cabe un doble clic — dos aperturas a la vez pasaban
     * las dos y quedaban DOS turnos abiertos en la misma sucursal, con cada
     * venta eligiendo uno u otro. El índice único parcial
     * `uq_caja_abierta_por_sucursal` hace que el segundo insert reviente con
     * 23505, y acá se traduce al mismo mensaje amable del chequeo.
     */
    try {
      const c = await this.db.transaction(async (tx) => {
        const [nueva] = await tx.insert(cajaSesiones).values({
          sucursalId,
          usuarioId: dto.usuarioId ?? null,
          montoInicial,
          estado: 'abierta',
          observaciones: dto.observaciones ?? '',
        }).returning();
        /* La primera apertura FIJA el fondo (solo si nadie lo cargó antes). */
        if (fondo == null) {
          await tx.update(sucursales).set({ fondoCaja: montoInicial })
            .where(and(eq(sucursales.id, sucursalId), sql`${sucursales.fondoCaja} is null`));
        }
        /* El fondo no estaba completo: queda como control del turno, a la vista
         * del administrador, con lo que debía haber y lo que se contó. */
        if (conteoApertura != null && propuesto != null && Math.abs(conteoApertura - propuesto) > 0.009) {
          const dif = money(conteoApertura - propuesto);
          await tx.insert(cajaControles).values({
            cajaSesionId: nueva.id,
            esperadoEfectivo: propuesto,
            contadoEfectivo: conteoApertura,
            diferencia: dif,
            observaciones: `Apertura: ${ap.dejadoEnCaja != null ? `el cierre anterior (turno #${ap.ultimoTurnoId}) dejó ${$(propuesto)} en la caja` : `el fondo fijo es ${$(propuesto)}`} `
              + `y se contaron ${$(conteoApertura)} (${dif < 0 ? 'faltan' : 'sobran'} ${$(Math.abs(dif))}).`,
            usuarioId: dto.usuarioId ?? null,
          });
        }
        return nueva;
      });
      return c;
    } catch (e: any) {
      const code = e?.code ?? e?.cause?.code;
      if (code === '23505') {
        throw new BadRequestException('Ya hay un turno de caja abierto en esta sucursal. Cerralo antes de abrir otro.');
      }
      throw e;
    }
  }

  /**
   * Cerrar el turno: se cuenta el efectivo y el arqueo queda firmado.
   *
   * TODO ADENTRO DE UNA TRANSACCIÓN Y CON LA SESIÓN BLOQUEADA. El cierre son
   * tres pasos —leer que está abierta, sumar el arqueo, marcarla cerrada— y
   * entre el segundo y el tercero entraba plata: un pago a proveedor desde esta
   * caja, o un movimiento manual. Ese egreso quedaba adentro de un turno cerrado
   * pero **fuera de `sistemaEfectivo`**, así que la diferencia del arqueo nacía
   * mal y quedaba congelada en la fila: nadie se enteraba después.
   *
   * Las dos puertas que insertan movimientos (`movimiento` acá y `crear` de
   * pagos) ahora leen la sesión con el mismo candado, así que mientras el cierre
   * cuenta, ninguna puede confirmar: o entran antes y el arqueo las cuenta, o
   * esperan y se rechazan porque el turno ya cerró.
   *
   * `arqueo` sigue leyendo por fuera de la transacción a propósito: no necesita
   * el mismo snapshot, le alcanza con que nadie pueda confirmar un movimiento
   * nuevo mientras el candado está tomado.
   */
  async cerrar(id: number, dto: CerrarCajaDto, sucursalSesion: number | null) {
    const declarado = money(dto.declaradoEfectivo);
    // Mismo piso que el control intermedio (`control`), que sí lo tenía: un
    // declarado negativo dejaba una diferencia inventada congelada en la fila.
    if (declarado < 0) throw new BadRequestException('El efectivo declarado no puede ser negativo.');

    return this.db.transaction(async (tx) => {
      const [sesion] = await tx.select().from(cajaSesiones)
        .where(eq(cajaSesiones.id, id)).limit(1).for('update');
      if (!sesion) throw new NotFoundException('Turno de caja inexistente.');
      if (sucursalSesion != null && sesion.sucursalId !== sucursalSesion) throw new ForbiddenException('Ese turno es de otra sucursal.');
      if (sesion.estado === 'cerrada') throw new BadRequestException('El turno ya está cerrado.');
      await sinCobrosQrVivos(tx, sesion.sucursalId);

      const a = await this.arqueo(id);
      const diferencia = money(declarado - a.esperadoEfectivo);
      const nota = (dto.observaciones ?? '').trim();
      /* Con diferencia, el porqué es obligatorio (25/9/2026): el control
       * intermedio ya lo pedía y el cierre —el que queda— no. */
      if (Math.abs(diferencia) > 0.009 && !nota) {
        throw new BadRequestException(
          `El cierre da una diferencia de ${diferencia > 0 ? '+' : '−'}$${Math.abs(diferencia).toFixed(2)}: escribí en observaciones por qué.`,
        );
      }

      const [c] = await tx.update(cajaSesiones).set({
        cierre: new Date(),
        declaradoEfectivo: declarado,
        sistemaEfectivo: a.esperadoEfectivo,
        diferencia,
        totales: { medios: a.medios, ingresos: a.ingresos, egresos: a.egresos, ctaCte: a.ctaCte },
        estado: 'cerrada',
        /*
         * `||` y NO `??`: el modal de cierre manda el campo VACIO cuando la
         * cajera no escribe nada, y `??` solo cae al valor viejo con null o
         * undefined — con `''` se lo comia. Resultado: la nota de la APERTURA
         * ("arranco con poco cambio", "faltan 2 de mil, aviso a Lucas") se
         * borraba sola al cerrar, y es una nota que despues sale impresa en el
         * comprobante con el que se rinde la plata.
         */
        /* Se SUMA a la nota de la apertura, no la reemplaza: ahora que el
         * cierre con diferencia exige su nota, reemplazar borraría seguido la
         * de la apertura, que también sale en el comprobante. */
        observaciones: nota
          ? (sesion.observaciones ? `${sesion.observaciones} · Cierre: ${nota}` : nota)
          : sesion.observaciones,
      }).where(eq(cajaSesiones.id, id)).returning();
      return c;
    });
  }

  /**
   * EL CIERRE DEL CAJERO: CONTAR, DEJAR EL FONDO Y ENVIAR (0111, pedido del dueño).
   *
   * Es el cierre de todo el que no es jefe, y es A CIEGAS DE PUNTA A PUNTA: el
   * cajero nunca ve cuánto debería haber — ni antes, ni después. Cuenta el
   * cajón billete por billete (el servidor recibe los billetes y suma él: no
   * hay monto tipeado posible), deja el fondo fijo para el turno siguiente y
   * envía el resto. La diferencia contra el sistema se calcula y se guarda en
   * el turno igual que siempre, pero SOLO la ve el administrador; por eso no se
   * le piden observaciones al cajero, que no sabe si hubo diferencia.
   *
   * Si contó menos que el fondo, no se envía nada, queda todo como fondo y el
   * turno lo dice ("fondo incompleto"): el que abra mañana lo va a encontrar
   * al confirmar el fondo, y el administrador lo ve en el cierre.
   *
   * Misma transacción y mismo candado que `cerrar`: nada entra al turno
   * mientras se cierra.
   */
  async enviarYCerrar(id: number, dto: EnviarCierreDto, sucursalSesion: number | null, marcadaPor: number | null = null) {
    if (dto.confirmado !== true) {
      throw new BadRequestException('Confirmá el envío: el turno se cierra y no se puede reabrir.');
    }
    const { billetes, total: contado } = totalDeBilletes(dto.billetes);
    const cerrador = await resolverOperador(this.db, dto.operadorId, dto.usuarioId);

    return this.db.transaction(async (tx) => {
      const [sesion] = await tx.select().from(cajaSesiones)
        .where(eq(cajaSesiones.id, id)).limit(1).for('update');
      if (!sesion) throw new NotFoundException('Turno de caja inexistente.');
      if (sucursalSesion != null && sesion.sucursalId !== sucursalSesion) throw new ForbiddenException('Ese turno es de otra sucursal.');
      if (sesion.estado === 'cerrada') throw new BadRequestException('El turno ya está cerrado.');
      await sinCobrosQrVivos(tx, sesion.sucursalId);

      const [suc] = await tx.select({ fondo: sucursales.fondoCaja }).from(sucursales)
        .where(eq(sucursales.id, sesion.sucursalId)).limit(1);
      const fondo = money(suc?.fondo ?? sesion.montoInicial);
      /*
       * EL SOBRE, BILLETE POR BILLETE (0130): los que manda la pantalla, que
       * tienen que salir de los contados y dejar en la caja por lo menos el
       * fondo; o, sin ellos, la separación que propone el sistema.
       */
      let billetesEnvio: Record<string, number>;
      if (dto.billetesEnvio) {
        billetesEnvio = totalDeBilletes(dto.billetesEnvio).billetes;
        for (const [d, n] of Object.entries(billetesEnvio)) {
          if (n > (billetes[d] ?? 0)) {
            throw new BadRequestException(`En el envío pusiste ${n} billetes de $${Number(d).toLocaleString('es-AR')} y contaste ${billetes[d] ?? 0}.`);
          }
        }
      } else {
        billetesEnvio = proponerSeparacion(billetes, Math.min(contado, fondo)).envio;
      }
      const envio = money(totalDeBilletes(billetesEnvio).total);
      const queda = money(contado - envio);
      if (queda + 0.009 < Math.min(contado, fondo)) {
        throw new BadRequestException(`Así quedarían $${queda.toLocaleString('es-AR')} en la caja y el fondo es $${fondo.toLocaleString('es-AR')}: dejá por lo menos el fondo y mandá el resto.`);
      }
      const faltaFondo = money(Math.max(0, fondo - queda));

      const a = await this.arqueo(id);
      const diferencia = money(contado - a.esperadoEfectivo);
      const $ = (n: number) => `$${n.toLocaleString('es-AR')}`;
      const nota = `Cierre por envío: contó ${$(contado)}, envió ${$(envio)}, quedan ${$(queda)} de fondo`
        + (faltaFondo > 0.009 ? ` · FONDO INCOMPLETO: faltan ${$(faltaFondo)} para los ${$(fondo)}` : '');

      const [c] = await tx.update(cajaSesiones).set({
        cierre: new Date(),
        declaradoEfectivo: contado,
        sistemaEfectivo: a.esperadoEfectivo,
        diferencia,
        totales: { medios: a.medios, ingresos: a.ingresos, egresos: a.egresos, ctaCte: a.ctaCte },
        estado: 'cerrada',
        billetes,
        billetesEnvio,
        envioEfectivo: envio,
        fondoQueda: queda,
        observaciones: sesion.observaciones ? `${sesion.observaciones} · ${nota}` : nota,
      }).where(eq(cajaSesiones.id, id)).returning();
      /* El conteo del cierre también queda firmado por quien contó, como control
       * del turno: es lo que el administrador revisa, con esperado y diferencia. */
      await tx.insert(cajaControles).values({
        cajaSesionId: id,
        esperadoEfectivo: a.esperadoEfectivo,
        contadoEfectivo: contado,
        diferencia,
        observaciones: `Cierre por envío (conteo por billetes): envió ${$(envio)}, quedan ${$(queda)} de fondo`,
        usuarioId: cerrador ?? null,
      });
      if (dto.aControlar) await marcarCaja(tx, { cajaSesionId: id, origen: 'cierre', nota: dto.aControlar.nota, usuarioId: marcadaPor });
      /* El esperado y la diferencia viajan: el controlador los saca si el que
       * cierra cuenta a ciegas (`cajaVeEsperado` apagado y no es jefe). */
      return {
        sesion: c,
        contado, envio, fondo, fondoQueda: queda, faltaFondo, billetes, billetesEnvio,
        esperadoEfectivo: a.esperadoEfectivo, diferencia,
      };
    });
  }

  /**
   * Control de caja intermedio: se cuenta el efectivo SIN cerrar el turno.
   * Guarda la foto (fecha/hora, esperado, contado, diferencia, quién) y nada
   * más — no mueve dinero ni cambia el estado. Es puro control entre arqueos.
   */
  async control(id: number, dto: ControlCajaDto, sucursalSesion: number | null) {
    const sesion = await this.get(id);
    if (sucursalSesion != null && sesion.sucursalId !== sucursalSesion) throw new ForbiddenException('Ese turno es de otra sucursal.');
    if (sesion.estado !== 'abierta') throw new BadRequestException('El turno está cerrado: los controles son entre la apertura y el cierre.');
    const contado = money(dto.contadoEfectivo);
    if (contado < 0) throw new BadRequestException('El efectivo contado no puede ser negativo.');

    const a = await this.arqueo(id);
    const [c] = await this.db.insert(cajaControles).values({
      cajaSesionId: id,
      esperadoEfectivo: a.esperadoEfectivo,
      contadoEfectivo: contado,
      diferencia: money(contado - a.esperadoEfectivo),
      observaciones: (dto.observaciones ?? '').trim(),
      // El relevo (0088): el conteo lo firma quien está parado en la caja.
      usuarioId: await resolverOperador(this.db, dto.operadorId, dto.usuarioId),
    }).returning();
    return c;
  }

  async movimiento(id: number, dto: MovimientoCajaDto, sucursalSesion: number | null) {
    const importe = money(dto.importe);
    if (importe <= 0) throw new BadRequestException('El importe debe ser mayor a 0.');
    if (!dto.motivo?.trim()) throw new BadRequestException('Indicá el motivo del movimiento.');
    // El relevo (0088): el ingreso/egreso manual lo firma quien está en la caja.
    const autor = await resolverOperador(this.db, dto.operadorId, dto.usuarioId);

    return this.db.transaction(async (tx) => {
      /* Con candado y en la misma transacción que el insert: si el cierre está
       * corriendo, este movimiento espera y se rechaza en vez de entrar a un
       * turno cuyo arqueo ya se calculó sin él. Ver `cerrar`. */
      const [sesion] = await tx.select().from(cajaSesiones)
        .where(eq(cajaSesiones.id, id)).limit(1).for('update');
      if (!sesion) throw new NotFoundException('Turno de caja inexistente.');
      /* El id del turno se ve en cualquier listado: sin esto, un egreso "pago
       * flete" bajaba el efectivo esperado del cajón AJENO y esa cajera cerraba
       * en falta. Mismo ataque que se cerró en los pagos a proveedor. */
      if (sucursalSesion != null && sesion.sucursalId !== sucursalSesion) throw new ForbiddenException('Ese turno es de otra sucursal.');
      if (sesion.estado !== 'abierta') throw new BadRequestException('El turno está cerrado.');

      const [m] = await tx.insert(cajaMovimientos).values({
        cajaSesionId: id, tipo: dto.tipo, importe, motivo: dto.motivo!.trim(), usuarioId: autor,
      }).returning();
      return m;
    });
  }

  /**
   * MOVIMIENTO DESPUÉS DEL CIERRE (0137, pedido del dueño). El cajero se olvidó
   * de asentar un egreso (o un ingreso) y avisa cuando el turno ya cerró: sin
   * esto, ese cierre queda con una diferencia que no es real para siempre. Solo
   * el superadmin; queda marcado `posterior`, firmado por él, y el cierre se
   * recalcula: el efectivo esperado y la diferencia cambian, lo CONTADO y lo
   * ENVIADO no (son plata física que ya se contó). Con el turno candado: dos
   * clics no lo cargan dos veces.
   */
  async movimientoPosterior(id: number, dto: MovimientoPosteriorDto, usuarioId: number | null) {
    if (dto.confirmado !== true) throw new BadRequestException('Confirmá el movimiento.');
    const importe = money(dto.importe);
    if (importe <= 0) throw new BadRequestException('El importe tiene que ser mayor a 0.');
    const motivo = String(dto.motivo ?? '').trim();
    if (motivo.length < 5) throw new BadRequestException('Escribí el motivo: qué fue y quién avisó (queda en el turno).');
    return this.db.transaction(async (tx) => {
      const sesion = await this.turnoCerrado(tx, id);
      /* El mismo movimiento recién asentado (doble clic, o reintento de una red
       * lenta): con el turno candado, el segundo lo encuentra y no lo repite. */
      const [gemelo] = await tx.select({ id: cajaMovimientos.id }).from(cajaMovimientos).where(and(
        eq(cajaMovimientos.cajaSesionId, id), eq(cajaMovimientos.posterior, true), eq(cajaMovimientos.tipo, dto.tipo),
        eq(cajaMovimientos.importe, importe), eq(cajaMovimientos.motivo, motivo), isNull(cajaMovimientos.anuladoEn),
        sql`${cajaMovimientos.fecha} > now() - interval '30 seconds'`,
      )).limit(1);
      if (gemelo) throw new ConflictException('Ese movimiento ya se asentó recién: revisá los movimientos del turno.');
      const [m] = await tx.insert(cajaMovimientos).values({
        cajaSesionId: id, tipo: dto.tipo, importe, motivo, usuarioId, posterior: true,
      }).returning();
      const turno = await this.recalcularCierre(tx, sesion, dto.tipo, importe, false, usuarioId,
        `${dto.tipo === 'egreso' ? 'Egreso' : 'Ingreso'} asentado después del cierre: $${importe.toLocaleString('es-AR')} · ${motivo}`);
      return { movimiento: m, sesion: turno };
    });
  }

  /** Anula un movimiento asentado después del cierre (solo esos): tachado, deja de sumar y el cierre vuelve. */
  async anularPosterior(id: number, movId: number, dto: AnularPosteriorDto, usuarioId: number | null) {
    const motivo = String(dto.motivo ?? '').trim();
    if (motivo.length < 3) throw new BadRequestException('Escribí por qué se anula.');
    return this.db.transaction(async (tx) => {
      const sesion = await this.turnoCerrado(tx, id);
      const [m] = await tx.select().from(cajaMovimientos).where(eq(cajaMovimientos.id, movId)).limit(1).for('update');
      if (!m || m.cajaSesionId !== id) throw new NotFoundException('Ese movimiento no es de este turno.');
      if (!m.posterior) throw new BadRequestException('Solo se anulan los movimientos asentados después del cierre: los del turno los firmó el cajero.');
      if (m.anuladoEn) throw new BadRequestException('Ese movimiento ya estaba anulado.');
      await tx.update(cajaMovimientos).set({ anuladoEn: new Date(), anuladoPor: usuarioId, anuladoMotivo: motivo })
        .where(eq(cajaMovimientos.id, movId));
      /* Deshacerlo saca ese movimiento del cierre. */
      const turno = await this.recalcularCierre(tx, sesion, m.tipo, m.importe, true, usuarioId,
        `Anulado el ${m.tipo} posterior de $${money(m.importe).toLocaleString('es-AR')} («${m.motivo}») · ${motivo}`);
      return { ok: true, sesion: turno };
    });
  }

  /** El turno, candado y CERRADO: lo abierto se mueve por el camino de siempre (Ingreso / egreso). */
  private async turnoCerrado(tx: any, id: number) {
    const [sesion] = await tx.select().from(cajaSesiones).where(eq(cajaSesiones.id, id)).limit(1).for('update');
    if (!sesion) throw new NotFoundException('Turno de caja inexistente.');
    if (sesion.estado !== 'cerrada') throw new BadRequestException('El turno está abierto: el movimiento se carga con «Ingreso / egreso».');
    return sesion;
  }

  /**
   * El cierre después de un movimiento posterior: lo esperado se corre en el
   * importe (egreso resta, ingreso suma), la diferencia es lo contado menos
   * eso, y los totales del turno acompañan. Sobre la foto del cierre y no
   * recalculando el arqueo entero: dentro de la transacción es exacto, y lo
   * contado y lo enviado no se tocan. Queda en la auditoría del turno.
   */
  private async recalcularCierre(
    tx: any, sesion: any, tipo: 'ingreso' | 'egreso', importe: number, quitar: boolean, usuarioId: number | null, detalle: string,
  ) {
    /* Sumar un egreso baja lo esperado; quitarlo (anular) lo devuelve. */
    const signo = (tipo === 'ingreso' ? 1 : -1) * (quitar ? -1 : 1);
    const sistema = money((Number(sesion.sistemaEfectivo) || 0) + signo * importe);
    const diferencia = money((Number(sesion.declaradoEfectivo) || 0) - sistema);
    const tot: any = { ...(sesion.totales ?? {}) };
    const campo = tipo === 'ingreso' ? 'ingresos' : 'egresos';
    tot[campo] = money((Number(tot[campo]) || 0) + (quitar ? -importe : importe));
    const [c] = await tx.update(cajaSesiones).set({ sistemaEfectivo: sistema, diferencia, totales: tot })
      .where(eq(cajaSesiones.id, sesion.id)).returning();
    const $ = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('es-AR')}`;
    await this.audit.registrar([{
      entidad: 'caja', entidadId: sesion.id, ambito: 'Caja', campo: 'Movimiento después del cierre', usuarioId,
      detalle, antes: `Diferencia ${$(money(sesion.diferencia ?? 0))}`, despues: `Diferencia ${$(diferencia)}`,
    }], tx);
    return c;
  }

  /**
   * Turno válido para operar en una sucursal. Lo usa la venta: si la caja es
   * obligatoria y no hay turno, la venta se rechaza acá y no a mitad de camino.
   */
  async exigirTurno(sucursalId: number, obligatoria: boolean) {
    const abierta = await this.actual(sucursalId);
    if (!abierta && obligatoria) {
      throw new BadRequestException('No hay un turno de caja abierto en esta sucursal. Abrí la caja para vender.');
    }
    return abierta;
  }
}

/**
 * El turno de caja es la pantalla `ventas.caja`, y las cuatro escrituras piden
 * ese permiso. El MOVIMIENTO manual —meter o sacar plata del cajón— pide además
 * `diferencias`: es la acción con la que se justifica un faltante, no parte de
 * abrir y cerrar el turno.
 */
@Controller('caja')
@Permiso('ventas.caja')
export class CajaController {
  constructor(private readonly svc: CajaService) {}

  /**
   * ¿Este que mira cuenta a ciegas? El que no es jefe, mientras la
   * configuración no le deje ver lo que tiene que haber (`cajaVeEsperado`).
   * Administración y superadmin ven siempre: revisan las diferencias.
   */
  private async ciego(sesion: Sesion): Promise<boolean> {
    return !esJefe(sesion) && !(await this.svc.cajeroVeEsperado());
  }

  /*
   * También con `ventas.pos`: el punto de venta pregunta si hay turno abierto
   * para saber si puede cobrar (PosPanel), y un cajero que vende sin administrar
   * la caja no tiene por qué tener la pantalla de Caja.
   */
  @Get('actual/:sucursalId')
  @Permiso('ventas.caja', 'ventas.pos')
  actual(@Param('sucursalId', ParseIntPipe) sucursalId: number) { return this.svc.actual(sucursalId); }

  /*
   * LAS LECTURAS TAMBIÉN SON POR SUCURSAL. Las cuatro escrituras ya comparaban
   * contra la de la sesión, pero mirar quedó abierto: `GET /caja` sin parámetros
   * listaba los turnos de las cinco sucursales con su fondo inicial, lo
   * declarado, lo esperado y **la diferencia** de cada arqueo, y
   * `GET /caja/:id/arqueo` daba el efectivo que debería haber AHORA MISMO en el
   * cajón de un turno abierto ajeno. Es el histórico de faltantes de cada
   * compañero, y no rompe ninguna pantalla cerrarlo: `CajaPanel` ya trabaja
   * sobre la sucursal del contexto.
   */
  @Get()
  async list(
    @Auth() sesion: Sesion,
    @Query('sucursalId') sucursalId?: string,
    @Query('estado') estado?: string,
    @Query('limit') limit?: string,
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
  ) {
    const mia = soloSuSucursal(sesion);
    const filas = await this.svc.list({
      sucursalId: mia ?? (sucursalId ? Number(sucursalId) : undefined),
      estado, limit: limit ? Number(limit) : undefined, desde, hasta,
    });
    // El historial también a ciegas para el que cuenta a ciegas (0111).
    return (await this.ciego(sesion)) ? filas.map((f) => sesionCiega(f)) : filas;
  }

  /*
   * A CIEGAS PARA EL QUE CUENTA: con el turno abierto, quien no es jefe recibe
   * el arqueo SIN el efectivo esperado (ver `arqueoCiego`). Lo ve después de
   * declarar su conteo, en el cierre (`conteo-cierre`) o en un control.
   */
  @Get(':id/arqueo')
  async arqueo(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) {
    await this.exigirMiTurno(id, sesion);
    return this.svc.arqueo(id, { ciego: await this.ciego(sesion) });
  }

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) {
    await this.exigirMiTurno(id, sesion);
    const t = await this.svc.get(id);
    return (await this.ciego(sesion)) ? sesionCiega(t) : t;
  }

  /** El turno tiene que ser de mi sucursal, salvo que sea un jefe (`null`). */
  private async exigirMiTurno(id: number, sesion: Sesion) {
    const mia = soloSuSucursal(sesion);
    if (mia == null) return;
    const t = await this.svc.getOpcional(id);
    if (t && t.sucursalId !== mia) {
      throw new ForbiddenException('Ese turno es de otra sucursal.');
    }
  }

  /*
   * Las cuatro escrituras trabajan sobre LA sucursal de la sesión. El jefe puede
   * apuntar a otra al abrir (`sucursalDeOperacion`); para cerrar, controlar o
   * mover plata la sucursal se compara contra la del turno, adentro del servicio
   * y bajo el mismo candado que ya tenía.
   */
  /** Con cuánto debería abrir la caja de una sucursal (ver `datosApertura`). */
  @Get('apertura/:sucursalId')
  apertura(@Param('sucursalId', ParseIntPipe) sucursalId: number, @Auth() sesion: Sesion) {
    const mia = soloSuSucursal(sesion);
    if (mia != null && mia !== sucursalId) throw new ForbiddenException('Esa caja es de otra sucursal.');
    return this.svc.datosApertura(sucursalId);
  }

  @Post('abrir')
  abrir(@Body() dto: AbrirCajaDto, @Auth() sesion: Sesion) {
    const sucursalId = sucursalDeOperacion(sesion, dto.sucursalId);
    if (!sucursalId) throw new BadRequestException('Tu sesión no tiene sucursal: volvé a entrar eligiéndola.');
    return this.svc.abrir(dto, sucursalId, esJefe(sesion));
  }

  /*
   * EL CIERRE CON MONTO DECLARADO Y EL "VER RESULTADO" SE DIERON DE BAJA
   * (1/10/2026, pedido del dueño: «eliminame la opción de que puedan ver el
   * resultado»). Todos —también administración— cierran por `enviar`, contando
   * los billetes: un solo cierre, con su comprobante billete por billete. Si el
   * cajero ve o no lo que tiene que haber lo decide `cajaVeEsperado`.
   */
  @Post(':id/cerrar')
  cerrar() {
    throw new ForbiddenException('La caja se cierra contando los billetes y enviando («Cerrar caja»). El cierre con monto se dio de baja.');
  }

  /** El cierre: contar billetes, dejar el fondo y enviar el resto (0111). Para todos. */
  @Post(':id/enviar')
  async enviar(@Param('id', ParseIntPipe) id: number, @Body() dto: EnviarCierreDto, @Auth() sesion: Sesion) {
    if (dto.aControlar && !tienePermiso(sesion?.permisos ?? [], [PERMISO_CASHFLOW])) {
      throw new ForbiddenException('Mandar una caja a «Cajas a controlar» es solo del dueño.');
    }
    const r = await this.svc.enviarYCerrar(id, dto, soloSuSucursal(sesion), sesion?.usuarioId ?? null);
    return (await this.ciego(sesion))
      ? { ...r, sesion: sesionCiega(r.sesion), esperadoEfectivo: null, diferencia: null, ciego: true }
      : { ...r, ciego: false };
  }

  /* El control intermedio del que no es jefe queda registrado igual, pero la
   * respuesta vuelve SIN el esperado ni la diferencia (0111). */
  @Post(':id/control')
  async control(@Param('id', ParseIntPipe) id: number, @Body() dto: ControlCajaDto, @Auth() sesion: Sesion) {
    const c = await this.svc.control(id, dto, soloSuSucursal(sesion));
    return (await this.ciego(sesion)) ? { ...c, esperadoEfectivo: null, diferencia: null, ciego: true } : c;
  }

  @Patch(':id/control/:controlId')
  explicarControl(
    @Param('id', ParseIntPipe) id: number,
    @Param('controlId', ParseIntPipe) controlId: number,
    @Body() dto: ExplicarControlDto,
    @Auth() sesion: Sesion,
  ) {
    return this.svc.explicarControl(id, controlId, dto, soloSuSucursal(sesion));
  }

  /* El «Ver resultado» del cierre con monto: dado de baja con él (1/10/2026). */
  @Post(':id/conteo-cierre')
  conteoCierre() {
    throw new ForbiddenException('La caja se cierra contando los billetes y enviando («Cerrar caja»). El «Ver resultado» se dio de baja.');
  }

  /*
   * `diferencias` SOLO, sin `ventas.caja`: el permiso del método REEMPLAZA al de
   * la clase (el guard resuelve handler y después clase), y las claves de un
   * mismo `@Permiso` se evalúan con O — poner las dos acá haría que alcanzara
   * con ver la caja. Sacar plata del cajón es la acción más fuerte del módulo y
   * pide su propia llave.
   */
  @Post(':id/movimiento')
  @Permiso('diferencias')
  mov(@Param('id', ParseIntPipe) id: number, @Body() dto: MovimientoCajaDto, @Auth() sesion: Sesion) {
    return this.svc.movimiento(id, dto, soloSuSucursal(sesion));
  }

  /* Después del cierre (0137): solo el superadmin — la llave no está en el catálogo, pasa el comodín. */
  @Post(':id/movimiento-posterior')
  @Permiso(PERMISO_CAJA_POSTERIOR)
  movPosterior(@Param('id', ParseIntPipe) id: number, @Body() dto: MovimientoPosteriorDto, @Auth() sesion: Sesion) {
    return this.svc.movimientoPosterior(id, dto, sesion?.usuarioId ?? null);
  }

  @Post(':id/movimiento-posterior/:movId/anular')
  @Permiso(PERMISO_CAJA_POSTERIOR)
  anularPosterior(
    @Param('id', ParseIntPipe) id: number, @Param('movId', ParseIntPipe) movId: number,
    @Body() dto: AnularPosteriorDto, @Auth() sesion: Sesion,
  ) {
    return this.svc.anularPosterior(id, movId, dto, sesion?.usuarioId ?? null);
  }
}

@Module({
  imports: [AuditoriaModule],
  controllers: [CajaController],
  providers: [CajaService],
  exports: [CajaService],
})
export class CajaModule {}
