/**
 * GASTOS — lo que la empresa paga y no es mercadería
 * ============================================================================
 * Circuito completo y chico: se carga el comprobante que llegó, se imputa a una
 * categoría del plan de gastos, y se paga (de una o en partes). De ahí salen
 * las dos preguntas que el negocio hace todos los días: **qué tengo que pagar**
 * (bandeja de vencimientos) y **en qué se me va la plata** (resumen por rubro).
 *
 * Tres decisiones que valen la pena explicar:
 *
 *  1. El proveedor es el MISMO de compras. Un CUIT, una entidad. Lo que separa
 *     los dos mundos es el documento, no la persona (ver `schema.ts`).
 *  2. Pagar en efectivo desde un turno de caja abierto genera el EGRESO en esa
 *     caja, en la misma transacción. Sin eso, el dinero sale del cajón y el
 *     arqueo de la noche no cierra por un motivo que ya nadie recuerda.
 *  3. Un gasto con pagos no se anula ni se le cambian los importes: primero se
 *     revierte el pago. La plata que salió tiene que poder rastrearse siempre.
 */
import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, Injectable,
  Module, NotFoundException, Param, ParseIntPipe, Patch, Post, Query, Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { and, asc, desc, eq, gte, inArray, lte, ne, or, sql } from 'drizzle-orm';
import { mimeReal, nombreSeguro } from '../common/archivos';
import { fechaLocal } from '../common/documentos';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  gastoAdjuntos, gastoCategorias, gastos, gastoItems, gastosRecurrentes, proveedores, sucursales, usuarios,
} from '../db/schema';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { esJefe, tienePermiso } from '../auth/auth.guard';
import { PagosModule, PagosProveedorService } from '../pagos/pagos.module';

/**
 * Redondeo a dos decimales, y última red contra los números que no son números.
 *
 * `Number.isFinite` no está de adorno: `1e308` es un `number` finito que pasa
 * cualquier `@IsNumber()`, pero multiplicado por 100 desborda a `Infinity`, que
 * es truthy, sobrevive a `|| 0` y **Postgres lo acepta** en una columna
 * `double precision`. Un solo gasto así dejaba el resumen del mes y el badge
 * del sidebar en blanco. El tope de verdad lo pone `@Max(TOPE_IMPORTE)` en los
 * DTOs —ahí el que carga recibe un mensaje—; esto es el piso de abajo.
 */
const money = (n: number) => {
  const v = Number(n) * 100;
  return Number.isFinite(v) ? Math.round(v) / 100 : 0;
};

/** Mil millones de pesos en un solo renglón de gasto: no existe, y corta el desborde. */
const TOPE_IMPORTE = 1_000_000_000;

/** Igual que la bandeja de facturas: una foto de comprobante no pesa más. */
const MAX_BYTES_ADJUNTO = Math.floor(2.5 * 1024 * 1024);

/** 'AAAA-MM-DD', lo único que manda un `<input type="date">`. */
const SOLO_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * QUIÉN ENTRA A GASTOS — las claves que el catálogo declaraba y nadie exigía.
 * ============================================================================
 * Este controller no tenía NINGÚN permiso. Las siete secciones y las cuatro
 * acciones existían desde el primer día en `usuarios.module.ts`, se podían
 * tildar en la pantalla de roles… y no las leía nadie: el único filtro era el
 * sub-sidebar del dashboard, que decide qué panel dibuja. Con eso, cualquier
 * sesión —el rol Cafetería, que ve una sola pantalla— pedía `/gastos/resumen` y
 * se llevaba la estructura de costos entera de la empresa.
 *
 * `PISO` es el permiso de LECTURA del módulo: tener alguna de sus secciones.
 * Va a nivel de clase y alcanza para los catálogos que todas las pantallas
 * necesitan. Cada escritura vuelve a pedir lo suyo — y ojo con la semántica:
 * un `@Permiso` de método REEMPLAZA al de la clase, no se suman, así que cada
 * uno tiene que listar todo lo que acepta.
 *
 * `PERMISOS_PAGO` es el caso serio: los tres endpoints que terminan llamando a
 * `PagosProveedorService.crear()` generan un EGRESO DE EFECTIVO en un turno de
 * caja. Ese servicio ya estaba cerrado del lado de `PagosProveedorController`;
 * Gastos lo volvía a abrir por el costado. Las claves son las mismas de allá
 * (misma plata, mismos caminos legítimos) más la acción propia de gastos.
 */
const PISO_GASTOS = [
  'gastos.gastos', 'gastos.pagos', 'gastos.pagos_proveedor', 'gastos.fijos',
  'gastos.categorias', 'gastos.proveedores', 'gastos.resumen',
];
/** Ver un gasto: las tres secciones que lo muestran en pantalla. */
const PERMISOS_VER = ['gastos.gastos', 'gastos.pagos', 'gastos.resumen'];
/** Mover plata: crea el egreso del cajón. Espejo de `PagosProveedorController`. */
const PERMISOS_PAGO = ['gastos_pagar', 'gastos_pagar_proveedor', 'ventas.caja'];
/** Imputar: decidir contra qué documento se descuenta un pago que ya existe. */
const PERMISOS_IMPUTAR = ['gastos_imputar', 'gastos.pagos_proveedor', 'compras.pagos'];

/*
 * `fechaLocal` vive en `common/documentos`. Está compartida con Cafetería —eran
 * dos copias idénticas— porque es la trampa del `<input type="date">`: manda
 * 'AAAA-MM-DD' pelado, `new Date('2026-08-05')` lo lee como MEDIANOCHE UTC, y en
 * UTC−3 eso es el 4 a las 21:00, así que el gasto fechado el 5 se listaba el 4.
 * En dos copias, arreglar una no arreglaba la otra.
 */

/** Meses que cubre cada frecuencia: define cuándo un gasto fijo vuelve a tocar. */
const MESES_FRECUENCIA: Record<string, number> = {
  mensual: 1, bimestral: 2, trimestral: 3, semestral: 6, anual: 12,
};

const TIPOS_DOC = ['factura', 'ticket', 'recibo', 'nota_credito', 'otro'] as const;
const MEDIOS = ['efectivo', 'transferencia', 'tarjeta_debito', 'tarjeta_credito', 'cheque', 'qr', 'otro'] as const;

/* ------------------------------- DTOs ------------------------------- */

/*
 * LAS FECHAS SE VALIDAN, no se confían. `new Date('lunes')` no explota: devuelve
 * `Invalid Date`, que viaja calladito hasta que Drizzle le pide un ISO y ahí sí
 * revienta con un 500 y el stack en el log. Pagos ya lo había resuelto así; acá
 * faltaba. Lo mismo con los importes y su `@Max`: ver el comentario de `money`.
 */
/*
 * `PagoDto` va ANTES de `GastoDto` porque este lo referencia como tipo anidado:
 * `emitDecoratorMetadata` escribe el `design:type` en el momento en que la clase
 * se define, así que declararlo después explota con "Cannot access before
 * initialization" al arrancar. No es orden estético.
 */
class PagoDto {
  @IsNumber() @Min(0.01) @Max(TOPE_IMPORTE) importe!: number;
  @IsOptional() @IsIn(MEDIOS as unknown as string[]) medio?: string;
  @IsOptional() @Matches(SOLO_FECHA, { message: 'La fecha va como AAAA-MM-DD.' }) fecha?: string;
  @IsOptional() @IsString() referencia?: string;
  /** Turno de caja del que sale el efectivo (genera el egreso). */
  @IsOptional() @IsInt() cajaSesionId?: number;
  @IsOptional() @IsInt() usuarioId?: number;
}

/** Un renglón del gasto: concepto + importe FINAL, como se lee del papel. */
class GastoItemDto {
  @IsString() @MaxLength(200) concepto!: string;
  @IsNumber() @Min(0.01) @Max(TOPE_IMPORTE) monto!: number;
}

