/**
 * HISTORIAL DE FRACCIONAMIENTO Y OPERADORES (0102)
 * ============================================================================
 * Lo que se escribe vive en el motor (`InventarioService.registrarFraccionamiento`,
 * dentro de la transacción que mueve el stock). Acá solo se LEE y se administra
 * la lista de operadores.
 *
 * EL REGISTRO ES UN COMPROBANTE: cabecera (cuándo, dónde, quién) y renglones
 * (producto, tamaño, paquetes). Los filtros se reparten igual:
 *   · de cabecera — fechas, sucursal, operador, tipo: van contra el registro,
 *     y cada uno tiene su índice.
 *   · de renglón — producto, categoría, texto, gramaje: la página los pide
 *     con EXISTS (el registro aparece una vez aunque coincidan dos renglones)
 *     y los totales los aplican a los renglones mismos, así que "paquetes de
 *     yerba" suma SOLO la yerba aunque el registro traiga también azúcar.
 *
 * COSTO. Nada de esto viaja en el bootstrap: la pantalla lo pide cuando se abre
 * la pestaña. Página y totales salen en paralelo, y los renglones de la página
 * en una sola consulta más. SQL escrito a mano a propósito: es lo que permite
 * ver qué índice usa cada consulta y cruzar con productos SOLO si el filtro lo
 * pide.
 */
import {
  BadRequestException, Body, Controller, Get, Inject, Injectable, Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { and, asc, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { Auth, Permiso, Sesion } from '../auth/auth.decoradores';
import { soloSuSucursal } from '../auth/auth.guard';
import { DRIZZLE, Database } from '../db/drizzle';
import { fraccionOperadores, sucursales } from '../db/schema';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const ORIGENES = ['manual', 'correccion', 'pedido'] as const;
/** Tope de la exportación: más que esto es un rango de fechas mal elegido. */
const MAX_EXPORT = 20_000;
/** Dos tamaños a menos de un miligramo son el mismo paquete. */
const EPS_KG = 1e-6;

class FiltrosDto {
  @IsOptional() @Matches(FECHA) desde?: string;
  @IsOptional() @Matches(FECHA) hasta?: string;
  @IsOptional() @Type(() => Number) @IsInt() sucursalId?: number;
  /** Un id, o `sin` para los que no tienen operador. */
  @IsOptional() @IsString() @MaxLength(12) operadorId?: string;
  @IsOptional() @Type(() => Number) @IsInt() productoId?: number;
  @IsOptional() @Type(() => Number) @IsInt() categoriaId?: number;
  @IsOptional() @IsIn(ORIGENES as unknown as string[]) origen?: string;
  @IsOptional() @IsIn(['manana', 'tarde']) turno?: string;
  @IsOptional() @Type(() => Number) @Min(0.000001) @Max(1000) tamKg?: number;
  @IsOptional() @IsString() @MaxLength(80) q?: string;
}

class ListadoDto extends FiltrosDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

class OperadorDto {
  @IsString() @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1) @MaxLength(60) nombre!: string;
  @IsOptional() @IsInt() sucursalId?: number | null;
}

class EditarOperadorDto {
  @IsOptional() @IsString() @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1) @MaxLength(60) nombre?: string;
  @IsOptional() @IsInt() sucursalId?: number | null;
  @IsOptional() @IsBoolean() activo?: boolean;
}

/* El formato ya lo validó el DTO; esto ataja el día imposible ("2026-13-45"),
 * que pasa la expresión y llegaría a la base como fecha inválida. */
function dia(s: string | undefined, hora: string) {
  if (!s) return null;
  const d = new Date(`${s}T${hora}`);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`La fecha ${s} no existe.`);
  return d;
}
const n3 = (v: unknown) => Math.round((Number(v) || 0) * 1000) / 1000;
const y = (partes: SQL[]) => (partes.length ? sql.join(partes, sql` and `) : sql`true`);

