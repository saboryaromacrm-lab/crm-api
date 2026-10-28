/**
 * CUENTAS DISPONIBLES — la transferencia tercerizada (0095)
 * ============================================================================
 * Se le debe a un proveedor. En vez de pagarle de la cuenta propia, se le da a
 * los clientes el alias del proveedor y el cliente transfiere directo allá:
 *
 *   · La CUENTA es el balde: "a esta cuenta bancaria de este proveedor hay
 *     que hacerle llegar $50.000". Se crea a mano, una por deuda.
 *   · El PAGO es cada transferencia que cae en el balde. NO se carga a mano:
 *     nace del cobro de una venta o de un recibo, y en la misma transacción
 *     deja su espejo en `proveedor_pagos` — la deuda del cliente y la del
 *     proveedor bajan en el mismo instante, o ninguna de las dos.
 *
 * Reglas que sostienen el circuito:
 *
 *   · NUNCA de más: un pago no puede superar lo que le falta a la cuenta. Si
 *     el cliente transfirió de más en la vida real, el dueño sube el importe
 *     de la cuenta (acción explícita, con nombre y hora) — no se "acepta".
 *     Salvo la cuenta que «puede pasarse del monto» (0177): ahí un pago puede
 *     superar lo que falta, ese pago la cierra, y lo de más queda a favor en
 *     la cuenta corriente del proveedor (el espejo es por el total).
 *   · EL MÍNIMO DEL PROVEEDOR ("menos de $50.000 no"): cada pago lo respeta,
 *     salvo el que CIERRA la cuenta — el resto final es lo que es.
 *   · La cuenta se toma con candado (FOR UPDATE) al recibir un pago: dos
 *     cajeras sobre el mismo resto se ponen en fila y la segunda recibe el
 *     "le faltan $X" con el número ya actualizado.
 *   · `pagado`, `falta` y `cant` se SUMAN de los pagos vivos, nunca se guardan.
 *   · El espejo en `proveedor_pagos` no se anula desde Proveedores: muere con
 *     su venta o recibo, y solo si todavía no se aplicó a una factura.
 */
import {
  BadRequestException, Body, Controller, Delete, Get, Inject, Injectable, Module,
  NotFoundException, Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import {
  IsBoolean, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min,
} from 'class-validator';
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { exigirFueraDeConciliado } from '../common/conciliacion';
import { DRIZZLE, Database } from '../db/drizzle';
import { numeroDoc } from '../common/documentos';
import { PagosModule, PagosProveedorService } from '../pagos/pagos.module';
import { cuentaDeTransferencia } from '../pagos/cuentas-propias';
import {
  clientes, cobranzaPagos, cobranzas, cuentaDisponiblePagos, cuentasDisponibles,
  proveedorCuentas, proveedorPagos, proveedores, usuarios, ventaPagos, ventas,
} from '../db/schema';

const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
/** Tolerancia de centavo: los importes son double. */
const EPS = 0.009;
const SOLO_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CUENTAS_BANCARIAS = 5;

const fechaDe = (s?: string) => (s ? new Date(`${s}T00:00:00`) : undefined);

/* --------------------------------- DTOs --------------------------------- */

export class CrearCuentaDto {
  @IsInt() proveedorId!: number;
  /** Una cuenta bancaria ya cargada en la ficha… */
  @IsOptional() @IsInt() cuentaId?: number;
  /** …o una nueva, que se guarda en la ficha para la próxima. */
  @IsOptional() @IsString() @MaxLength(120) titular?: string;
  @IsOptional() @IsString() @MaxLength(120) cbuAlias?: string;
  @IsNumber() @Min(0.01, { message: 'El importe a cubrir tiene que ser mayor a 0.' }) @Max(1_000_000_000) importe!: number;
  @IsOptional() @Matches(SOLO_FECHA, { message: 'La fecha va como AAAA-MM-DD.' }) fecha?: string;
  @IsOptional() @IsBoolean() prioritaria?: boolean;
  /** Solo se ofrece en ventas (o recibos) desde este total; 0 = siempre. */
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000_000) ventaMinima?: number;
  /** Acepta un pago que supere lo que falta (0177): ese pago la cierra. */
  @IsOptional() @IsBoolean() puedePasarse?: boolean;
  @IsOptional() @IsString() @MaxLength(300) observaciones?: string;
  /** Lo pone el AutorInterceptor con el usuario de la sesión. */
  @IsOptional() @IsInt() usuarioId?: number;
}

/** Un pago PROPIO a la cuenta (0151): Sabor y Aroma transfiere desde su cuenta, sin pasar por la caja. */
export class PagoPropioDto {
  @IsNumber() @Min(0.01, { message: 'El importe tiene que ser mayor a 0.' }) @Max(1_000_000_000) importe!: number;
  @IsOptional() @Matches(SOLO_FECHA, { message: 'La fecha va como AAAA-MM-DD.' }) fecha?: string;
  /** El número de operación: va en la referencia del pago. */
  @IsOptional() @IsString() @MaxLength(120) referencia?: string;
  @IsOptional() @IsString() @MaxLength(300) observaciones?: string;
  /** De qué cuenta propia salió la transferencia (0207). */
  @IsOptional() @IsInt() cuentaPropiaId?: number;
}

export class AnularPagoPropioDto {
  @IsString() @MaxLength(300) motivo!: string;
}

export class EditarCuentaDto {
  @IsOptional() @IsNumber() @Min(0.01) @Max(1_000_000_000) importe?: number;
  @IsOptional() @Matches(SOLO_FECHA, { message: 'La fecha va como AAAA-MM-DD.' }) fecha?: string;
  @IsOptional() @IsBoolean() prioritaria?: boolean;
  @IsOptional() @IsBoolean() enviado?: boolean;
  @IsOptional() @IsBoolean() corte?: boolean;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000_000) ventaMinima?: number;
  @IsOptional() @IsBoolean() puedePasarse?: boolean;
  @IsOptional() @IsString() @MaxLength(300) observaciones?: string;
  /** Solo mientras la cuenta no tenga historia. */
  @IsOptional() @IsString() @MaxLength(120) titular?: string;
  @IsOptional() @IsString() @MaxLength(120) cbuAlias?: string;
  @IsOptional() @IsInt() usuarioId?: number;
}