class GastoDto {
  @IsOptional() @Matches(SOLO_FECHA, { message: 'La fecha va como AAAA-MM-DD.' }) fecha?: string;
  @IsOptional() @IsIn(TIPOS_DOC as unknown as string[]) tipoDoc?: string;
  @IsOptional() @IsIn(['A', 'B', 'C', 'X']) letra?: string;
  @IsOptional() @IsString() numero?: string;
  @IsOptional() @IsInt() proveedorId?: number;
  @IsOptional() @IsString() proveedorTexto?: string;
  @IsInt() categoriaId!: number;
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsString() descripcion?: string;
  @IsOptional() @IsIn(['contado', 'cuenta_corriente']) condicionPago?: string;
  /** A qué negocio se imputa: la distribuidora (defecto) o la cafetería. */
  @IsOptional() @IsIn(['distribuidora', 'cafeteria']) negocio?: string;
  @IsOptional() @Matches(SOLO_FECHA, { message: 'El vencimiento va como AAAA-MM-DD.' }) vencimiento?: string;
  @IsOptional() @IsNumber() @Min(-TOPE_IMPORTE) @Max(TOPE_IMPORTE) neto?: number;
  @IsOptional() @IsNumber() @Min(-TOPE_IMPORTE) @Max(TOPE_IMPORTE) iva?: number;
  @IsOptional() @IsNumber() @Min(-TOPE_IMPORTE) @Max(TOPE_IMPORTE) otros?: number;
  /**
   * LOS RENGLONES (0067). Si vienen, mandan: el total es su suma, `iva` pasa a
   * ser el "IVA incluido" informativo de la factura A (neto = total − iva) y
   * la descripción se arma sola con los conceptos. Sin renglones vale el
   * camino de siempre (gastos viejos, fijos generados, API externa).
   */
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true })
  @Type(() => GastoItemDto) items?: GastoItemDto[];
  @IsOptional() @IsString() observaciones?: string;
  @IsOptional() @IsInt() usuarioId?: number;
  /**
   * Pago en el mismo acto del alta (el caso más común: se paga y se carga).
   * Si viene, se registra como primer pago del gasto — y por eso el alta exige
   * también el permiso de pagar (ver `PERMISOS_PAGO`).
   */
  @IsOptional() @ValidateNested() @Type(() => PagoDto) pagoInmediato?: PagoDto;
}

class AplicarPagoDto {
  @IsInt() pagoId!: number;
  @IsNumber() @Min(0.01) @Max(TOPE_IMPORTE) importe!: number;
  @IsOptional() @IsInt() usuarioId?: number;
}

class AnularGastoDto {
  @IsOptional() @IsString() motivo?: string;
}

class GenerarPeriodoDto {
  @Matches(/^\d{4}-\d{2}$/, { message: 'El período va como AAAA-MM (por ejemplo 2026-08).' }) periodo!: string;
  @IsOptional() @IsInt() usuarioId?: number;
  @IsOptional() @IsInt({ each: true }) ids?: number[];
}

class AdjuntoDto {
  @IsOptional() @IsString() nombre?: string;
  @IsString() data!: string;
}

/**
 * Los filtros que aceptan las TRES lecturas (listado, cuentas a pagar y
 * resumen). Uno solo y compartido: con `@Query() q: any` el `whitelist` global
 * no filtraba nada, así que cualquier cosa entraba al armado de condiciones.
 * Cada endpoint usa el subconjunto que le sirve e ignora el resto.
 */
class ConsultaGastosDto {
  @IsOptional() @Matches(SOLO_FECHA, { message: 'La fecha "desde" va como AAAA-MM-DD.' }) desde?: string;
  @IsOptional() @Matches(SOLO_FECHA, { message: 'La fecha "hasta" va como AAAA-MM-DD.' }) hasta?: string;
  @IsOptional() @Type(() => Number) @IsInt() categoriaId?: number;
  @IsOptional() @Type(() => Number) @IsInt() proveedorId?: number;
  @IsOptional() @Type(() => Number) @IsInt() sucursalId?: number;
  @IsOptional() @IsIn(['pendiente', 'pagado', 'anulado']) estado?: string;
  @IsOptional() @IsIn(['distribuidora', 'cafeteria']) negocio?: string;
  @IsOptional() @IsString() q?: string;
  @IsOptional() @Type(() => Number) @IsInt() limit?: number;
}

class CategoriaDto {
  @IsOptional() @IsString() nombre?: string;
  @IsOptional() @IsIn(['fijo', 'variable']) tipo?: string;
  @IsOptional() @IsString() descripcion?: string;
  @IsOptional() activa?: boolean;
  @IsOptional() @IsInt() orden?: number;
}

class RecurrenteDto {
  @IsOptional() @IsString() nombre?: string;
  @IsOptional() @IsInt() categoriaId?: number;
  @IsOptional() @IsInt() proveedorId?: number;
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(TOPE_IMPORTE) importeEstimado?: number;
  @IsOptional() @IsIn(['mensual', 'bimestral', 'trimestral', 'semestral', 'anual']) frecuencia?: string;
  @IsOptional() @IsInt() @Min(1) @Max(31) diaVencimiento?: number;
  @IsOptional() activo?: boolean;
  @IsOptional() @IsString() observaciones?: string;
}

/* ------------------------------- Servicio ------------------------------- */

