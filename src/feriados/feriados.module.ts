/**
 * SISTEMA › FERIADOS (0182, 19/10/2026, pedido del dueño)
 * ============================================================================
 * Los feriados y días no laborables de Formosa Capital, y qué hace cada
 * sucursal ese día (abre o no, horario, nota). Los ven y los configuran los que
 * tienen la sección (admin y superadmin); a ellos también les llega el aviso de
 * toda la app cuando falta poco (`GET /feriados/proximos`, `DIAS_AVISO`).
 *
 * 2025 y 2026 los cargó la migración. Los años que vengan, con «Traer
 * feriados de AAAA» (`POST /feriados/importar`): ArgentinaDatos + las reglas de
 * Formosa (`reglas.ts`). Lo que ya está no se pisa: único por fecha + nombre.
 */
import {
  BadGatewayException, BadRequestException, Body, ConflictException, Controller, Delete, Get, Inject, Injectable, Module,
  NotFoundException, Param, ParseIntPipe, Post, Put, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { DRIZZLE, Database } from '../db/drizzle';
import { feriadoSucursales, feriados, sucursales } from '../db/schema';
import { hoyAr, sumarDias } from '../cafeteria/cuenta';
import { ALCANCES_FERIADO, DIAS_AVISO, TIPOS_FERIADO, type FeriadoArgentinaDatos, feriadosDelAnio } from './reglas';

const PERMISO = 'sistema.feriados';
const FUENTE = (anio: number) => `https://api.argentinadatos.com/v1/feriados/${anio}`;
/** Un día que EXISTE ('2026-02-30' no). */
const esDia = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v;
const esUnico = (e: any) => e?.code === '23505' || e?.cause?.code === '23505';
const esFk = (e: any) => e?.code === '23503' || e?.cause?.code === '23503';

class SucursalFeriadoDto {
  @IsInt() sucursalId!: number;
  @IsBoolean() abre!: boolean;
  @IsOptional() @IsString() @MaxLength(60) horario?: string;
  @IsOptional() @IsString() @MaxLength(200) nota?: string;
}
class FeriadoDto {
  @IsString() fecha!: string;
  @IsString() @MaxLength(120) nombre!: string;
  @IsIn(TIPOS_FERIADO as unknown as string[]) tipo!: string;
  @IsIn(ALCANCES_FERIADO as unknown as string[]) alcance!: string;
  @IsOptional() @IsString() @MaxLength(500) observaciones?: string;
  /** Lo que hace cada sucursal: reemplaza lo que había. La que no viene queda «sin definir». */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SucursalFeriadoDto) sucursales?: SucursalFeriadoDto[];
}
class ImportarDto {
  @IsInt() @Min(2000) @Max(2100) anio!: number;
}