/** Lo que un cobro trae para cada renglón "transferencia a proveedor". */
export interface PagoTercerizado {
  cuentaDisponibleId: number;
  importe: number;
  ventaPagoId?: number;
  cobranzaPagoId?: number;
}

export interface ContextoCobro {
  sucursalId?: number | null;
  usuarioId?: number | null;
  /** "Venta 0001-00000123" / "Recibo 0001-00000045": va al concepto del pago. */
  documento: string;
  clienteNombre: string;
  /** El total de la venta o del recibo: contra él se mira la venta mínima de cada cuenta. */
  totalOperacion: number;
}

/* -------------------------------- Service -------------------------------- */

@Injectable()
export class CuentasDisponiblesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly pagosProv: PagosProveedorService,
  ) {}

  /* ------------------------------ Lectura ------------------------------ */

  /**
   * La cuenta con sus sumas. `pagado` y `cant` cuentan solo los pagos VIVOS;
   * `historia` cuenta todos (anulados incluidos): una cuenta con historia no
   * se borra ni cambia de titular, aunque hoy tenga $0 pagados.
   */
  private base() {
    return this.db.select({
      id: cuentasDisponibles.id,
      proveedorId: cuentasDisponibles.proveedorId,
      proveedorNombre: proveedores.nombre,
      minimo: proveedores.minimoTransferencia,
      cuentaId: cuentasDisponibles.cuentaId,
      titular: cuentasDisponibles.titular,
      cbuAlias: cuentasDisponibles.cbuAlias,
      importe: cuentasDisponibles.importe,
      fecha: cuentasDisponibles.fecha,
      prioritaria: cuentasDisponibles.prioritaria,
      ventaMinima: cuentasDisponibles.ventaMinima,
      puedePasarse: cuentasDisponibles.puedePasarse,
      enviado: cuentasDisponibles.enviado,
      corte: cuentasDisponibles.corte,
      corteEn: cuentasDisponibles.corteEn,
      observaciones: cuentasDisponibles.observaciones,
      usuarioId: cuentasDisponibles.usuarioId,
      creadoEn: cuentasDisponibles.creadoEn,
      pagado: sql<number>`coalesce(sum(${cuentaDisponiblePagos.importe}) filter (where ${cuentaDisponiblePagos.anuladoEn} is null), 0)`,
      cant: sql<number>`count(${cuentaDisponiblePagos.id}) filter (where ${cuentaDisponiblePagos.anuladoEn} is null)`,
      historia: sql<number>`count(${cuentaDisponiblePagos.id})`,
    }).from(cuentasDisponibles)
      .innerJoin(proveedores, eq(proveedores.id, cuentasDisponibles.proveedorId))
      .leftJoin(cuentaDisponiblePagos, eq(cuentaDisponiblePagos.cuentaId, cuentasDisponibles.id))
      .groupBy(cuentasDisponibles.id, proveedores.id)
      .$dynamic();
  }

  /** Lo derivado, en un solo lugar: el estado y los avisos salen de las sumas. */
  private decorar(r: any) {
    const pagado = money(Number(r.pagado));
    /* Lo que falta nunca es negativo: lo que entró de más (solo en una cuenta
     * que «puede pasarse», 0177) se dice aparte, como `pasado`. */
    const saldo = money(r.importe - pagado);
    const falta = Math.max(0, saldo);
    const pasado = Math.max(0, -saldo);
    const cant = Number(r.cant);
    const historia = Number(r.historia);
    const estado = r.corte ? 'cortada' : falta <= EPS ? 'cubierta' : 'abierta';
    const minimo = money(Number(r.minimo));
    return {
      ...r,
      pagado, falta, pasado, cant, historia, estado, minimo,
      /* Aviso para el dueño: lo que queda ya no alcanza el piso del proveedor,
       * así que solo se cubre con UNA transferencia por el resto exacto. */
      restoBajoMinimo: estado === 'abierta' && minimo > 0 && falta < minimo - EPS,
      puedeBorrar: historia === 0,
    };
  }

  /** El orden en que se OFRECEN al cobrar: la estrella primero, después la más vieja. */
  private ordenar(q: any) {
    return q.orderBy(desc(cuentasDisponibles.prioritaria), asc(cuentasDisponibles.fecha), asc(cuentasDisponibles.id));
  }

  private readonly faltaSql = sql`${cuentasDisponibles.importe} - coalesce(sum(${cuentaDisponiblePagos.importe}) filter (where ${cuentaDisponiblePagos.anuladoEn} is null), 0)`;

  async listar(q: { proveedorId?: number; estado?: string; desde?: string; hasta?: string }) {
    const conds: any[] = [];
    if (q.proveedorId) conds.push(eq(cuentasDisponibles.proveedorId, q.proveedorId));
    if (q.desde && SOLO_FECHA.test(q.desde)) conds.push(gte(cuentasDisponibles.fecha, fechaDe(q.desde)!));
    if (q.hasta && SOLO_FECHA.test(q.hasta)) conds.push(lte(cuentasDisponibles.fecha, new Date(`${q.hasta}T23:59:59.999`)));

    const estado = q.estado || 'abiertas';
    if (estado === 'cortadas') conds.push(eq(cuentasDisponibles.corte, true));
    else if (estado !== 'todas') conds.push(eq(cuentasDisponibles.corte, false));

    let query = this.base();
    if (conds.length) query = query.where(and(...conds));
    if (estado === 'abiertas') query = query.having(sql`${this.faltaSql} > ${EPS}`);
    else if (estado === 'cubiertas') query = query.having(sql`${this.faltaSql} <= ${EPS}`);

    const filas = (await this.ordenar(query)).map((r: any) => this.decorar(r));
    return {
      filas,
      total: filas.length,
      totalImporte: money(filas.reduce((a: number, f: any) => a + f.importe, 0)),
      totalFalta: money(filas.reduce((a: number, f: any) => a + f.falta, 0)),
    };
  }

  /**
   * Lo que ve la caja al elegir "Transf. a proveedor": solo las abiertas, con
   * lo que le falta a cada una y el mínimo del proveedor. Liviano y fresco —
   * se pide al abrir el cobro, porque el resto cambia con cada venta de
   * cualquier sucursal.
   */
  async paraCobrar() {
    const filas = await this.ordenar(
      this.base().where(eq(cuentasDisponibles.corte, false)).having(sql`${this.faltaSql} > ${EPS}`),
    );
    return filas.map((r: any) => {
      const d = this.decorar(r);
      return {
        id: d.id, proveedorId: d.proveedorId, proveedorNombre: d.proveedorNombre,
        titular: d.titular, cbuAlias: d.cbuAlias,
        importe: d.importe, pagado: d.pagado, falta: d.falta, minimo: d.minimo,
        ventaMinima: money(Number(d.ventaMinima)), prioritaria: d.prioritaria, fecha: d.fecha,
        puedePasarse: d.puedePasarse,
      };
    });
  }

  async get(id: number) {
    const [r] = await this.base().where(eq(cuentasDisponibles.id, id));
    if (!r) throw new NotFoundException('Esa cuenta disponible no existe.');
    return this.decorar(r);
  }

  /* ------------------------------ Escritura ------------------------------ */

  /**
   * Con qué cuenta bancaria nace: una de la ficha (por id) o una nueva. La
   * nueva se guarda en la ficha si hay lugar, para no tipearla la próxima —
   * y si el alias ya estaba, se reutiliza esa fila (completándole el titular
   * si le faltaba). Devuelve la FOTO que se congela en la cuenta.
   */
  private async resolverCuentaBancaria(tx: any, proveedorId: number, dto: CrearCuentaDto) {
    const titular = (dto.titular ?? '').trim().slice(0, 120);
    const cbuAlias = (dto.cbuAlias ?? '').trim().slice(0, 120);

    if (dto.cuentaId) {
      const [c] = await tx.select().from(proveedorCuentas)
        .where(and(eq(proveedorCuentas.id, dto.cuentaId), eq(proveedorCuentas.proveedorId, proveedorId))).limit(1);
      if (!c) throw new BadRequestException('Esa cuenta bancaria no es de este proveedor.');
      // La ficha vieja no tenía titular: si viene ahora, se completa allá también.
      if (!c.titular && titular) {
        await tx.update(proveedorCuentas).set({ titular }).where(eq(proveedorCuentas.id, c.id));
      }
      const tit = c.titular || titular;
      if (!tit) throw new BadRequestException('Poné a nombre de quién está la cuenta: el cliente lo necesita ver antes de transferir.');
      return { cuentaId: c.id, titular: tit, cbuAlias: c.cbuAlias };
    }

    if (!cbuAlias) throw new BadRequestException('Poné el alias o CBU de la cuenta del proveedor.');
    if (!titular) throw new BadRequestException('Poné a nombre de quién está la cuenta: el cliente lo necesita ver antes de transferir.');

    const [existente] = await tx.select().from(proveedorCuentas)
      .where(and(eq(proveedorCuentas.proveedorId, proveedorId), eq(proveedorCuentas.cbuAlias, cbuAlias))).limit(1);
    if (existente) {
      if (!existente.titular) await tx.update(proveedorCuentas).set({ titular }).where(eq(proveedorCuentas.id, existente.id));
      return { cuentaId: existente.id, titular: existente.titular || titular, cbuAlias };
    }
    const [{ n }] = await tx.select({ n: sql<number>`count(*)` }).from(proveedorCuentas)
      .where(eq(proveedorCuentas.proveedorId, proveedorId));
    if (Number(n) >= MAX_CUENTAS_BANCARIAS) {
      // La ficha está llena: la cuenta nace igual, con su foto, sin referencia.
      return { cuentaId: null, titular, cbuAlias };
    }
    const [nueva] = await tx.insert(proveedorCuentas).values({ proveedorId, cbuAlias, titular, descripcion: '' }).returning();
    return { cuentaId: nueva.id, titular, cbuAlias };
  }

  async crear(dto: CrearCuentaDto) {
    const [prov] = await this.db.select({ id: proveedores.id }).from(proveedores)
      .where(eq(proveedores.id, dto.proveedorId)).limit(1);
    if (!prov) throw new BadRequestException('Proveedor inválido.');

    const id = await this.db.transaction(async (tx) => {
      const banco = await this.resolverCuentaBancaria(tx, prov.id, dto);
      const [c] = await tx.insert(cuentasDisponibles).values({
        proveedorId: prov.id,
        cuentaId: banco.cuentaId,
        titular: banco.titular,
        cbuAlias: banco.cbuAlias,
        importe: money(dto.importe),
        fecha: fechaDe(dto.fecha) ?? new Date(),
        prioritaria: dto.prioritaria === true,
        ventaMinima: money(dto.ventaMinima ?? 0),
        puedePasarse: dto.puedePasarse === true,
        observaciones: (dto.observaciones ?? '').trim(),
        usuarioId: dto.usuarioId ?? null,
      }).returning({ id: cuentasDisponibles.id });
      return c.id;
    });
    return this.get(id);
  }

  async editar(id: number, dto: EditarCuentaDto) {
    await this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(cuentasDisponibles).where(eq(cuentasDisponibles.id, id)).limit(1).for('update');
      if (!c) throw new NotFoundException('Esa cuenta disponible no existe.');
      const { pagado, historia } = await this.sumas(tx, id);

      const set: Record<string, any> = {};
      /* Solo si cambia: una cuenta que se pasó (0177) tiene más pagado que su
       * importe, y guardarla con el mismo importe no la tiene que frenar. */
      if (dto.importe !== undefined && Math.abs(money(dto.importe) - money(c.importe)) > EPS) {
        const nuevo = money(dto.importe);
        // Nunca por debajo de lo que ya entró: eso sería borrar transferencias reales.
        if (nuevo < pagado - EPS) {
          throw new BadRequestException(
            `El importe no puede quedar en $${nuevo.toFixed(2)}: la cuenta ya tiene $${pagado.toFixed(2)} transferidos.`,
          );
        }
        set.importe = nuevo;
      }
      if (dto.titular !== undefined || dto.cbuAlias !== undefined) {
        if (historia > 0) {
          throw new BadRequestException(
            'Esta cuenta ya recibió transferencias: el titular y el alias quedan congelados. Cortala y creá otra.',
          );
        }
        if (dto.titular !== undefined) set.titular = dto.titular.trim().slice(0, 120);
        if (dto.cbuAlias !== undefined) set.cbuAlias = dto.cbuAlias.trim().slice(0, 120);
        if ((set.titular ?? c.titular) === '' || (set.cbuAlias ?? c.cbuAlias) === '') {
          throw new BadRequestException('El titular y el alias no pueden quedar vacíos.');
        }
      }
      if (dto.fecha !== undefined) set.fecha = fechaDe(dto.fecha);
      if (dto.prioritaria !== undefined) set.prioritaria = dto.prioritaria;
      if (dto.ventaMinima !== undefined) set.ventaMinima = money(dto.ventaMinima);
      if (dto.puedePasarse !== undefined && dto.puedePasarse !== c.puedePasarse) {
        /* Ya recibió de más: sacarle el tilde dejaría una cuenta «nunca de
         * más» con más plata que su importe. */
        if (!dto.puedePasarse && pagado > money(set.importe ?? c.importe) + EPS) {
          throw new BadRequestException(
            `Esta cuenta ya recibió $${pagado.toFixed(2)} de $${money(set.importe ?? c.importe).toFixed(2)}: quedó pasada y el tilde no se puede sacar.`,
          );
        }
        set.puedePasarse = dto.puedePasarse;
      }
      if (dto.enviado !== undefined) set.enviado = dto.enviado;
      if (dto.corte !== undefined && dto.corte !== c.corte) {
        set.corte = dto.corte;
        set.corteEn = dto.corte ? new Date() : null;
      }
      if (dto.observaciones !== undefined) set.observaciones = dto.observaciones.trim();

      if (Object.keys(set).length) await tx.update(cuentasDisponibles).set(set).where(eq(cuentasDisponibles.id, id));
    });
    return this.get(id);
  }

  async borrar(id: number) {
    await this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(cuentasDisponibles).where(eq(cuentasDisponibles.id, id)).limit(1).for('update');
      if (!c) throw new NotFoundException('Esa cuenta disponible no existe.');
      const { historia } = await this.sumas(tx, id);
      if (historia > 0) {
        throw new BadRequestException('Esta cuenta tiene transferencias: no se borra, se corta.');
      }
      await tx.delete(cuentasDisponibles).where(eq(cuentasDisponibles.id, id));
    });
    return { ok: true };
  }

  /** Las sumas de UNA cuenta, dentro de la transacción y después del candado. */
  private async sumas(tx: any, cuentaId: number) {
    const [r] = await tx.select({
      pagado: sql<number>`coalesce(sum(${cuentaDisponiblePagos.importe}) filter (where ${cuentaDisponiblePagos.anuladoEn} is null), 0)`,
      historia: sql<number>`count(*)`,
    }).from(cuentaDisponiblePagos).where(eq(cuentaDisponiblePagos.cuentaId, cuentaId));
    return { pagado: money(Number(r?.pagado)), historia: Number(r?.historia) || 0 };
  }

  /* --------------------- El puente con el cobro --------------------- */

  /**
   * UNA transferencia cae en el balde. Corre DENTRO de la transacción del
   * cobro: si algo de acá rebota, la venta entera rebota — nunca queda una
   * venta cobrada sin su pago al proveedor, ni al revés.
   *
   * El orden importa: primero el candado sobre la cuenta, después las sumas.
   * Sumar antes del candado es leer un resto que otra caja puede estar
   * gastando en este mismo momento.
   */
  async registrarPago(tx: any, p: PagoTercerizado, ctx: ContextoCobro) {
    const [c] = await tx.select().from(cuentasDisponibles)
      .where(eq(cuentasDisponibles.id, p.cuentaDisponibleId)).limit(1).for('update');
    if (!c) throw new BadRequestException('Esa cuenta disponible ya no existe: actualizá la pantalla de cobro.');
    const [prov] = await tx.select({
      nombre: proveedores.nombre, minimo: proveedores.minimoTransferencia,
      proveeMercaderia: proveedores.proveeMercaderia, proveeGastos: proveedores.proveeGastos,
    }).from(proveedores).where(eq(proveedores.id, c.proveedorId)).limit(1);
    const quien = `${prov.nombre} (${c.titular})`;

    if (c.corte) {
      throw new BadRequestException(`La cuenta de ${quien} está cortada: no recibe más transferencias.`);
    }
    const importe = money(p.importe);
    if (importe <= 0) throw new BadRequestException('El importe de la transferencia tiene que ser mayor a 0.');
    const ventaMinima = money(c.ventaMinima);
    if (ventaMinima > 0 && money(ctx.totalOperacion) < ventaMinima - EPS) {
      throw new BadRequestException(
        `La cuenta de ${quien} es solo para ventas desde $${ventaMinima.toFixed(2)} y esta es de $${money(ctx.totalOperacion).toFixed(2)}: elegí otra cuenta u otro medio.`,
      );
    }

    const { pagado } = await this.sumas(tx, c.id);
    const falta = money(c.importe - pagado);
    if (falta <= EPS) {
      throw new BadRequestException(`La cuenta de ${quien} ya está cubierta: elegí otra.`);
    }
    if (!c.puedePasarse && importe > falta + EPS) {
      throw new BadRequestException(
        `A la cuenta de ${quien} le faltan $${falta.toFixed(2)} y se están cargando $${importe.toFixed(2)}: `
        + 'no puede recibir de más. Cargá el resto en otra cuenta o en otro medio.',
      );
    }
    /* Cierra la cuenta: el resto exacto o, si puede pasarse (0177), más. */
    const cierra = importe >= falta - EPS;
    const minimo = money(Number(prov.minimo));
    if (!cierra && minimo > 0 && importe < minimo - EPS) {
      throw new BadRequestException(
        `${prov.nombre} no recibe transferencias menores a $${minimo.toFixed(2)}. `
        + `Cargá al menos ese importe, o cubrí el resto ($${falta.toFixed(2)}${c.puedePasarse ? ' o más' : ''}).`,
      );
    }

    /* El espejo en la cuenta del proveedor: un pago a cuenta, sin caja (la
     * plata no salió de ningún cajón). Sin aplicar, salvo en cuenta libre: ahí
     * va solo a lo más viejo que se le debe (27/10/2026). */
    const destino = prov.proveeGastos && !prov.proveeMercaderia ? 'gastos' : 'mercaderia';
    const [pp] = await tx.insert(proveedorPagos).values({
      proveedorId: c.proveedorId,
      medio: 'transferencia',
      importe,
      destino,
      aplicado: 0,
      concepto: `Transferencia de cliente · ${ctx.documento} · ${ctx.clienteNombre}`,
      referencia: `${c.titular} · ${c.cbuAlias}`,
      sucursalId: ctx.sucursalId ?? null,
      usuarioId: ctx.usuarioId ?? null,
      estado: 'activo',
      observaciones: '',
    }).returning({ id: proveedorPagos.id });

    await tx.insert(cuentaDisponiblePagos).values({
      cuentaId: c.id,
      importe,
      ventaPagoId: p.ventaPagoId ?? null,
      cobranzaPagoId: p.cobranzaPagoId ?? null,
      proveedorPagoId: pp.id,
      usuarioId: ctx.usuarioId ?? null,
    });
    await this.pagosProv.aplicarCuentaLibre(c.proveedorId, tx);

    return {
      referencia: `${prov.nombre} · ${c.titular} · ${c.cbuAlias}`,
      falta: Math.max(0, money(falta - importe)),
      cierra,
    };
  }

  /**
   * PAGO PROPIO (0151, 9/10/2026, pedido del dueño): Sabor y Aroma transfiere
   * desde SU cuenta a la cuenta disponible del proveedor, sin pasar por la caja.
   * Mismas reglas que una transferencia de cliente —candado, cortada, cubierta,
   * no pasarse del resto salvo la cuenta que puede (0177)— salvo el mínimo
   * del proveedor (ese es para no recibir
   * transferencias chiquitas de clientes; el dueño paga lo que decide). Lleva su
   * espejo en la cuenta corriente del proveedor, como cualquier pago.
   */
  async registrarPagoPropio(id: number, dto: PagoPropioDto, usuarioId: number | null) {
    const importe = money(dto.importe);
    if (importe <= 0) throw new BadRequestException('El importe tiene que ser mayor a 0.');
    const hoy = new Date();
    const fecha = dto.fecha ? new Date(`${dto.fecha}T12:00:00`) : hoy;
    if (dto.fecha && dto.fecha > hoy.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' })) {
      throw new BadRequestException('La fecha no puede ser futura.');
    }
    const ref = String(dto.referencia ?? '').trim();
    const obs = String(dto.observaciones ?? '').trim();
    const cuentaPropiaId = await cuentaDeTransferencia(this.db, 'transferencia', dto.cuentaPropiaId);
    await this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(cuentasDisponibles).where(eq(cuentasDisponibles.id, id)).limit(1).for('update');
      if (!c) throw new NotFoundException('Esa cuenta disponible no existe.');
      const [prov] = await tx.select({
        nombre: proveedores.nombre, proveeMercaderia: proveedores.proveeMercaderia, proveeGastos: proveedores.proveeGastos,
      }).from(proveedores).where(eq(proveedores.id, c.proveedorId)).limit(1);
      const quien = `${prov.nombre} (${c.titular})`;
      if (c.corte) throw new BadRequestException(`La cuenta de ${quien} está cortada: no recibe más pagos.`);
      const { pagado } = await this.sumas(tx, c.id);
      const falta = money(c.importe - pagado);
      if (falta <= EPS) throw new BadRequestException(`La cuenta de ${quien} ya está cubierta.`);
      if (!c.puedePasarse && importe > falta + EPS) {
        const pesos = (n: number) => `$${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        throw new BadRequestException(`A la cuenta de ${quien} le faltan ${pesos(falta)}: no se puede pagar ${pesos(importe)}. Si hace falta más, subí el importe a cubrir.`);
      }
      await exigirFueraDeConciliado(tx, c.proveedorId, fecha, 'cargar un pago');
      const [pp] = await tx.insert(proveedorPagos).values({
        fecha,
        proveedorId: c.proveedorId,
        medio: 'transferencia',
        importe,
        destino: prov.proveeGastos && !prov.proveeMercaderia ? 'gastos' : 'mercaderia',
        aplicado: 0,
        concepto: `Pago propio a la cuenta disponible · ${c.titular}`,
        referencia: `${c.titular} · ${c.cbuAlias}${ref ? ` · ${ref}` : ''}`,
        usuarioId,
        estado: 'activo',
        observaciones: obs,
        cuentaPropiaId,
      }).returning({ id: proveedorPagos.id });
      await tx.insert(cuentaDisponiblePagos).values({
        cuentaId: c.id, importe, fecha, propio: true, proveedorPagoId: pp.id, usuarioId,
        observaciones: [ref, obs].filter(Boolean).join(' · '),
      });
      await this.pagosProv.aplicarCuentaLibre(c.proveedorId, tx);
    });
    return this.get(id);
  }

  /** Anular un pago propio: con su espejo, salvo que ya esté aplicado a una factura. */
  async anularPagoPropio(pagoId: number, motivo: string) {
    const m = String(motivo ?? '').trim();
    if (m.length < 3) throw new BadRequestException('Escribí por qué se anula.');
    await this.db.transaction(async (tx) => {
      const [f] = await tx.select({ cuentaId: cuentaDisponiblePagos.cuentaId, fecha: cuentaDisponiblePagos.fecha, propio: cuentaDisponiblePagos.propio, anuladoEn: cuentaDisponiblePagos.anuladoEn })
        .from(cuentaDisponiblePagos).where(eq(cuentaDisponiblePagos.id, pagoId)).limit(1).for('update');
      if (!f) throw new NotFoundException('Ese pago no existe.');
      if (!f.propio) throw new BadRequestException('Ese pago es la transferencia de un cliente: se anula anulando su venta o su recibo.');
      if (f.anuladoEn) throw new BadRequestException('Ese pago ya está anulado.');
      const [c] = await tx.select({ proveedorId: cuentasDisponibles.proveedorId }).from(cuentasDisponibles).where(eq(cuentasDisponibles.id, f.cuentaId)).limit(1);
      await exigirFueraDeConciliado(tx, c.proveedorId, f.fecha, 'anular un pago');
      await this.anularPagos(tx, eq(cuentaDisponiblePagos.id, pagoId), m, 'Pago propio anulado');
    });
    return { ok: true };
  }

  /**
   * Los renglones "transferencia a proveedor" de una VENTA recién cobrada.
   * Además de registrar cada uno, le escribe al renglón la referencia
   * (proveedor · titular · alias) para que el detalle del ticket lo diga sin
   * tener que cruzar tablas.
   */
  async registrarDeVenta(tx: any, pagos: PagoTercerizado[], ctx: ContextoCobro) {
    for (const p of pagos) {
      const r = await this.registrarPago(tx, p, ctx);
      await tx.update(ventaPagos).set({ referencia: r.referencia }).where(eq(ventaPagos.id, p.ventaPagoId!));
    }
  }

  async registrarDeCobranza(tx: any, pagos: PagoTercerizado[], ctx: ContextoCobro) {
    for (const p of pagos) {
      const r = await this.registrarPago(tx, p, ctx);
      await tx.update(cobranzaPagos).set({ referencia: r.referencia }).where(eq(cobranzaPagos.id, p.cobranzaPagoId!));
    }
  }

  /**
   * La venta (o el recibo) se anula: sus transferencias mueren con ella, y con
   * cada una su espejo en la cuenta del proveedor. Si el espejo ya se aplicó
   * a una factura, se frena TODO: desaplicar a escondidas sería mover plata
   * de la cuenta del proveedor sin que nadie lo decida. Salvo en CUENTA LIBRE
   * (27/10/2026): ahí lo aplicó el sistema solo, y la plata que nunca llegó
   * sale de la factura sola; la otra plata sin aplicar ocupa su lugar.
   */
  private async anularPagos(tx: any, cond: any, motivo: string, como = 'Anulado con su cobro') {
    const filas = await tx.select({
      id: cuentaDisponiblePagos.id, cuentaId: cuentaDisponiblePagos.cuentaId,
      proveedorPagoId: cuentaDisponiblePagos.proveedorPagoId,
    }).from(cuentaDisponiblePagos).where(and(cond, isNull(cuentaDisponiblePagos.anuladoEn))).for('update');
    if (!filas.length) return 0;

    const libres = new Set<number>();
    for (const f of filas) {
      const [pp] = await tx.select().from(proveedorPagos)
        .where(eq(proveedorPagos.id, f.proveedorPagoId)).limit(1).for('update');
      const [cuenta] = pp ? await tx.select({ modo: proveedores.modoCuenta }).from(proveedores)
        .where(eq(proveedores.id, pp.proveedorId)).limit(1) : [];
      if (pp && pp.aplicado > EPS && cuenta?.modo === 'libre') {
        await this.pagosProv.quitarAplicaciones(tx, pp.id);
        libres.add(pp.proveedorId);
      } else if (pp && pp.aplicado > EPS) {
        const [c] = await tx.select({ titular: cuentasDisponibles.titular, proveedorId: cuentasDisponibles.proveedorId })
          .from(cuentasDisponibles).where(eq(cuentasDisponibles.id, f.cuentaId)).limit(1);
        const [prov] = await tx.select({ nombre: proveedores.nombre }).from(proveedores)
          .where(eq(proveedores.id, c.proveedorId)).limit(1);
        throw new BadRequestException(
          `El pago a la cuenta de ${prov?.nombre ?? 'proveedor'} (${c.titular}) ya está aplicado a una factura. `
          + 'Desaplicalo en Proveedores antes de anular.',
        );
      }
      if (pp && pp.estado !== 'anulado') {
        await tx.update(proveedorPagos).set({
          estado: 'anulado',
          observaciones: `${pp.observaciones ? `${pp.observaciones}\n` : ''}${como}: ${motivo}`,
        }).where(eq(proveedorPagos.id, pp.id));
      }
    }
    await tx.update(cuentaDisponiblePagos).set({ anuladoEn: new Date() })
      .where(inArray(cuentaDisponiblePagos.id, filas.map((f: any) => f.id)));
    for (const proveedorId of libres) await this.pagosProv.aplicarCuentaLibre(proveedorId, tx);
    return filas.length;
  }

  async anularDeVenta(tx: any, ventaId: number, motivo: string) {
    const ids = (await tx.select({ id: ventaPagos.id }).from(ventaPagos).where(eq(ventaPagos.ventaId, ventaId)))
      .map((x: any) => x.id);
    if (!ids.length) return 0;
    return this.anularPagos(tx, inArray(cuentaDisponiblePagos.ventaPagoId, ids), motivo);
  }

  async anularDeCobranza(tx: any, cobranzaId: number, motivo: string) {
    const ids = (await tx.select({ id: cobranzaPagos.id }).from(cobranzaPagos).where(eq(cobranzaPagos.cobranzaId, cobranzaId)))
      .map((x: any) => x.id);
    if (!ids.length) return 0;
    return this.anularPagos(tx, inArray(cuentaDisponiblePagos.cobranzaPagoId, ids), motivo);
  }

  /* ------------------------------ Pagos ------------------------------ */

  /**
   * Cada transferencia, con SU cliente y SU comprobante — lo que la app
   * anterior no tenía. Los vivos por defecto; `anulados` los suma.
   */
  async pagos(q: {
    proveedorId?: number; cuentaId?: number; desde?: string; hasta?: string; anulados?: boolean; limit?: number;
  }) {
    const cliVenta = alias(clientes, 'cli_venta');
    const cliRecibo = alias(clientes, 'cli_recibo');
    const conds: any[] = [];
    if (!q.anulados) conds.push(isNull(cuentaDisponiblePagos.anuladoEn));
    if (q.proveedorId) conds.push(eq(cuentasDisponibles.proveedorId, q.proveedorId));
    if (q.cuentaId) conds.push(eq(cuentaDisponiblePagos.cuentaId, q.cuentaId));
    if (q.desde && SOLO_FECHA.test(q.desde)) conds.push(gte(cuentaDisponiblePagos.fecha, fechaDe(q.desde)!));
    if (q.hasta && SOLO_FECHA.test(q.hasta)) conds.push(lte(cuentaDisponiblePagos.fecha, new Date(`${q.hasta}T23:59:59.999`)));

    const filas = await this.db.select({
      id: cuentaDisponiblePagos.id,
      fecha: cuentaDisponiblePagos.fecha,
      importe: cuentaDisponiblePagos.importe,
      observaciones: cuentaDisponiblePagos.observaciones,
      anuladoEn: cuentaDisponiblePagos.anuladoEn,
      propio: cuentaDisponiblePagos.propio,
      cuentaId: cuentaDisponiblePagos.cuentaId,
      proveedorId: cuentasDisponibles.proveedorId,
      proveedorNombre: proveedores.nombre,
      titular: cuentasDisponibles.titular,
      cbuAlias: cuentasDisponibles.cbuAlias,
      usuarioNombre: sql<string>`coalesce(${usuarios.nombre}, '')`,
      ventaId: ventas.id,
      ventaTipo: ventas.tipo,
      ventaPuntoVenta: ventas.puntoVenta,
      ventaNumero: ventas.numero,
      ventaCliente: cliVenta.nombre,
      cobranzaId: cobranzas.id,
      cobranzaPuntoVenta: cobranzas.puntoVenta,
      cobranzaNumero: cobranzas.numero,
      cobranzaCliente: cliRecibo.nombre,
    }).from(cuentaDisponiblePagos)
      .innerJoin(cuentasDisponibles, eq(cuentasDisponibles.id, cuentaDisponiblePagos.cuentaId))
      .innerJoin(proveedores, eq(proveedores.id, cuentasDisponibles.proveedorId))
      .leftJoin(usuarios, eq(usuarios.id, cuentaDisponiblePagos.usuarioId))
      .leftJoin(ventaPagos, eq(ventaPagos.id, cuentaDisponiblePagos.ventaPagoId))
      .leftJoin(ventas, eq(ventas.id, ventaPagos.ventaId))
      .leftJoin(cliVenta, eq(cliVenta.id, ventas.clienteId))
      .leftJoin(cobranzaPagos, eq(cobranzaPagos.id, cuentaDisponiblePagos.cobranzaPagoId))
      .leftJoin(cobranzas, eq(cobranzas.id, cobranzaPagos.cobranzaId))
      .leftJoin(cliRecibo, eq(cliRecibo.id, cobranzas.clienteId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(cuentaDisponiblePagos.fecha), desc(cuentaDisponiblePagos.id))
      .limit(Math.min(Math.max(Number(q.limit) || 500, 1), 2000));

    const lista = filas.map((f) => ({
      id: f.id, fecha: f.fecha, importe: f.importe, observaciones: f.observaciones, anuladoEn: f.anuladoEn,
      cuentaId: f.cuentaId, proveedorId: f.proveedorId, proveedorNombre: f.proveedorNombre,
      titular: f.titular, cbuAlias: f.cbuAlias, usuarioNombre: f.usuarioNombre,
      propio: f.propio,
      clienteNombre: f.propio ? 'Pago propio' : (f.ventaCliente ?? f.cobranzaCliente ?? ''),
      documento: f.propio
        ? { clase: 'propio', id: f.id, tipo: 'propio', etiqueta: 'Transferencia propia' }
        : f.ventaId
        ? { clase: 'venta', id: f.ventaId, tipo: f.ventaTipo, etiqueta: numeroDoc(f.ventaPuntoVenta!, f.ventaNumero!) }
        : f.cobranzaId
          ? { clase: 'recibo', id: f.cobranzaId, tipo: 'recibo', etiqueta: numeroDoc(f.cobranzaPuntoVenta!, f.cobranzaNumero!) }
          : null,
    }));
    const vivos = lista.filter((x) => !x.anuladoEn);
    return {
      filas: lista,
      total: vivos.length,
      totalImporte: money(vivos.reduce((a, x) => a + x.importe, 0)),
    };
  }

  /** La cuenta con su historial: lo que se le manda al proveedor. */
  async resumen(id: number) {
    const [cuenta, pagos] = await Promise.all([this.get(id), this.pagos({ cuentaId: id })]);
    return { cuenta, pagos: pagos.filas };
  }

  /* ------------------------------ Reporte ------------------------------ */

  async reporte(q: { desde?: string; hasta?: string; proveedorId?: number }) {
    const conds: any[] = [isNull(cuentaDisponiblePagos.anuladoEn)];
    if (q.desde && SOLO_FECHA.test(q.desde)) conds.push(gte(cuentaDisponiblePagos.fecha, fechaDe(q.desde)!));
    if (q.hasta && SOLO_FECHA.test(q.hasta)) conds.push(lte(cuentaDisponiblePagos.fecha, new Date(`${q.hasta}T23:59:59.999`)));
    if (q.proveedorId) conds.push(eq(cuentasDisponibles.proveedorId, q.proveedorId));

    const porProveedor = await this.db.select({
      proveedorId: proveedores.id,
      proveedorNombre: proveedores.nombre,
      n: sql<number>`count(*)`,
      monto: sql<number>`coalesce(sum(${cuentaDisponiblePagos.importe}), 0)`,
    }).from(cuentaDisponiblePagos)
      .innerJoin(cuentasDisponibles, eq(cuentasDisponibles.id, cuentaDisponiblePagos.cuentaId))
      .innerJoin(proveedores, eq(proveedores.id, cuentasDisponibles.proveedorId))
      .where(and(...conds))
      .groupBy(proveedores.id)
      .orderBy(desc(sql`sum(${cuentaDisponiblePagos.importe})`));

    const filas = porProveedor.map((r) => ({ ...r, n: Number(r.n), monto: money(Number(r.monto)) }));
    const n = filas.reduce((a, r) => a + r.n, 0);
    const total = money(filas.reduce((a, r) => a + r.monto, 0));
    return { total, n, promedio: n ? money(total / n) : 0, porProveedor: filas };
  }
}

/* ------------------------------ Controller ------------------------------ */

@Controller('cuentas-disponibles')
export class CuentasDisponiblesController {
  constructor(private readonly svc: CuentasDisponiblesService) {}

  @Get() @Permiso('proveedores.cuentas')
  listar(
    @Query('proveedorId') proveedorId?: string, @Query('estado') estado?: string,
    @Query('desde') desde?: string, @Query('hasta') hasta?: string,
  ) {
    return this.svc.listar({ proveedorId: proveedorId ? Number(proveedorId) : undefined, estado, desde, hasta });
  }

  /** La caja también las necesita: es donde se cobra. */
  @Get('para-cobrar') @Permiso('ventas.pos', 'ventas.cobranzas', 'proveedores.cuentas')
  paraCobrar() { return this.svc.paraCobrar(); }

  @Get('pagos') @Permiso('proveedores.cuentas')
  pagos(
    @Query('proveedorId') proveedorId?: string, @Query('cuentaId') cuentaId?: string,
    @Query('desde') desde?: string, @Query('hasta') hasta?: string,
    @Query('anulados') anulados?: string, @Query('limit') limit?: string,
  ) {
    return this.svc.pagos({
      proveedorId: proveedorId ? Number(proveedorId) : undefined,
      cuentaId: cuentaId ? Number(cuentaId) : undefined,
      desde, hasta, anulados: anulados === 'true', limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('reporte') @Permiso('proveedores.cuentas')
  reporte(@Query('desde') desde?: string, @Query('hasta') hasta?: string, @Query('proveedorId') proveedorId?: string) {
    return this.svc.reporte({ desde, hasta, proveedorId: proveedorId ? Number(proveedorId) : undefined });
  }

  @Get(':id') @Permiso('proveedores.cuentas')
  get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }

  @Get(':id/resumen') @Permiso('proveedores.cuentas')
  resumen(@Param('id', ParseIntPipe) id: number) { return this.svc.resumen(id); }

  @Post() @Permiso('proveedores.cuentas')
  crear(@Body() dto: CrearCuentaDto) { return this.svc.crear(dto); }

  /** Pago propio (0151): transferencia desde la cuenta de Sabor y Aroma, sin caja. */
  @Post(':id/pagos') @Permiso('proveedores.cuentas')
  pagoPropio(@Param('id', ParseIntPipe) id: number, @Body() dto: PagoPropioDto, @Auth() sesion: Sesion) {
    return this.svc.registrarPagoPropio(id, dto, sesion?.usuarioId ?? null);
  }

  @Post('pagos/:pagoId/anular') @Permiso('proveedores.cuentas')
  anularPagoPropio(@Param('pagoId', ParseIntPipe) pagoId: number, @Body() dto: AnularPagoPropioDto) {
    return this.svc.anularPagoPropio(pagoId, dto.motivo);
  }

  @Patch(':id') @Permiso('proveedores.cuentas')
  editar(@Param('id', ParseIntPipe) id: number, @Body() dto: EditarCuentaDto) { return this.svc.editar(id, dto); }

  @Delete(':id') @Permiso('proveedores.cuentas')
  borrar(@Param('id', ParseIntPipe) id: number) { return this.svc.borrar(id); }
}

@Module({
  imports: [PagosModule],
  controllers: [CuentasDisponiblesController],
  providers: [CuentasDisponiblesService],
  exports: [CuentasDisponiblesService],
})
export class CuentasDisponiblesModule {}