@Injectable()
export class GastosService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    /** Los pagos NO son de Gastos: son del proveedor. Acá solo se consultan. */
    private readonly pagos: PagosProveedorService,
  ) {}

  /* ---------------- Catálogos ---------------- */

  /**
   * Todo lo chico que el módulo necesita para operar, en una sola llamada:
   * plan de gastos, proveedores (con su clasificación), sucursales, usuarios y
   * las plantillas de gastos fijos.
   *
   * PROVEEDORES, SUCURSALES Y USUARIOS van proyectados y no con `select()`
   * pelado: esto lo pide todo el que abre el módulo, y un `SELECT *` arrastra
   * cualquier columna que se agregue mañana. Rubros y plantillas sí van
   * enteros, que es lo que las dos pantallas que los administran necesitan.
   *
   * Del padrón viajan SOLO el nombre y las dos banderas, que es lo que usan los
   * selectores. La ficha completa —CUIT, condición de IVA, contacto— la pide la
   * pantalla de Proveedores por su cuenta, así queda detrás de
   * `gastos.proveedores` en vez de bajar con el arranque del módulo.
   *
   * Los gastos fijos solo viajan si el rol tiene su sección: el mismo criterio
   * que el sub-sidebar, pero del lado que manda.
   */
  async bootstrap(sesion: Sesion) {
    const verFijos = tienePermiso(sesion.permisos, ['gastos.fijos']);
    const [categorias, provs, sucs, users, recurrentes] = await Promise.all([
      this.db.select().from(gastoCategorias).orderBy(asc(gastoCategorias.orden), asc(gastoCategorias.nombre)),
      this.db.select({
        id: proveedores.id, nombre: proveedores.nombre,
        // Las dos banderas separan, en el selector, quién factura gastos de
        // quién vende mercadería. Ver el comentario de arriba sobre el resto.
        proveeMercaderia: proveedores.proveeMercaderia, proveeGastos: proveedores.proveeGastos,
        // La letra que factura (0067): el formulario de gasto la precarga al
        // elegir el proveedor. Sin ella en ESTE select el modal no la ve —
        // el selector se alimenta del bootstrap, no del padrón completo.
        letraGasto: proveedores.letraGasto,
      }).from(proveedores).orderBy(asc(proveedores.nombre)),
      this.db.select({ id: sucursales.id, nombre: sucursales.nombre })
        .from(sucursales).orderBy(asc(sucursales.id)),
      this.db.select({ id: usuarios.id, nombre: usuarios.nombre, activo: usuarios.activo }).from(usuarios),
      verFijos
        ? this.db.select().from(gastosRecurrentes).orderBy(asc(gastosRecurrentes.nombre))
        : Promise.resolve([]),
    ]);
    return { categorias, proveedores: provs, sucursales: sucs, usuarios: users, recurrentes };
  }

  listCategorias() {
    return this.db.select().from(gastoCategorias)
      .orderBy(asc(gastoCategorias.orden), asc(gastoCategorias.nombre));
  }

  async crearCategoria(dto: CategoriaDto) {
    const nombre = (dto.nombre ?? '').trim();
    if (!nombre) throw new BadRequestException('Poné el nombre del rubro.');
    const [ya] = await this.db.select().from(gastoCategorias).where(eq(gastoCategorias.nombre, nombre)).limit(1);
    if (ya) throw new BadRequestException(`Ya existe un rubro llamado "${nombre}".`);
    const [c] = await this.db.insert(gastoCategorias).values({
      nombre,
      tipo: (dto.tipo ?? 'variable') as any,
      descripcion: (dto.descripcion ?? '').trim(),
      activa: dto.activa !== false,
      orden: Number(dto.orden) || 500,
    }).returning();
    return c;
  }

  async editarCategoria(id: number, dto: CategoriaDto) {
    const [c] = await this.db.select().from(gastoCategorias).where(eq(gastoCategorias.id, id)).limit(1);
    if (!c) throw new NotFoundException('Rubro inexistente.');
    const patch: any = {};
    if (dto.nombre != null) {
      const n = String(dto.nombre).trim();
      if (!n) throw new BadRequestException('El nombre no puede quedar vacío.');
      const [otro] = await this.db.select().from(gastoCategorias)
        .where(and(eq(gastoCategorias.nombre, n), ne(gastoCategorias.id, id))).limit(1);
      if (otro) throw new BadRequestException(`Ya existe un rubro llamado "${n}".`);
      patch.nombre = n;
    }
    if (dto.tipo != null) patch.tipo = dto.tipo;
    if (dto.descripcion != null) patch.descripcion = String(dto.descripcion).trim();
    if (dto.activa != null) patch.activa = !!dto.activa;
    if (dto.orden != null) patch.orden = Number(dto.orden) || 0;
    if (Object.keys(patch).length) await this.db.update(gastoCategorias).set(patch).where(eq(gastoCategorias.id, id));
    return { ok: true };
  }

  /**
   * El rubro con gastos imputados no se borra: se DA DE BAJA. Borrarlo dejaría
   * gastos históricos apuntando al vacío y el resumen del año pasado sin
   * explicación. La baja lo saca de los selectores y nada más.
   */
  async borrarCategoria(id: number) {
    const [c] = await this.db.select().from(gastoCategorias).where(eq(gastoCategorias.id, id)).limit(1);
    if (!c) throw new NotFoundException('Rubro inexistente.');
    const [uso] = await this.db.select({ n: sql<number>`count(*)::int` }).from(gastos).where(eq(gastos.categoriaId, id));
    const [usoFijo] = await this.db.select({ n: sql<number>`count(*)::int` }).from(gastosRecurrentes)
      .where(eq(gastosRecurrentes.categoriaId, id));
    if (Number(uso?.n) > 0 || Number(usoFijo?.n) > 0) {
      throw new BadRequestException(
        `"${c.nombre}" tiene ${Number(uso?.n) || 0} gasto(s) imputados: no se borra, se da de baja para que deje de aparecer.`,
      );
    }
    await this.db.delete(gastoCategorias).where(eq(gastoCategorias.id, id));
    return { ok: true };
  }

  /* ---------------- Gastos: lectura ---------------- */

  private condiciones(q: any) {
    const conds: any[] = [];
    if (q.desde) conds.push(gte(gastos.fecha, fechaLocal(q.desde)!));
    if (q.hasta) conds.push(lte(gastos.fecha, new Date(`${String(q.hasta).slice(0, 10)}T23:59:59.999`)));
    if (q.categoriaId) conds.push(eq(gastos.categoriaId, Number(q.categoriaId)));
    if (q.proveedorId) conds.push(eq(gastos.proveedorId, Number(q.proveedorId)));
    if (q.sucursalId) conds.push(eq(gastos.sucursalId, Number(q.sucursalId)));
    if (q.estado) conds.push(eq(gastos.estado, q.estado));
    if (q.negocio) conds.push(eq(gastos.negocio, q.negocio));
    if (q.q) {
      const like = `%${String(q.q).trim()}%`;
      conds.push(or(
        sql`${gastos.descripcion} ilike ${like}`,
        sql`${gastos.numero} ilike ${like}`,
        sql`${gastos.proveedorTexto} ilike ${like}`,
        sql`${gastos.observaciones} ilike ${like}`,
      ));
    }
    return conds.length ? and(...conds) : undefined;
  }

  async list(q: any) {
    const limit = Math.min(Math.max(Number(q.limit) || 300, 1), 1000);
    return this.db.select().from(gastos)
      .where(this.condiciones(q))
      .orderBy(desc(gastos.fecha), desc(gastos.id))
      .limit(limit);
  }

  async get(id: number) {
    const [g] = await this.db.select().from(gastos).where(eq(gastos.id, id)).limit(1);
    if (!g) throw new NotFoundException('Gasto inexistente.');
    const [pagos, adjuntos, items] = await Promise.all([
      this.pagos.pagosDe({ gastoId: id }),
      // Sin `data`: los bytes se piden aparte, por su endpoint.
      this.db.select({
        id: gastoAdjuntos.id, nombre: gastoAdjuntos.nombre, mime: gastoAdjuntos.mime,
        subidoEn: gastoAdjuntos.subidoEn,
      }).from(gastoAdjuntos).where(eq(gastoAdjuntos.gastoId, id)).orderBy(asc(gastoAdjuntos.id)),
      // Los renglones (0067). Un gasto viejo no tiene: el array vacío es válido.
      this.db.select().from(gastoItems).where(eq(gastoItems.gastoId, id)).orderBy(asc(gastoItems.id)),
    ]);
    return { ...g, saldo: money(g.total - g.pagado), pagos, adjuntos, items };
  }

  /**
   * Bandeja de vencimientos: lo que falta pagar, ordenado por urgencia. `dias`
   * es negativo cuando ya venció — el frontend pinta con eso sin recalcular
   * fechas (y sin discutir con la zona horaria del navegador).
   */
  async cuentasAPagar(q: any = {}) {
    const conds: any[] = [
      ne(gastos.estado, 'anulado'),
      sql`${gastos.total} - ${gastos.pagado} > 0.009`,
    ];
    if (q.sucursalId) conds.push(eq(gastos.sucursalId, Number(q.sucursalId)));
    if (q.proveedorId) conds.push(eq(gastos.proveedorId, Number(q.proveedorId)));
    const filas = await this.db.select().from(gastos)
      .where(and(...conds))
      .orderBy(asc(sql`coalesce(${gastos.vencimiento}, ${gastos.fecha})`), asc(gastos.id));

    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    return filas.map((g) => {
      const ref = g.vencimiento ? new Date(g.vencimiento) : null;
      let dias: number | null = null;
      if (ref) {
        const d = new Date(ref); d.setHours(0, 0, 0, 0);
        dias = Math.round((d.getTime() - hoy.getTime()) / 86400000);
      }
      return { ...g, saldo: money(g.total - g.pagado), dias };
    });
  }

  /**
   * Contador para el badge del sidebar: cuántos gastos están vencidos o vencen
   * hoy. Endpoint chico a propósito — lo pollea el CRM cada 30 segundos.
   */
  async pendientes() {
    const hoy = new Date(); hoy.setHours(23, 59, 59, 999);
    const [r] = await this.db.select({
      vencidos: sql<number>`count(*) filter (where ${gastos.vencimiento} is not null and ${gastos.vencimiento} <= ${hoy.toISOString()})::int`,
      pendientes: sql<number>`count(*)::int`,
      saldo: sql<number>`coalesce(sum(${gastos.total} - ${gastos.pagado}), 0)`,
    }).from(gastos).where(and(
      ne(gastos.estado, 'anulado'),
      sql`${gastos.total} - ${gastos.pagado} > 0.009`,
    ));
    return {
      vencidos: Number(r?.vencidos) || 0,
      pendientes: Number(r?.pendientes) || 0,
      saldo: money(Number(r?.saldo) || 0),
    };
  }

  /**
   * Resumen de gerencia: en qué se va la plata. Todo agregado en la base — el
   * período puede tener miles de filas y no tiene sentido traerlas para sumar
   * en JavaScript.
   */
  async resumen(q: any) {
    const conds: any[] = [ne(gastos.estado, 'anulado')];
    if (q.desde) conds.push(gte(gastos.fecha, fechaLocal(q.desde)!));
    if (q.hasta) conds.push(lte(gastos.fecha, new Date(`${String(q.hasta).slice(0, 10)}T23:59:59.999`)));
    if (q.sucursalId) conds.push(eq(gastos.sucursalId, Number(q.sucursalId)));
    const where = and(...conds);

    const [[totales], porCategoria, porMes, porProveedor] = await Promise.all([
      this.db.select({
        cantidad: sql<number>`count(*)::int`,
        total: sql<number>`coalesce(sum(${gastos.total}), 0)`,
        neto: sql<number>`coalesce(sum(${gastos.neto}), 0)`,
        iva: sql<number>`coalesce(sum(${gastos.iva}), 0)`,
        pagado: sql<number>`coalesce(sum(${gastos.pagado}), 0)`,
      }).from(gastos).where(where),

      this.db.select({
        categoriaId: gastos.categoriaId,
        nombre: gastoCategorias.nombre,
        tipo: gastoCategorias.tipo,
        cantidad: sql<number>`count(*)::int`,
        total: sql<number>`coalesce(sum(${gastos.total}), 0)`,
      }).from(gastos)
        .innerJoin(gastoCategorias, eq(gastoCategorias.id, gastos.categoriaId))
        .where(where)
        .groupBy(gastos.categoriaId, gastoCategorias.nombre, gastoCategorias.tipo)
        .orderBy(desc(sql`sum(${gastos.total})`)),

      this.db.select({
        mes: sql<string>`to_char(${gastos.fecha}, 'YYYY-MM')`,
        total: sql<number>`coalesce(sum(${gastos.total}), 0)`,
      }).from(gastos).where(where)
        .groupBy(sql`to_char(${gastos.fecha}, 'YYYY-MM')`)
        .orderBy(asc(sql`to_char(${gastos.fecha}, 'YYYY-MM')`)),

      this.db.select({
        proveedorId: gastos.proveedorId,
        nombre: sql<string>`coalesce(${proveedores.nombre}, nullif(${gastos.proveedorTexto}, ''), 'Sin proveedor')`,
        cantidad: sql<number>`count(*)::int`,
        total: sql<number>`coalesce(sum(${gastos.total}), 0)`,
      }).from(gastos)
        .leftJoin(proveedores, eq(proveedores.id, gastos.proveedorId))
        .where(where)
        .groupBy(gastos.proveedorId, proveedores.nombre, gastos.proveedorTexto)
        .orderBy(desc(sql`sum(${gastos.total})`))
        .limit(15),
    ]);

    const cat = porCategoria.map((c) => ({ ...c, total: money(Number(c.total)) }));
    const fijos = money(cat.filter((c) => c.tipo === 'fijo').reduce((a, c) => a + c.total, 0));
    const variables = money(cat.filter((c) => c.tipo === 'variable').reduce((a, c) => a + c.total, 0));

    return {
      cantidad: Number(totales?.cantidad) || 0,
      total: money(Number(totales?.total) || 0),
      neto: money(Number(totales?.neto) || 0),
      // IVA de los gastos = crédito fiscal (lo que se descuenta del IVA ventas).
      iva: money(Number(totales?.iva) || 0),
      pagado: money(Number(totales?.pagado) || 0),
      saldo: money((Number(totales?.total) || 0) - (Number(totales?.pagado) || 0)),
      porCategoria: cat,
      porMes: porMes.map((m) => ({ ...m, total: money(Number(m.total)) })),
      porProveedor: porProveedor.map((p) => ({ ...p, total: money(Number(p.total)) })),
      porTipo: { fijos, variables },
    };
  }

  /* ---------------- Gastos: escritura ---------------- */

  private totalesDe(dto: GastoDto) {
    const neto = money(dto.neto ?? 0);
    const iva = money(dto.iva ?? 0);
    const otros = money(dto.otros ?? 0);
    return { neto, iva, otros, total: money(neto + iva + otros) };
  }

  /**
   * LOS IMPORTES DEL GASTO, con o sin renglones (0067).
   *
   * Con renglones, mandan ellos: el TOTAL es la suma de los montos (finales,
   * como se leen del papel), `iva` pasa a ser el "IVA incluido" informativo de
   * la factura A —se acota al total, porque un IVA mayor que el total es un
   * error de tipeo, no un dato—, y el neto se DERIVA (total − IVA). Así los
   * reportes que suman neto/iva siguen diciendo la verdad sin que nadie
   * cargue un desglose.
   *
   * La descripción se escribe sola con los conceptos: es lo que muestran el
   * listado, la búsqueda y el concepto del pago — todo lo que ya existía sigue
   * andando sin enterarse del cambio.
   *
   * Sin renglones vale el camino de siempre: gastos viejos al editarse, los
   * fijos generados y cualquier consumidor externo de la API.
   */
  private importesDe(dto: GastoDto) {
    const renglones = (dto.items ?? [])
      .map((i) => ({ concepto: (i.concepto ?? '').trim(), monto: money(i.monto) }))
      .filter((i) => i.concepto && i.monto > 0);
    if (!renglones.length) return { ...this.totalesDe(dto), items: null, descripcion: null };

    const total = money(renglones.reduce((a, i) => a + i.monto, 0));
    const iva = Math.min(money(dto.iva ?? 0), total);
    return {
      total,
      iva,
      neto: money(total - iva),
      otros: 0,
      items: renglones,
      descripcion: renglones.map((i) => i.concepto).join(' · '),
    };
  }

  /**
   * Guard de duplicado: cargar dos veces la misma factura es EL error clásico
   * de un módulo de gastos, y se detecta tarde (cuando el resumen del mes da
   * más de lo que da el banco). Con proveedor y número, la combinación tiene
   * que ser única.
   */
  private async chequearDuplicado(proveedorId: number | null, letra: string, numero: string, exceptoId?: number) {
    if (!proveedorId || !numero) return;
    const conds: any[] = [
      eq(gastos.proveedorId, proveedorId),
      eq(gastos.numero, numero),
      eq(gastos.letra, letra as any),
      ne(gastos.estado, 'anulado'),
    ];
    if (exceptoId) conds.push(ne(gastos.id, exceptoId));
    const [ya] = await this.db.select({ id: gastos.id }).from(gastos).where(and(...conds)).limit(1);
    if (ya) {
      throw new BadRequestException(
        `Ese comprobante ya está cargado (gasto #${ya.id}). Si es otro, revisá el número o el proveedor.`,
      );
    }
  }

  /**
   * LA SUCURSAL DEL DOCUMENTO NO LA ELIGE EL CLIENTE.
   *
   * Es a la que se le imputa el gasto: define el resumen por sucursal y, sobre
   * todo, define qué pagos lo pueden explicar. Sin esto, un cajero de Express 2
   * le colgaba $200.000 de "reparación" a Fontana y de paso creaba un documento
   * tomable por los pagos a cuenta de Fontana.
   *
   * No usa `sucursalDeOperacion()` a propósito: ahí `null` no significa nada,
   * y acá SÍ — es el gasto de toda la empresa (el alquiler de la oficina, el
   * contador). Esa opción queda para el jefe, que es el único que ve más de un
   * mostrador; el resto graba en la suya y punto.
   */
  private sucursalDelGasto(sesion: Sesion, pedida?: number | null): number | null {
    if (esJefe(sesion)) return pedida ?? null;
    return sesion.sucursalId ?? null;
  }

  async crear(dto: GastoDto, sesion: Sesion) {
    /*
     * El alta con "lo pagué y lo cargo" tildado hace salir plata del cajón, así
     * que exige TAMBIÉN el permiso de pagar. El `@Permiso` del endpoint no puede
     * expresar esto —es un OR fijo, y el pago es opcional—, así que la condición
     * se pregunta acá, que es donde se sabe si el pago viene o no.
     */
    if (dto.pagoInmediato && !tienePermiso(sesion.permisos, PERMISOS_PAGO)) {
      throw new ForbiddenException(
        'Podés cargar el gasto, pero no registrar su pago: eso saca plata de la caja y necesita permiso propio.',
      );
    }
    const [cat] = await this.db.select().from(gastoCategorias)
      .where(eq(gastoCategorias.id, Number(dto.categoriaId))).limit(1);
    if (!cat) throw new BadRequestException('Elegí el rubro al que se imputa el gasto.');

    let proveedorId: number | null = null;
    if (dto.proveedorId) {
      const [p] = await this.db.select().from(proveedores).where(eq(proveedores.id, Number(dto.proveedorId))).limit(1);
      if (!p) throw new BadRequestException('Proveedor inválido.');
      proveedorId = p.id;
    }

    const { neto, iva, otros, total, items, descripcion } = this.importesDe(dto);
    if (total <= 0) throw new BadRequestException('El importe del gasto tiene que ser mayor a 0.');

    const numero = (dto.numero ?? '').trim();
    const letra = dto.letra ?? 'B';
    await this.chequearDuplicado(proveedorId, letra, numero);

    const sucursalId = this.sucursalDelGasto(sesion, dto.sucursalId);

    const [creado] = await this.db.insert(gastos).values({
        fecha: fechaLocal(dto.fecha) ?? undefined,
        tipoDoc: (dto.tipoDoc ?? 'factura') as any,
        letra: letra as any,
        numero,
        proveedorId,
        proveedorTexto: proveedorId ? '' : (dto.proveedorTexto ?? '').trim(),
        categoriaId: cat.id,
        sucursalId,
        descripcion: descripcion ?? (dto.descripcion ?? '').trim(),
        condicionPago: (dto.condicionPago ?? 'contado') as any,
        negocio: (dto.negocio ?? 'distribuidora') as any,
        vencimiento: fechaLocal(dto.vencimiento),
        neto, iva, otros, total,
        pagado: 0,
        estado: 'pendiente',
        observaciones: (dto.observaciones ?? '').trim(),
        usuarioId: dto.usuarioId ?? null,
    }).returning();
    if (items?.length) {
      await this.db.insert(gastoItems).values(items.map((i) => ({ ...i, gastoId: creado.id })));
    }

    /*
     * "Lo pagué y lo cargo": el pago se registra como pago al proveedor y se
     * imputa a este gasto en un solo acto. Va DESPUÉS del alta y no dentro de
     * la misma transacción a propósito — si el pago falla (turno cerrado, por
     * ejemplo), el gasto queda cargado y pendiente, que es un estado válido y
     * recuperable. Perder también la carga sería peor.
     */
    if (dto.pagoInmediato) {
      // El importe viene siempre: `PagoDto.importe` es obligatorio y tiene
      // `@Min(0.01)`, así que el `|| total` que había acá era una rama muerta.
      const importePago = money(dto.pagoInmediato.importe);
      await this.pagos.crear({
        destino: 'gastos',
        proveedorId: proveedorId ?? undefined,
        importe: importePago,
        medio: dto.pagoInmediato.medio,
        fecha: dto.pagoInmediato.fecha,
        referencia: dto.pagoInmediato.referencia,
        concepto: (descripcion ?? dto.descripcion ?? '').trim() || `Gasto #${creado.id}`,
        sucursalId: sucursalId ?? undefined,
        cajaSesionId: dto.pagoInmediato.cajaSesionId,
        // `dto.usuarioId` y NO el del objeto anidado: el interceptor que pone el
        // autor solo pisa el nivel de arriba del body, así que el `usuarioId`
        // de `pagoInmediato` seguiría siendo el que mandó el cliente. El pago
        // del gasto lo firma el mismo que carga el gasto.
        usuarioId: dto.usuarioId,
        imputaciones: [{ gastoId: creado.id, importe: importePago }],
      }, sesion.sucursalId, esJefe(sesion));
    }
    return this.get(creado.id);
  }

  /**
   * Edición. Con pagos registrados solo se tocan los campos DESCRIPTIVOS: los
   * importes ya se movieron contra la caja o el banco, y cambiarlos por atrás
   * dejaría un pago mayor que su propio gasto.
   */
  async editar(id: number, dto: GastoDto, sesion: Sesion) {
    const [g] = await this.db.select().from(gastos).where(eq(gastos.id, id)).limit(1);
    if (!g) throw new NotFoundException('Gasto inexistente.');
    if (g.estado === 'anulado') throw new BadRequestException('El gasto está anulado: no se edita.');

    const patch: any = {};
    if (dto.categoriaId != null) {
      const [c] = await this.db.select().from(gastoCategorias).where(eq(gastoCategorias.id, Number(dto.categoriaId))).limit(1);
      if (!c) throw new BadRequestException('Rubro inválido.');
      patch.categoriaId = c.id;
    }
    if (dto.descripcion != null) patch.descripcion = String(dto.descripcion).trim();
    if (dto.observaciones != null) patch.observaciones = String(dto.observaciones).trim();
    if (dto.vencimiento !== undefined) patch.vencimiento = fechaLocal(dto.vencimiento);
    /*
     * MUDAR UN GASTO DE SUCURSAL ES COSA DEL JEFE — y para el resto el campo se
     * IGNORA, no se clava en la suya.
     *
     * La diferencia importa: clavarlo convertía cualquier edición inocente de un
     * no-jefe (corregir la descripción del alquiler de la oficina) en una
     * re-imputación silenciosa a su propia sucursal. Un gasto de "toda la
     * empresa" pasaba a ser de Express 2 por haberle arreglado una coma, y con
     * eso cambiaba el resumen por sucursal y cambiaba qué pagos lo pueden
     * explicar. En el ALTA sí se clava, porque ahí el documento nace.
     */
    if (dto.sucursalId !== undefined && esJefe(sesion)) patch.sucursalId = dto.sucursalId ?? null;
    // El negocio es imputación, no importe: se puede corregir aunque haya pagos.
    if (dto.negocio) patch.negocio = dto.negocio;

    const tienePagos = g.pagado > 0.009;
    if (!tienePagos) {
      if (dto.fecha) patch.fecha = fechaLocal(dto.fecha);
      if (dto.tipoDoc) patch.tipoDoc = dto.tipoDoc;
      if (dto.letra) patch.letra = dto.letra;
      if (dto.numero != null) patch.numero = String(dto.numero).trim();
      if (dto.condicionPago) patch.condicionPago = dto.condicionPago;
      if (dto.proveedorId !== undefined) {
        patch.proveedorId = dto.proveedorId ?? null;
        if (dto.proveedorId) patch.proveedorTexto = '';
      }
      if (dto.proveedorTexto != null && !patch.proveedorId) patch.proveedorTexto = String(dto.proveedorTexto).trim();
      /*
       * Con RENGLONES en la edición (0067), mandan ellos: total, IVA acotado,
       * neto derivado y la descripción rearmada — mismo criterio que el alta.
       * Se reemplazan enteros (delete + insert): los renglones no tienen
       * identidad propia que valga conservar, son el detalle del papel.
       */
      const conRenglones = this.importesDe(dto);
      if (conRenglones.items) {
        Object.assign(patch, {
          neto: conRenglones.neto, iva: conRenglones.iva, otros: conRenglones.otros,
          total: conRenglones.total, descripcion: conRenglones.descripcion,
        });
        await this.db.delete(gastoItems).where(eq(gastoItems.gastoId, id));
        await this.db.insert(gastoItems).values(conRenglones.items.map((i) => ({ ...i, gastoId: id })));
      } else if (dto.neto != null || dto.iva != null || dto.otros != null) {
        const t = this.totalesDe({
          neto: dto.neto ?? g.neto, iva: dto.iva ?? g.iva, otros: dto.otros ?? g.otros,
        } as GastoDto);
        if (t.total <= 0) throw new BadRequestException('El importe del gasto tiene que ser mayor a 0.');
        Object.assign(patch, t);
      }
      await this.chequearDuplicado(
        patch.proveedorId !== undefined ? patch.proveedorId : g.proveedorId,
        patch.letra ?? g.letra,
        patch.numero ?? g.numero,
        id,
      );
    } else if (
      dto.neto != null || dto.iva != null || dto.otros != null
      || dto.numero != null || dto.proveedorId !== undefined || dto.items != null
    ) {
      throw new BadRequestException(
        'El gasto ya tiene pagos registrados: revertí el pago antes de cambiar importes, número o proveedor.',
      );
    }

    if (Object.keys(patch).length) await this.db.update(gastos).set(patch).where(eq(gastos.id, id));
    return this.get(id);
  }

  async anular(id: number, motivo?: string) {
    const [g] = await this.db.select().from(gastos).where(eq(gastos.id, id)).limit(1);
    if (!g) throw new NotFoundException('Gasto inexistente.');
    if (g.estado === 'anulado') throw new BadRequestException('Ya está anulado.');
    if (g.pagado > 0.009) {
      throw new BadRequestException('Tiene pagos registrados: revertilos primero — la plata que salió tiene que quedar rastreable.');
    }
    const nota = (motivo ?? '').trim();
    await this.db.update(gastos).set({
      estado: 'anulado',
      observaciones: nota ? `${g.observaciones ? `${g.observaciones}\n` : ''}Anulado: ${nota}` : g.observaciones,
    }).where(eq(gastos.id, id));
    return this.get(id);
  }

  /* ------------- Pagos (delegados en Pagos a proveedores) ------------- */

  /**
   * Pagar este gasto. Crea un PAGO AL PROVEEDOR y lo imputa en el mismo acto:
   * el gasto no tiene pagos propios, tiene imputaciones de pagos que son del
   * proveedor. Ese giro es lo que habilita el circuito inverso — que la cajera
   * pague cuando llega la mercadería, sin que el documento exista todavía.
   */
  async pagar(id: number, dto: PagoDto, sesion: Sesion) {
    const [g] = await this.db.select().from(gastos).where(eq(gastos.id, id)).limit(1);
    if (!g) throw new NotFoundException('Gasto inexistente.');
    if (g.estado === 'anulado') throw new BadRequestException('El gasto está anulado.');
    const importe = money(dto.importe);
    await this.pagos.crear({
      destino: 'gastos',
      proveedorId: g.proveedorId ?? undefined,
      importe,
      medio: dto.medio,
      fecha: dto.fecha,
      referencia: dto.referencia,
      concepto: g.descripcion || `Gasto #${g.id}`,
      sucursalId: g.sucursalId ?? undefined,
      cajaSesionId: dto.cajaSesionId,
      usuarioId: dto.usuarioId,
      imputaciones: [{ gastoId: g.id, importe }],
    }, sesion.sucursalId, esJefe(sesion));
    return this.get(id);
  }

  /**
   * Aplicar a este gasto un pago que YA existe — el que la cajera registró
   * antes de que el comprobante estuviera cargado. No mueve plata: la imputa.
   */
  async aplicarPago(id: number, dto: AplicarPagoDto, sesion: Sesion) {
    await this.pagos.imputar(dto.pagoId, {
      imputaciones: [{ gastoId: id, importe: money(dto.importe) }],
      usuarioId: dto.usuarioId,
    }, esJefe(sesion));
    return this.get(id);
  }

  /* ---------------- Adjuntos (foto del comprobante) ---------------- */

  /**
   * EL MIME SALE DE LOS BYTES, no de lo que dijo el cliente.
   *
   * Este adjunto se sirve de vuelta desde `/api/...`, o sea desde EL MISMO
   * ORIGEN donde el dashboard guarda el token de sesión. Guardar el mime
   * declarado y devolverlo tal cual convertía este endpoint en alojamiento de
   * contenido arbitrario: `data:text/html;base64,<script>…</script>`, se le pasa
   * el link al administrador ("mirá el comprobante"), y el script lee la sesión
   * del `localStorage` y se la manda a otro lado. Con `image/svg+xml` es igual.
   *
   * `common/archivos.ts` ya tenía la tabla de firmas para los otros dos lugares
   * que reciben binarios (Compras y Web); este era el tercero y quedó afuera.
   */
  async subirAdjunto(gastoId: number, dto: AdjuntoDto) {
    const [g] = await this.db.select({ id: gastos.id }).from(gastos).where(eq(gastos.id, gastoId)).limit(1);
    if (!g) throw new NotFoundException('Gasto inexistente.');
    const m = /^data:([^;]+);base64,(.+)$/.exec(String(dto?.data ?? ''));
    if (!m) throw new BadRequestException('El comprobante tiene que llegar como data URL en base64.');

    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_BYTES_ADJUNTO) {
      const mb = (n: number) => (n / 1024 / 1024).toFixed(1).replace('.', ',');
      throw new BadRequestException(`El archivo pesa ${mb(buf.length)} MB y el máximo es ${mb(MAX_BYTES_ADJUNTO)} MB.`);
    }
    const real = mimeReal(buf);
    if (!real) {
      throw new BadRequestException('Ese archivo no es una foto JPG/PNG/WebP ni un PDF: no se pudo reconocer el contenido.');
    }
    if (real !== m[1]) {
      throw new BadRequestException(`El archivo dice ser ${m[1]} pero su contenido es ${real}.`);
    }

    const [a] = await this.db.insert(gastoAdjuntos).values({
      gastoId,
      nombre: nombreSeguro(String(dto?.nombre ?? ''), 'comprobante'),
      mime: real,
      // Se re-arma el base64 desde los bytes ya validados: lo que se guarda es
      // exactamente lo que se midió, sin los caracteres que el decodificador
      // ignora al leer pero que quedarían en la fila.
      data: buf.toString('base64'),
    }).returning({ id: gastoAdjuntos.id, nombre: gastoAdjuntos.nombre, mime: gastoAdjuntos.mime });
    return a;
  }

  async verAdjunto(id: number, res: Response) {
    const [a] = await this.db.select().from(gastoAdjuntos).where(eq(gastoAdjuntos.id, id)).limit(1);
    if (!a) throw new NotFoundException('Adjunto inexistente.');
    res.setHeader('Content-Type', a.mime);
    // `nosniff` cierra la otra mitad: sin él el navegador puede decidir que el
    // archivo "en realidad" es otra cosa, y el mime verificado al subir deja de
    // servir. `inline` con nombre saneado porque se mira al lado del gasto.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${nombreSeguro(a.nombre, 'comprobante')}"`);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.end(Buffer.from(a.data, 'base64'));
  }

  /**
   * El adjunto es la PRUEBA de que ese egreso existió. Una vez que hay plata
   * pagada contra el gasto, la foto del comprobante deja de ser un archivo
   * suelto y pasa a ser el respaldo de esa salida: es la misma regla que ya
   * cumplen `anular` (no anula con pagos) y `editar` (no toca importes con
   * pagos). Antes esto era un `delete` pelado que ni siquiera miraba si el
   * adjunto existía.
   */
  async borrarAdjunto(id: number) {
    const [a] = await this.db.select({ id: gastoAdjuntos.id, gastoId: gastoAdjuntos.gastoId })
      .from(gastoAdjuntos).where(eq(gastoAdjuntos.id, id)).limit(1);
    if (!a) throw new NotFoundException('Adjunto inexistente.');
    const [g] = await this.db.select({ pagado: gastos.pagado })
      .from(gastos).where(eq(gastos.id, a.gastoId)).limit(1);
    if (Number(g?.pagado) > 0.009) {
      throw new BadRequestException(
        'El gasto ya tiene pagos registrados: el comprobante es el respaldo de esa salida y no se borra. '
        + 'Revertí el pago primero.',
      );
    }
    await this.db.delete(gastoAdjuntos).where(eq(gastoAdjuntos.id, id));
    return { ok: true };
  }

  /* ---------------- Gastos fijos (recurrentes) ---------------- */

  listRecurrentes() {
    return this.db.select().from(gastosRecurrentes).orderBy(asc(gastosRecurrentes.nombre));
  }

  async crearRecurrente(dto: RecurrenteDto) {
    const nombre = (dto.nombre ?? '').trim();
    if (!nombre) throw new BadRequestException('Poné un nombre (ej.: "Alquiler del local").');
    const [c] = await this.db.select().from(gastoCategorias).where(eq(gastoCategorias.id, Number(dto.categoriaId))).limit(1);
    if (!c) throw new BadRequestException('Elegí el rubro del gasto fijo.');
    const [r] = await this.db.insert(gastosRecurrentes).values({
      nombre,
      categoriaId: c.id,
      proveedorId: dto.proveedorId ?? null,
      sucursalId: dto.sucursalId ?? null,
      importeEstimado: money(dto.importeEstimado ?? 0),
      frecuencia: (dto.frecuencia ?? 'mensual') as any,
      diaVencimiento: Math.min(Math.max(Number(dto.diaVencimiento) || 10, 1), 31),
      activo: dto.activo !== false,
      observaciones: (dto.observaciones ?? '').trim(),
    }).returning();
    return r;
  }

  async editarRecurrente(id: number, dto: RecurrenteDto) {
    const [r] = await this.db.select().from(gastosRecurrentes).where(eq(gastosRecurrentes.id, id)).limit(1);
    if (!r) throw new NotFoundException('Gasto fijo inexistente.');
    const patch: any = {};
    if (dto.nombre != null) {
      const n = String(dto.nombre).trim();
      if (!n) throw new BadRequestException('El nombre no puede quedar vacío.');
      patch.nombre = n;
    }
    if (dto.categoriaId != null) patch.categoriaId = Number(dto.categoriaId);
    if (dto.proveedorId !== undefined) patch.proveedorId = dto.proveedorId ?? null;
    if (dto.sucursalId !== undefined) patch.sucursalId = dto.sucursalId ?? null;
    if (dto.importeEstimado != null) patch.importeEstimado = money(dto.importeEstimado);
    if (dto.frecuencia != null) patch.frecuencia = dto.frecuencia;
    if (dto.diaVencimiento != null) patch.diaVencimiento = Math.min(Math.max(Number(dto.diaVencimiento) || 10, 1), 31);
    if (dto.activo != null) patch.activo = !!dto.activo;
    if (dto.observaciones != null) patch.observaciones = String(dto.observaciones).trim();
    if (Object.keys(patch).length) await this.db.update(gastosRecurrentes).set(patch).where(eq(gastosRecurrentes.id, id));
    return { ok: true };
  }

  async borrarRecurrente(id: number) {
    const [r] = await this.db.select().from(gastosRecurrentes).where(eq(gastosRecurrentes.id, id)).limit(1);
    if (!r) throw new NotFoundException('Gasto fijo inexistente.');
    // Los gastos ya generados quedan: `recurrente_id` no tiene FK justamente
    // para que borrar la plantilla no borre la historia.
    await this.db.delete(gastosRecurrentes).where(eq(gastosRecurrentes.id, id));
    return { ok: true };
  }

  /**
   * Qué gastos fijos faltan emitir en un período ('YYYY-MM'), y cuáles ya
   * están. La idempotencia se comprueba contra los GASTOS realmente emitidos
   * por cada plantilla, no contra un flag: así reintentar nunca duplica, y si
   * alguien borra el gasto generado, la plantilla vuelve a ofrecerse.
   */
  previsualizarPeriodo(periodo: string) {
    return this.calcularPeriodo(this.db, periodo, false);
  }

  /**
   * `conCandado` es lo que separa mirar de generar. La idempotencia se apoya en
   * "leo qué falta, después inserto", y esas dos mitades corrían en momentos
   * distintos: dos administradores apretando "Generar agosto" en el mismo
   * segundo leían los dos la misma lista de pendientes y los dos insertaban —
   * dos alquileres, dos internets, dos seguros del mismo mes en Cuentas a
   * Pagar, y el que no lo nota paga dos veces.
   *
   * Con el candado sobre las PLANTILLAS, el segundo pedido espera; cuando entra,
   * su lectura de gastos emitidos ya ve los del primero y no genera nada. No
   * hace falta un único en la base: el cuello es la plantilla, no el gasto.
   */
  private async calcularPeriodo(ex: any, periodo: string, conCandado: boolean) {
    const inicio = this.inicioPeriodo(periodo);
    const consulta = ex.select().from(gastosRecurrentes)
      .where(eq(gastosRecurrentes.activo, true)).orderBy(asc(gastosRecurrentes.nombre));
    const plantillas = conCandado ? await consulta.for('update') : await consulta;
    if (!plantillas.length) return { periodo, inicio, pendientes: [], emitidos: [] };

    const emitidos = await ex.select().from(gastos).where(and(
      inArray(gastos.recurrenteId, plantillas.map((p: any) => p.id)),
      ne(gastos.estado, 'anulado'),
    ));

    const pendientes: any[] = [];
    const yaEstan: any[] = [];
    for (const p of plantillas) {
      /*
       * DESDE CUÁNDO UNA EMISIÓN ANTERIOR TODAVÍA CUBRE ESTE PERÍODO. Mensual:
       * solo la de este mismo mes. Bimestral: también la del mes pasado. De ahí
       * el `meses - 1`.
       *
       * Se cuenta desde `inicio` (día 1) y no desde el fin del mes, y eso NO es
       * cosmético: `setMonth` no recorta, DESBORDA. Con el 31 de marzo, restar
       * un mes daba "31 de febrero" → 3 de marzo, o sea un límite POSTERIOR al
       * gasto recién generado (día 1). El gasto no se encontraba, la plantilla
       * volvía a ofrecerse y generar marzo dos veces creaba dos alquileres —
       * sin ninguna concurrencia de por medio, apretando el botón dos veces.
       * Desde el día 1 el desborde no existe: todos los meses tienen un día 1.
       */
      const meses = MESES_FRECUENCIA[p.frecuencia] ?? 1;
      const desde = new Date(inicio);
      desde.setMonth(desde.getMonth() - (meses - 1));
      /*
       * Y LA PUNTA DE ARRIBA, que faltaba: sin ella una emisión POSTERIOR
       * contaba como si cubriera este período. Generado septiembre, pedir julio
       * decía "ya está generado" y apuntaba al gasto de septiembre — o sea que
       * rellenar un mes viejo era imposible y el motivo no se veía por ningún
       * lado. El mes siguiente al período ya es otro período.
       */
      const hasta = new Date(inicio);
      hasta.setMonth(hasta.getMonth() + 1);
      const previo = emitidos.find((g: any) => {
        if (g.recurrenteId !== p.id) return false;
        const f = new Date(g.fecha);
        return f >= desde && f < hasta;
      });
      if (previo) yaEstan.push({ plantilla: p, gastoId: previo.id, fecha: previo.fecha });
      else pendientes.push({ plantilla: p, vencimiento: this.vencimientoDe(inicio, p.diaVencimiento) });
    }
    return { periodo, inicio, pendientes, emitidos: yaEstan };
  }

  async generarPeriodo(periodo: string, usuarioId?: number, soloIds?: number[]) {
    const creados = await this.db.transaction(async (tx) => {
      // La previa va ADENTRO y con candado: ver `calcularPeriodo`.
      const previa = await this.calcularPeriodo(tx, periodo, true);
      const aGenerar = previa.pendientes.filter(
        (x: any) => !soloIds?.length || soloIds.includes(x.plantilla.id),
      );
      if (!aGenerar.length) return [];

      const filas = aGenerar.map((x: any) => ({
        fecha: previa.inicio,
        tipoDoc: 'factura' as const,
        letra: 'B' as const,
        numero: '',
        proveedorId: x.plantilla.proveedorId,
        categoriaId: x.plantilla.categoriaId,
        sucursalId: x.plantilla.sucursalId,
        descripcion: `${x.plantilla.nombre} · ${periodo}`,
        condicionPago: 'cuenta_corriente' as const,
        vencimiento: x.vencimiento,
        // El importe es el ESTIMADO de la plantilla: queda como previsión hasta
        // que llegue la factura real y alguien la corrija.
        neto: money(x.plantilla.importeEstimado),
        iva: 0,
        otros: 0,
        total: money(x.plantilla.importeEstimado),
        estado: 'pendiente' as const,
        recurrenteId: x.plantilla.id,
        observaciones: 'Generado desde Gastos fijos. Corregí el importe cuando llegue el comprobante.',
        usuarioId: usuarioId ?? null,
      }));
      return tx.insert(gastos).values(filas).returning({ id: gastos.id });
    });
    return { creados: creados.length, periodo, gastos: creados.map((g) => g.id) };
  }

  /** 'YYYY-MM' → el primer instante de ese mes. */
  private inicioPeriodo(periodo: string) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(periodo ?? '').trim());
    if (!m) throw new BadRequestException('El período se indica como AAAA-MM (por ejemplo 2026-08).');
    const anio = Number(m[1]);
    const mes = Number(m[2]);
    if (mes < 1 || mes > 12) throw new BadRequestException('Mes inválido.');
    return new Date(anio, mes - 1, 1, 0, 0, 0, 0);
  }

  /** Día de vencimiento dentro del mes, recortado al último día real (31 → 28/30). */
  private vencimientoDe(inicioMes: Date, dia: number) {
    const ultimo = new Date(inicioMes.getFullYear(), inicioMes.getMonth() + 1, 0).getDate();
    return new Date(inicioMes.getFullYear(), inicioMes.getMonth(), Math.min(dia, ultimo), 0, 0, 0, 0);
  }
}

