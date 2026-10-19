/**
 * TIENDA MINORISTA › BARRIOS Y ENVÍO (0185, 19/10/2026, pedido del dueño)
 * ============================================================================
 * Los barrios que el dueño dibuja en Tienda online › Configuración › Tienda
 * minorista (de a uno, cuando hace falta), con su costo de envío, y las promos
 * por barrio («Envío gratis a Independencia los martes»). La cuenta vive en
 * `reglas.ts`; acá, guardar y leer. La tienda pregunta con `condicionesPara`
 * (cotización del checkout y alta del pedido) y `avisosDeHoy` (la portada).
 */
import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, Inject, Injectable, Module, NotFoundException,
  Param, ParseIntPipe, Post, Put,
} from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { Permiso } from '../../auth/auth.decoradores';
import { DRIZZLE, Database } from '../../db/drizzle';
import { barrioPromos, barrios } from '../../db/schema';
import { hoyAr } from '../../cafeteria/cuenta';
import {
  MAX_PUNTOS, MIN_PUNTOS, TIPOS_PROMO, barrioDe, condiciones, describirPromo, poligonoValido, vigente,
  type Barrio, type Punto, type PromoBarrio, type TipoPromo,
} from './reglas';

const esUnico = (e: any) => e?.code === '23505' || e?.cause?.code === '23505';
/** Un día que EXISTE ('2026-02-30' no). */
const esDia = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v;

class BarrioDto {
  @IsString() @MaxLength(60) nombre!: string;
  @IsArray() @ArrayMinSize(MIN_PUNTOS) @ArrayMaxSize(MAX_PUNTOS) poligono!: [number, number][];
  /** null = sin costo propio (se coordina, o la regla general de «gratis desde»). */
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000) costoEnvio?: number | null;
  @IsBoolean() activo!: boolean;
}
class PromoDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsInt({ each: true }) barrioIds!: number[];
  @IsIn(TIPOS_PROMO as unknown as string[]) tipo!: TipoPromo;
  @IsNumber() @Min(0) @Max(10_000_000) valor!: number;
  @IsArray() @ArrayMaxSize(7) @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) dias!: number[];
  @IsOptional() @IsString() desde?: string | null;
  @IsOptional() @IsString() hasta?: string | null;
  @IsNumber() @Min(0) @Max(100_000_000) minimo!: number;
  @IsBoolean() activa!: boolean;
}

/** Fila de la base → la forma de las reglas. */
const comoPromo = (p: typeof barrioPromos.$inferSelect): PromoBarrio => ({
  id: p.id, barrioIds: p.barrioIds, tipo: p.tipo as TipoPromo, valor: p.valor, dias: p.dias,
  desde: p.desde, hasta: p.hasta, minimo: p.minimo, activa: p.activa,
});