@Injectable()
export class FraccionamientosService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /* Las fechas se piden con `to_json`: salen en ISO 8601, que lee cualquier
   * navegador. El texto crudo de Postgres ("2026-09-22 08:00:00-03") lo lee
   * Chrome pero no todos. */
  private async filas<T>(q: SQL): Promise<T[]> {
    const r: any = await this.db.execute(q);
    return (r.rows ?? r) as T[];
  }

  /**
   * Alias fijos: `f` el registro, `fi` el renglón, `fp`/`fm` el producto y su
   * marca (solo se cruzan si el filtro los necesita).
   */
  private condiciones(q: FiltrosDto) {
    const cab: SQL[] = [];
    const d = dia(q.desde, '00:00:00'); if (d) cab.push(sql`f.fecha >= ${d}`);
    const h = dia(q.hasta, '23:59:59.999'); if (h) cab.push(sql`f.fecha <= ${h}`);
    if (q.sucursalId) cab.push(sql`f.sucursal_id = ${q.sucursalId}`);
    if (q.operadorId === 'sin') cab.push(sql`f.operador_id is null`);
    else if (q.operadorId) {
      const id = Number(q.operadorId);
      if (!Number.isInteger(id) || id <= 0) throw new BadRequestException('Operador inválido.');
      cab.push(sql`f.operador_id = ${id}`);
    }
    if (q.origen) cab.push(sql`f.origen = ${q.origen}`);
    if (q.turno) cab.push(sql`f.turno = ${q.turno}`);

    const ren: SQL[] = [];
    if (q.productoId) ren.push(sql`fi.producto_id = ${q.productoId}`);
    if (q.tamKg) ren.push(sql`abs(fi.tam_kg - ${q.tamKg}) < ${EPS_KG}`);
    const conProducto = !!(q.categoriaId || (q.q ?? '').trim());
    const conMarca = !!(q.q ?? '').trim();
    if (q.categoriaId) ren.push(sql`fp.categoria_id = ${q.categoriaId}`);
    const texto = (q.q ?? '').trim();
    if (texto) {
      const patron = `%${texto.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      ren.push(sql`(fp.nombre ilike ${patron} or fm.nombre ilike ${patron})`);
    }
    const cruces = sql.join([
      ...(conProducto ? [sql`left join productos fp on fp.id = fi.producto_id`] : []),
      ...(conMarca ? [sql`left join marcas fm on fm.id = fp.marca_id`] : []),
    ], sql` `);
    return { cab, ren, cruces };
  }

  async listado(q: ListadoDto) {
    const { cab, ren, cruces } = this.condiciones(q);
    const limit = q.limit ?? 20;
    const offset = q.offset ?? 0;
    const dondePagina = ren.length
      ? y([...cab, sql`exists (select 1 from fraccionamiento_items fi ${cruces} where fi.fraccionamiento_id = f.id and ${y(ren)})`])
      : y(cab);
    /* Los totales salen de los renglones, con los filtros de renglón aplicados
     * a cada uno. Agrupados por (operador, tipo): alcanza para las tarjetas, el
     * reparto por operador y el total del paginado — cada registro tiene un
     * solo operador y un solo tipo, así que los conteos se suman sin doblar. */
    const dondeTotales = y([...cab, ...ren]);

    const [pagina, grupos, gramajes] = await Promise.all([
      this.filas<any>(sql`
        select f.id, to_json(f.fecha) as fecha, f.turno, to_json(f.registrado_en) as "registradoEn",
               (f.registrado_en <> f.fecha) as diferido,
               f.origen, f.kg, f.paquetes, f.motivo,
               f.sucursal_id as "sucursalId", f.operador_id as "operadorId", f.transferencia_id as "transferenciaId",
               s.nombre as "sucursalNombre", o.nombre as "operadorNombre", u.nombre as "usuarioNombre",
               t.codigo as "transferenciaCodigo"
        from fraccionamientos f
        left join sucursales s on s.id = f.sucursal_id
        left join fraccion_operadores o on o.id = f.operador_id
        left join usuarios u on u.id = f.usuario_id
        left join transferencias t on t.id = f.transferencia_id
        where ${dondePagina}
        order by f.fecha desc, f.id desc
        limit ${limit} offset ${offset}`),
      this.filas<any>(sql`
        select f.operador_id as "operadorId", o.nombre as "operadorNombre", f.origen,
               count(distinct f.id)::int as registros,
               coalesce(sum(fi.paquetes), 0)::int as paquetes,
               coalesce(sum(fi.paquetes * fi.tam_kg), 0)::float8 as kg
        from fraccionamiento_items fi
        join fraccionamientos f on f.id = fi.fraccionamiento_id
        left join fraccion_operadores o on o.id = f.operador_id
        ${cruces}
        where ${dondeTotales}
        group by f.operador_id, o.nombre, f.origen`),
      this.filas<any>(sql`
        select fi.tam_kg::float8 as "tamKg", count(distinct f.id)::int as registros, coalesce(sum(fi.paquetes), 0)::int as paquetes
        from fraccionamiento_items fi
        join fraccionamientos f on f.id = fi.fraccionamiento_id
        ${cruces}
        where ${dondeTotales}
        group by fi.tam_kg
        order by fi.tam_kg desc`),
    ]);

    /* Los renglones de la página, con el nombre del producto: una consulta. */
    const ids: number[] = pagina.map((f) => f.id);
    const renglones = ids.length
      ? await this.filas<any>(sql`
          select fi.fraccionamiento_id as "registroId", fi.producto_id as "productoId",
                 p.nombre as "productoNombre", m.nombre as "marcaNombre",
                 fi.tam_kg::float8 as "tamKg", fi.paquetes
          from fraccionamiento_items fi
          left join productos p on p.id = fi.producto_id
          left join marcas m on m.id = p.marca_id
          where fi.fraccionamiento_id in ${ids}
          order by fi.fraccionamiento_id, p.nombre, fi.tam_kg desc`)
      : [];
    type Prod = { productoId: number | null; nombre: string | null; marca: string | null; items: { tamKg: number; paquetes: number }[] };
    const porRegistro = new Map<number, Prod[]>();
    for (const r of renglones) {
      const lista = porRegistro.get(r.registroId) ?? [];
      let p = lista.find((x) => x.productoId === r.productoId);
      if (!p) { p = { productoId: r.productoId, nombre: r.productoNombre, marca: r.marcaNombre, items: [] }; lista.push(p); }
      p.items.push({ tamKg: r.tamKg, paquetes: r.paquetes });
      porRegistro.set(r.registroId, lista);
    }

    const totales = { registros: 0, paquetes: 0, kg: 0, correcciones: 0, pedidos: 0, sinOperador: 0 };
    const operadores = new Map<string, { operadorId: number | null; nombre: string; registros: number; paquetes: number; kg: number }>();
    for (const g of grupos) {
      totales.registros += g.registros;
      totales.paquetes += g.paquetes;
      totales.kg += Number(g.kg) || 0;
      if (g.origen === 'correccion') totales.correcciones += g.registros;
      if (g.origen === 'pedido') totales.pedidos += g.registros;
      if (g.operadorId == null) totales.sinOperador += g.registros;
      const k = String(g.operadorId ?? 'sin');
      const o = operadores.get(k) ?? { operadorId: g.operadorId, nombre: g.operadorNombre ?? 'Sin operador', registros: 0, paquetes: 0, kg: 0 };
      o.registros += g.registros;
      o.paquetes += g.paquetes;
      o.kg += Number(g.kg) || 0;
      operadores.set(k, o);
    }

    return {
      filas: pagina.map((f) => ({ ...f, kg: n3(f.kg), productos: porRegistro.get(f.id) ?? [] })),
      total: totales.registros,
      paginado: { offset, limit },
      totales: { ...totales, kg: n3(totales.kg) },
      porOperador: [...operadores.values()]
        .map((o) => ({ ...o, kg: n3(o.kg) }))
        .sort((a, b) => b.kg - a.kg || a.nombre.localeCompare(b.nombre)),
      porGramaje: gramajes,
    };
  }

  /**
   * Para el CSV: UNA FILA POR RENGLÓN (producto y tamaño), no por registro —
   * es lo que se puede sumar y cruzar en una planilla.
   */
  async exportar(q: FiltrosDto) {
    const { cab, ren } = this.condiciones(q);
    const filas = await this.filas<any>(sql`
      select f.id as "registroId", to_json(f.fecha) as fecha, f.turno, to_json(f.registrado_en) as "registradoEn",
             (f.registrado_en <> f.fecha) as diferido, f.origen, f.motivo,
             fi.tam_kg::float8 as "tamKg", fi.paquetes,
             fp.nombre as "productoNombre", fp.codigo_propio as "codigoPropio",
             fm.nombre as "marcaNombre", c.nombre as "categoriaNombre",
             s.nombre as "sucursalNombre", o.nombre as "operadorNombre", u.nombre as "usuarioNombre",
             t.codigo as "transferenciaCodigo"
      from fraccionamiento_items fi
      join fraccionamientos f on f.id = fi.fraccionamiento_id
      left join productos fp on fp.id = fi.producto_id
      left join marcas fm on fm.id = fp.marca_id
      left join categorias c on c.id = fp.categoria_id
      left join sucursales s on s.id = f.sucursal_id
      left join fraccion_operadores o on o.id = f.operador_id
      left join usuarios u on u.id = f.usuario_id
      left join transferencias t on t.id = f.transferencia_id
      where ${y([...cab, ...ren])}
      order by f.fecha desc, f.id desc, fp.nombre, fi.tam_kg desc
      limit ${MAX_EXPORT + 1}`);
    if (filas.length > MAX_EXPORT) {
      throw new BadRequestException(`Son más de ${MAX_EXPORT.toLocaleString('es-AR')} renglones: acotá las fechas y exportá por partes.`);
    }
    return filas.map((f) => ({ ...f, kg: n3(f.paquetes * f.tamKg) }));
  }

  /* ------------------------------ Operadores ------------------------------ */

  /**
   * `soloSuc` (26/9/2026): quien no es jefe ve los operadores que pueden
   * trabajar en SU sucursal (los de ella y los de todas). Antes llegaban los
   * de todas las sucursales, y se podía elegir a alguien que el registro
   * después rechazaba con "no fracciona en esta sucursal".
   */
  operadores(todos: boolean, soloSuc: number | null = null) {
    const O = fraccionOperadores;
    return this.db.select({ id: O.id, nombre: O.nombre, sucursalId: O.sucursalId, activo: O.activo })
      .from(O)
      .where(and(
        todos ? undefined : eq(O.activo, true),
        soloSuc == null ? undefined : or(isNull(O.sucursalId), eq(O.sucursalId, soloSuc)),
      ))
      .orderBy(desc(O.activo), asc(O.nombre));
  }

  private async nombreLibre(nombre: string, salvoId?: number) {
    const O = fraccionOperadores;
    const [otro] = await this.db.select({ id: O.id, activo: O.activo }).from(O)
      .where(sql`lower(btrim(${O.nombre})) = lower(${nombre})`).limit(1);
    if (otro && otro.id !== salvoId) {
      throw new BadRequestException(otro.activo
        ? `Ya hay un operador llamado ${nombre}.`
        : `Ya hay un operador llamado ${nombre}, dado de baja: reactivalo en vez de crear otro.`);
    }
  }

  private async sucursalValida(id: number | null | undefined) {
    if (id == null) return;
    const [s] = await this.db.select({ id: sucursales.id }).from(sucursales).where(eq(sucursales.id, id)).limit(1);
    if (!s) throw new BadRequestException('Esa sucursal no existe.');
  }

  async crearOperador(dto: OperadorDto) {
    await Promise.all([this.nombreLibre(dto.nombre), this.sucursalValida(dto.sucursalId)]);
    const [op] = await this.db.insert(fraccionOperadores)
      .values({ nombre: dto.nombre, sucursalId: dto.sucursalId ?? null })
      .returning();
    return op;
  }

  async editarOperador(id: number, dto: EditarOperadorDto) {
    const patch: Record<string, unknown> = {};
    if (dto.nombre !== undefined) { await this.nombreLibre(dto.nombre, id); patch.nombre = dto.nombre; }
    if (dto.sucursalId !== undefined) { await this.sucursalValida(dto.sucursalId); patch.sucursalId = dto.sucursalId; }
    if (dto.activo !== undefined) patch.activo = dto.activo;
    if (!Object.keys(patch).length) throw new BadRequestException('No hay nada para cambiar.');
    const [op] = await this.db.update(fraccionOperadores).set(patch).where(eq(fraccionOperadores.id, id)).returning();
    if (!op) throw new BadRequestException('Ese operador no existe.');
    return op;
  }
}

@Controller('fraccionamientos')
export class FraccionamientosController {
  constructor(private readonly svc: FraccionamientosService) {}

  /** El que no es jefe ve lo de SU local, como en Movimientos. */
  private acotar<T extends FiltrosDto>(q: T, sesion: Sesion): T {
    const mia = soloSuSucursal(sesion);
    return mia != null ? { ...q, sucursalId: mia } : q;
  }

  @Get()
  @Permiso('almacen.fraccionamiento')
  listado(@Query() q: ListadoDto, @Auth() sesion: Sesion) {
    return this.svc.listado(this.acotar(q, sesion));
  }

  @Get('exportar')
  @Permiso('almacen.fraccionamiento')
  exportar(@Query() q: FiltrosDto, @Auth() sesion: Sesion) {
    return this.svc.exportar(this.acotar(q, sesion));
  }

  /** Los activos para elegir al fraccionar; `todos=1` suma los dados de baja (el filtro del historial y el ABM). */
  @Get('operadores')
  @Permiso('almacen.fraccionamiento', 'fraccionar')
  operadores(@Auth() sesion: Sesion, @Query('todos') todos?: string) {
    return this.svc.operadores(todos === '1', soloSuSucursal(sesion));
  }

  @Post('operadores')
  @Permiso('fraccion_operadores')
  crearOperador(@Body() dto: OperadorDto) {
    return this.svc.crearOperador(dto);
  }

  @Patch('operadores/:id')
  @Permiso('fraccion_operadores')
  editarOperador(@Param('id', ParseIntPipe) id: number, @Body() dto: EditarOperadorDto) {
    return this.svc.editarOperador(id, dto);
  }
}