/* ------------------------------- Controller ------------------------------- */

/**
 * El `@Permiso` de la clase es el PISO de lectura (ver `PISO_GASTOS`). Cada
 * método que escribe vuelve a declarar el suyo, y como el de método reemplaza
 * al de clase, cada uno lista todo lo que acepta — no hereda nada.
 */
@Controller('gastos')
@Permiso(...PISO_GASTOS)
export class GastosController {
  constructor(private readonly svc: GastosService) {}

  /* Las rutas fijas van ANTES de `:id`: Nest resuelve por orden de declaración. */
  @Get('bootstrap') bootstrap(@Auth() auth: Sesion) { return this.svc.bootstrap(auth); }
  @Get('pendientes') @Permiso('gastos.gastos', 'gastos.pagos') pendientes() {
    return this.svc.pendientes();
  }
  @Get('cuentas-a-pagar') @Permiso('gastos.pagos') cuentas(@Query() q: ConsultaGastosDto) {
    return this.svc.cuentasAPagar(q ?? {});
  }
  @Get('resumen') @Permiso('gastos.resumen') resumen(@Query() q: ConsultaGastosDto) {
    return this.svc.resumen(q ?? {});
  }

  // Leer el plan de rubros lo necesita cualquier pantalla del módulo (el
  // selector del formulario); ADMINISTRARLO es su propia sección.
  @Get('categorias') categorias() { return this.svc.listCategorias(); }
  @Post('categorias') @Permiso('gastos.categorias') crearCategoria(@Body() dto: CategoriaDto) {
    return this.svc.crearCategoria(dto);
  }
  @Patch('categorias/:id') @Permiso('gastos.categorias') editarCategoria(
    @Param('id', ParseIntPipe) id: number, @Body() dto: CategoriaDto,
  ) {
    return this.svc.editarCategoria(id, dto);
  }
  @Delete('categorias/:id') @Permiso('gastos.categorias') borrarCategoria(@Param('id', ParseIntPipe) id: number) {
    return this.svc.borrarCategoria(id);
  }