@Injectable()
export class BarriosService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Todo, para la pantalla del ERP: cada promo con su texto, el mismo que ve el cliente. */
  async listar() {
    const [bs, ps] = await Promise.all([
      this.db.select().from(barrios).orderBy(asc(barrios.nombre)),
      this.db.select().from(barrioPromos).orderBy(asc(barrioPromos.id)),
    ]);
    const nombreDe = new Map(bs.map((b) => [b.id, b.nombre]));
    return { barrios: bs, promos: ps.map((p) => ({ ...comoPromo(p), texto: describirPromo(comoPromo(p), nombreDe) })) };
  }

  /** Lo que rige para la tienda: los barrios activos y las promos activas. Dos tablas chicas, dos consultas. */
  private async vigentes() {
    const [bs, ps] = await Promise.all([
      this.db.select().from(barrios).where(eq(barrios.activo, true)).orderBy(asc(barrios.id)),
      this.db.select().from(barrioPromos).where(eq(barrioPromos.activa, true)),
    ]);
    const lista: Barrio[] = bs.map((b) => ({ id: b.id, nombre: b.nombre, poligono: b.poligono, costoEnvio: b.costoEnvio }));
    return { barrios: lista, promos: ps.map(comoPromo), nombreDe: new Map(lista.map((b) => [b.id, b.nombre])) };
  }

  /** El barrio de un punto y lo que paga el cliente hoy (envío, descuento, promos). */
  async condicionesPara(punto: Punto | null, subtotal: number, gratisDesde: number) {
    const { barrios: lista, promos, nombreDe } = await this.vigentes();
    const barrio = barrioDe(lista, punto);
    return { barrio, nombreDe, ...condiciones(barrio, promos, subtotal, gratisDesde, hoyAr()) };
  }

  /** Las promos que rigen hoy, en palabras del cliente, para los avisos de la portada. */
  async avisosDeHoy(): Promise<string[]> {
    const { promos, nombreDe } = await this.vigentes();
    const hoy = hoyAr();
    return promos
      .filter((p) => vigente(p, hoy) && p.barrioIds.some((id) => nombreDe.has(id)))
      .map((p) => `${p.tipo === 'descuento' ? '🏷️' : '🚚'} Hoy: ${describirPromo(p, nombreDe)}`);
  }

  async guardarBarrio(id: number | null, dto: BarrioDto) {
    const nombre = dto.nombre.trim();
    if (!nombre) throw new BadRequestException('Poné el nombre del barrio.');
    const poligono = poligonoValido(dto.poligono);
    if (!poligono) throw new BadRequestException(`Dibujá el barrio en el mapa: de ${MIN_PUNTOS} a ${MAX_PUNTOS} puntos.`);
    const valores = { nombre, poligono, costoEnvio: dto.costoEnvio ?? null, activo: dto.activo, actualizadoEn: new Date() };
    try {
      const [b] = id == null
        ? await this.db.insert(barrios).values(valores).returning()
        : await this.db.update(barrios).set(valores).where(eq(barrios.id, id)).returning();
      if (!b) throw new NotFoundException('Ese barrio ya no existe.');
      return b;
    } catch (e) {
      if (esUnico(e)) throw new ConflictException(`Ya hay un barrio «${nombre}».`);
      throw e;
    }
  }

  /** Un barrio que está en alguna promo no se borra: primero se lo saca de la promo (o se lo desactiva). */
  async borrarBarrio(id: number) {
    const usan = await this.db.select({ id: barrioPromos.id }).from(barrioPromos)
      .where(sql`${barrioPromos.barrioIds} @> ${JSON.stringify([id])}::jsonb`);
    if (usan.length) {
      throw new ConflictException(`Está en ${usan.length === 1 ? 'una promo' : `${usan.length} promos`}: sacalo de ahí antes de borrarlo, o desactivalo.`);
    }
    const [b] = await this.db.delete(barrios).where(eq(barrios.id, id)).returning({ id: barrios.id });
    if (!b) throw new NotFoundException('Ese barrio ya no existe.');
    return { ok: true };
  }

  async guardarPromo(id: number | null, dto: PromoDto) {
    const barrioIds = [...new Set(dto.barrioIds)];
    const existen = await this.db.select({ id: barrios.id }).from(barrios).where(inArray(barrios.id, barrioIds));
    if (existen.length !== barrioIds.length) throw new BadRequestException('Alguno de los barrios ya no existe.');
    if (dto.tipo === 'envio_fijo' && !(dto.valor > 0)) throw new BadRequestException('Poné el precio del envío (para «gratis», elegí envío gratis).');
    if (dto.tipo === 'descuento' && !(dto.valor > 0 && dto.valor <= 100)) throw new BadRequestException('El descuento va de 1% a 100%.');
    const desde = dto.desde || null;
    const hasta = dto.hasta || null;
    if ((desde && !esDia(desde)) || (hasta && !esDia(hasta))) throw new BadRequestException('Revisá las fechas.');
    if (desde && hasta && desde > hasta) throw new BadRequestException('La fecha «desde» es posterior a «hasta».');
    const valores = {
      barrioIds, tipo: dto.tipo, valor: dto.tipo === 'envio_gratis' ? 0 : dto.valor,
      dias: [...new Set(dto.dias)].sort((a, b) => a - b), desde, hasta, minimo: dto.minimo, activa: dto.activa, actualizadoEn: new Date(),
    };
    const [p] = id == null
      ? await this.db.insert(barrioPromos).values(valores).returning()
      : await this.db.update(barrioPromos).set(valores).where(eq(barrioPromos.id, id)).returning();
    if (!p) throw new NotFoundException('Esa promo ya no existe.');
    return comoPromo(p);
  }

  async borrarPromo(id: number) {
    const [p] = await this.db.delete(barrioPromos).where(eq(barrioPromos.id, id)).returning({ id: barrioPromos.id });
    if (!p) throw new NotFoundException('Esa promo ya no existe.');
    return { ok: true };
  }
}

/** La pantalla del ERP: quien configura la tienda online. */
@Controller('web/barrios')
@Permiso('web.configuracion')
export class BarriosController {
  constructor(private readonly svc: BarriosService) {}

  @Get() listar() { return this.svc.listar(); }
  @Post() crear(@Body() dto: BarrioDto) { return this.svc.guardarBarrio(null, dto); }
  @Put(':id') editar(@Param('id', ParseIntPipe) id: number, @Body() dto: BarrioDto) { return this.svc.guardarBarrio(id, dto); }
  @Delete(':id') borrar(@Param('id', ParseIntPipe) id: number) { return this.svc.borrarBarrio(id); }
  @Post('promos') crearPromo(@Body() dto: PromoDto) { return this.svc.guardarPromo(null, dto); }
  @Put('promos/:id') editarPromo(@Param('id', ParseIntPipe) id: number, @Body() dto: PromoDto) { return this.svc.guardarPromo(id, dto); }
  @Delete('promos/:id') borrarPromo(@Param('id', ParseIntPipe) id: number) { return this.svc.borrarPromo(id); }
}

@Module({ controllers: [BarriosController], providers: [BarriosService], exports: [BarriosService] })
export class BarriosModule {}