@Injectable()
export class FeriadosService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Los feriados (con lo de cada sucursal) entre dos días, ordenados. Una consulta. */
  private async entre(desde: string, hasta: string) {
    return this.db.select({
      id: feriados.id, fecha: feriados.fecha, nombre: feriados.nombre, tipo: feriados.tipo, alcance: feriados.alcance,
      observaciones: feriados.observaciones,
      sucursales: sql<{ sucursalId: number; abre: boolean; horario: string; nota: string }[]>`coalesce((
        select json_agg(json_build_object('sucursalId', fs.sucursal_id, 'abre', fs.abre, 'horario', fs.horario, 'nota', fs.nota))
        from ${feriadoSucursales} fs where fs.feriado_id = ${feriados.id}), '[]'::json)`,
    }).from(feriados)
      .where(and(gte(feriados.fecha, desde), lte(feriados.fecha, hasta)))
      .orderBy(asc(feriados.fecha), asc(feriados.id));
  }

  /** Las sucursales activas: cada feriado se muestra contra todas (la que no tiene fila, «sin definir»). */
  private activas() {
    return this.db.select({ id: sucursales.id, nombre: sucursales.nombre }).from(sucursales)
      .where(eq(sucursales.activa, true)).orderBy(asc(sucursales.nombre));
  }

  async delAnio(anioIn?: string) {
    const hoy = hoyAr();
    const anio = Number(anioIn) || Number(hoy.slice(0, 4));
    const [lista, anios, sucs] = await Promise.all([
      this.entre(`${anio}-01-01`, `${anio}-12-31`),
      this.db.execute(sql`select distinct extract(year from fecha)::int as anio from feriados order by 1`),
      this.activas(),
    ]);
    return { anio, hoy, anios: ((anios as any).rows ?? anios).map((r: any) => r.anio), sucursales: sucs, feriados: lista };
  }

  /** El aviso de toda la app: los que caen de hoy a `DIAS_AVISO` días. Liviano: lo sondea el banner. */
  async proximos() {
    const hoy = hoyAr();
    const [lista, sucs] = await Promise.all([this.entre(hoy, sumarDias(hoy, DIAS_AVISO)), this.activas()]);
    return { hoy, sucursales: sucs, feriados: lista };
  }

  private validar(dto: FeriadoDto) {
    if (!esDia(dto.fecha)) throw new BadRequestException('La fecha no es un día válido.');
    const nombre = dto.nombre.trim();
    if (!nombre) throw new BadRequestException('Poné el nombre del feriado.');
    const sucs = dto.sucursales ?? [];
    if (new Set(sucs.map((x) => x.sucursalId)).size !== sucs.length) throw new BadRequestException('Una sucursal está repetida.');
    return {
      fila: { fecha: dto.fecha, nombre, tipo: dto.tipo, alcance: dto.alcance, observaciones: (dto.observaciones ?? '').trim() },
      sucs: sucs.map((x) => ({ sucursalId: x.sucursalId, abre: x.abre, horario: (x.horario ?? '').trim(), nota: (x.nota ?? '').trim() })),
    };
  }

  /** Alta (`id` null) o cambio, con lo de cada sucursal, en una transacción. */
  async guardar(id: number | null, dto: FeriadoDto, usuarioId: number | null) {
    const { fila, sucs } = this.validar(dto);
    try {
      return await this.db.transaction(async (tx) => {
        const datos = { ...fila, actualizadoEn: new Date(), actualizadoPor: usuarioId };
        const [f] = id == null
          ? await tx.insert(feriados).values(datos).returning({ id: feriados.id })
          : await tx.update(feriados).set(datos).where(eq(feriados.id, id)).returning({ id: feriados.id });
        if (!f) throw new NotFoundException('Ese feriado no existe.');
        await tx.delete(feriadoSucursales).where(eq(feriadoSucursales.feriadoId, f.id));
        if (sucs.length) await tx.insert(feriadoSucursales).values(sucs.map((x) => ({ ...x, feriadoId: f.id })));
        return { ok: true, id: f.id };
      });
    } catch (e) {
      if (esUnico(e)) throw new ConflictException(`Ya hay un feriado «${fila.nombre}» el ${fila.fecha.split('-').reverse().join('/')}.`);
      if (esFk(e)) throw new BadRequestException('Una de las sucursales no existe.');
      throw e;
    }
  }

  async borrar(id: number) {
    const [f] = await this.db.delete(feriados).where(eq(feriados.id, id)).returning({ id: feriados.id });
    if (!f) throw new NotFoundException('Ese feriado no existe.');
    return { ok: true };
  }

  /** Los nacionales de ArgentinaDatos + los de Formosa (`reglas.ts`). Lo que ya está queda como está. */
  async importar(anio: number, usuarioId: number | null) {
    let nacionales: FeriadoArgentinaDatos[];
    try {
      const r = await fetch(FUENTE(anio), { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(String(r.status));
      nacionales = await r.json();
    } catch {
      throw new BadGatewayException('No se pudo consultar los feriados nacionales (ArgentinaDatos). Probá de nuevo en un rato o cargalos a mano.');
    }
    if (!Array.isArray(nacionales) || !nacionales.length) {
      throw new BadRequestException(`Todavía no hay feriados nacionales publicados para ${anio}.`);
    }
    const lista = feriadosDelAnio(anio, nacionales);
    const nuevos = await this.db.insert(feriados)
      .values(lista.map((f) => ({ ...f, actualizadoPor: usuarioId })))
      .onConflictDoNothing({ target: [feriados.fecha, feriados.nombre] })
      .returning({ id: feriados.id });
    return { ok: true, anio, agregados: nuevos.length, yaEstaban: lista.length - nuevos.length };
  }
}

@Controller('feriados')
@Permiso(PERMISO)
export class FeriadosController {
  constructor(private readonly svc: FeriadosService) {}

  @Get() delAnio(@Query('anio') anio?: string) { return this.svc.delAnio(anio); }
  @Get('proximos') proximos() { return this.svc.proximos(); }
  @Post() crear(@Body() dto: FeriadoDto, @Auth() s: Sesion) { return this.svc.guardar(null, dto, s?.usuarioId ?? null); }
  @Post('importar') importar(@Body() dto: ImportarDto, @Auth() s: Sesion) { return this.svc.importar(dto.anio, s?.usuarioId ?? null); }
  @Put(':id') editar(@Param('id', ParseIntPipe) id: number, @Body() dto: FeriadoDto, @Auth() s: Sesion) { return this.svc.guardar(id, dto, s?.usuarioId ?? null); }
  @Delete(':id') borrar(@Param('id', ParseIntPipe) id: number) { return this.svc.borrar(id); }
}

@Module({ controllers: [FeriadosController], providers: [FeriadosService] })
export class FeriadosModule {}