  @Get('recurrentes') @Permiso('gastos.fijos') recurrentes() { return this.svc.listRecurrentes(); }
  @Post('recurrentes') @Permiso('gastos.fijos') crearRecurrente(@Body() dto: RecurrenteDto) {
    return this.svc.crearRecurrente(dto);
  }
  @Patch('recurrentes/:id') @Permiso('gastos.fijos') editarRecurrente(
    @Param('id', ParseIntPipe) id: number, @Body() dto: RecurrenteDto,
  ) {
    return this.svc.editarRecurrente(id, dto);
  }
  @Delete('recurrentes/:id') @Permiso('gastos.fijos') borrarRecurrente(@Param('id', ParseIntPipe) id: number) {
    return this.svc.borrarRecurrente(id);
  }
  @Get('recurrentes/periodo/:periodo') @Permiso('gastos.fijos') previa(@Param('periodo') periodo: string) {
    return this.svc.previsualizarPeriodo(periodo);
  }
  @Post('recurrentes/generar') @Permiso('gastos.fijos') generar(@Body() dto: GenerarPeriodoDto) {
    return this.svc.generarPeriodo(dto.periodo, dto.usuarioId, dto.ids);
  }

  @Get('adjuntos/:id') @Permiso(...PERMISOS_VER) adjunto(
    @Param('id', ParseIntPipe) id: number, @Res() res: Response,
  ) {
    return this.svc.verAdjunto(id, res);
  }
  @Delete('adjuntos/:id') @Permiso('gastos.gastos') borrarAdjunto(@Param('id', ParseIntPipe) id: number) {
    return this.svc.borrarAdjunto(id);
  }

  @Get() @Permiso(...PERMISOS_VER) list(@Query() q: ConsultaGastosDto) { return this.svc.list(q ?? {}); }
  /*
   * La SESIÓN entera y no solo su sucursal: acá se decide a qué sucursal se
   * imputa el gasto (jefe elige, el resto graba en la suya) y, si viene con
   * "lo pagué y lo cargo" tildado, si esta persona puede además sacar plata
   * del cajón. Las dos cosas se resuelven adentro, con la sesión a mano.
   */
  @Post() @Permiso('gastos.gastos') crear(@Body() dto: GastoDto, @Auth() auth: Sesion) {
    return this.svc.crear(dto, auth);
  }

  @Get(':id') @Permiso(...PERMISOS_VER) get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }
  @Patch(':id') @Permiso('gastos.gastos') editar(
    @Param('id', ParseIntPipe) id: number, @Body() dto: GastoDto, @Auth() auth: Sesion,
  ) {
    return this.svc.editar(id, dto, auth);
  }
  @Post(':id/anular') @Permiso('gastos_anular') anular(
    @Param('id', ParseIntPipe) id: number, @Body() dto: AnularGastoDto,
  ) {
    return this.svc.anular(id, dto?.motivo);
  }
  /** Sale plata del cajón: mismas claves que `PagosProveedorController`. */
  @Post(':id/pagos') @Permiso(...PERMISOS_PAGO) pagar(
    @Param('id', ParseIntPipe) id: number, @Body() dto: PagoDto, @Auth() auth: Sesion,
  ) {
    return this.svc.pagar(id, dto, auth);
  }
  /** Usar un pago a cuenta que ya existe. Quitarlo se hace desde Pagos. */
  @Post(':id/aplicar-pago') @Permiso(...PERMISOS_IMPUTAR) aplicarPago(
    @Param('id', ParseIntPipe) id: number, @Body() dto: AplicarPagoDto, @Auth() auth: Sesion,
  ) {
    return this.svc.aplicarPago(id, dto, auth);
  }
  @Post(':id/adjuntos') @Permiso('gastos.gastos') subir(
    @Param('id', ParseIntPipe) id: number, @Body() dto: AdjuntoDto,
  ) {
    return this.svc.subirAdjunto(id, dto);
  }
}

@Module({
  imports: [PagosModule],
  controllers: [GastosController],
  providers: [GastosService],
  exports: [GastosService],
})
export class GastosModule {}
