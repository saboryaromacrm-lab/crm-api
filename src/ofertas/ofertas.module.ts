/**
 * OFERTAS — catálogo y validación de promociones
 * ============================================================================
 * El backend guarda la DEFINICIÓN y valida que sea coherente; la aplicación en
 * vivo la hace el motor del POS (domain/ofertas.js), que necesita recalcular
 * con cada tecla. Mismo trato que el resto de los precios: el renglón viaja con
 * `ofertaId + ofertaDescuento` para que quede auditado qué promo costó cuánto.
 *
 * La validación por tipo vive en UNA tabla (`REGLAS_TIPO`): el formulario del
 * frontend y este servicio no pueden discrepar sobre qué campos usa cada
 * mecánica, porque la respuesta es un dato, no dos ifs en dos lados.
 */
import {
  Body, Controller, Delete, Get, Inject, Injectable, Module, BadRequestException,
  NotFoundException, Param, ParseIntPipe, Patch, Post,
} from '@nestjs/common';
import {
  IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString,
} from 'class-validator';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { Permiso } from '../auth/auth.decoradores';
import { ofertaAlcances, ofertaComponentes, ofertas, ventaItems } from '../db/schema';

export const TIPOS_OFERTA = [
  'porcentaje', 'precio_fijo', 'nxm', 'segunda_unidad', 'pack', 'combo', 'ticket',
] as const;
export type TipoOferta = (typeof TIPOS_OFERTA)[number];

const ALCANCES = ['producto', 'marca', 'categoria', 'etiqueta', 'presentacion'] as const;

/**
 * Qué necesita cada mecánica. `check` devuelve el error o null; `alcance` dice
 * si la oferta necesita al menos una fila de alcance.
 */
const REGLAS_TIPO: Record<TipoOferta, { alcance: boolean; check: (o: any) => string | null }> = {
  porcentaje: {
    alcance: true,
    check: (o) => (o.porcentaje > 0 && o.porcentaje <= 100 ? null : 'El porcentaje tiene que estar entre 0 y 100.'),
  },
  precio_fijo: {
    alcance: true,
    check: (o) => (o.precio > 0 ? null : 'El precio de oferta tiene que ser mayor a 0.'),
  },
  nxm: {
    alcance: true,
    check: (o) => {
      if (!(Number.isInteger(o.lleva) && Number.isInteger(o.paga))) return 'Llevá y pagá tienen que ser enteros.';
      if (!(o.lleva >= 2 && o.paga >= 1 && o.paga < o.lleva)) return 'Tiene que ser llevá N > pagá M (por ejemplo 3×2).';
      return null;
    },
  },
  segunda_unidad: {
    alcance: true,
    check: (o) => (o.porcentaje > 0 && o.porcentaje <= 100 ? null : 'El descuento de la 2ª unidad tiene que estar entre 0 y 100.'),
  },
  pack: {
    alcance: true,
    check: (o) => {
      if (!(Number.isInteger(o.lleva) && o.lleva >= 2)) return 'El pack necesita una cantidad entera de al menos 2.';
      if (!(o.precio > 0)) return 'El precio del pack tiene que ser mayor a 0.';
      return null;
    },
  },
  combo: {
    alcance: false,   // el alcance del combo son sus componentes
    check: (o) => (o.precio > 0 ? null : 'El precio del combo tiene que ser mayor a 0.'),
  },
  ticket: {
    alcance: false,   // alcanza al ticket entero
    check: (o) => {
      if (!(o.porcentaje > 0 && o.porcentaje <= 100)) return 'El porcentaje tiene que estar entre 0 y 100.';
      if (!(o.montoMinimo > 0)) return 'El monto mínimo del ticket tiene que ser mayor a 0.';
      return null;
    },
  },
};

class AlcanceDto {
  @IsIn(ALCANCES as unknown as string[]) tipo!: string;
  @IsNumber() refId!: number;
}
class ComponenteDto {
  @IsNumber() productoId!: number;
  @IsNumber() cantidad!: number;
}
class UpsertOfertaDto {
  @IsString() nombre!: string;
  @IsIn(TIPOS_OFERTA as unknown as string[]) tipo!: TipoOferta;
  @IsOptional() @IsNumber() porcentaje?: number;
  @IsOptional() @IsNumber() precio?: number;
  @IsOptional() @IsNumber() lleva?: number;
  @IsOptional() @IsNumber() paga?: number;
  @IsOptional() @IsNumber() montoMinimo?: number;
  @IsOptional() @IsString() desde?: string;
  @IsOptional() @IsString() hasta?: string;
  @IsOptional() @IsString() dias?: string;
  @IsOptional() @IsString() sucursales?: string;
  @IsOptional() @IsString() mediosPago?: string;
  /** Ids de lista en CSV. '' = corre en todas (0065, reemplazó soloPrecioBase). */
  @IsOptional() @IsString() listas?: string;
  /** El alcance por la madre alcanza también a sus paquetes fraccionados. */
  @IsOptional() @IsBoolean() incluyeFraccionados?: boolean;
  @IsOptional() @IsBoolean() activa?: boolean;
  @IsOptional() @IsArray() alcances?: AlcanceDto[];
  @IsOptional() @IsArray() componentes?: ComponenteDto[];
}

@Injectable()
export class OfertasService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Todas, con alcances y componentes anidados. El panel filtra en memoria. */
  async listar() {
    const [os, als, comps] = await Promise.all([
      this.db.select().from(ofertas).orderBy(asc(ofertas.id)),
      this.db.select().from(ofertaAlcances),
      this.db.select().from(ofertaComponentes),
    ]);
    return os.map((o) => ({
      ...o,
      alcances: als.filter((a) => a.ofertaId === o.id).map(({ tipo, refId }) => ({ tipo, refId })),
      componentes: comps.filter((c) => c.ofertaId === o.id).map(({ productoId, cantidad }) => ({ productoId, cantidad })),
    }));
  }

  /**
   * Las que embarca el catálogo del POS: solo activas. La vigencia por fecha,
   * día y sucursal la evalúa el motor con SU reloj — el catálogo se cachea al
   * abrir la caja y una promo puede arrancar o vencer en el medio del turno.
   */
  async activas() {
    return (await this.listar()).filter((o) => o.activa);
  }

  /**
   * CSV de ids: sin repetidos, sin basura y ordenado.
   *
   * Ordenar no es cosmético — es lo que hace que "2,1" y "1,2" sean la misma
   * fila y que comparar dos ofertas no dependa del orden en que se tildaron los
   * chips. Los no numéricos se descartan en silencio a propósito: el campo lo
   * arma la pantalla y un id inventado no es un caso que valga un mensaje.
   */
  private idsCsv(csv?: string) {
    const ids = [...new Set((csv ?? '').split(',')
      .map((x) => parseInt(x.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0))];
    return ids.sort((a, b) => a - b).join(',');
  }

  /** Normaliza + valida según el tipo. Es la única puerta de escritura. */
  private normalizar(dto: UpsertOfertaDto) {
    const nombre = (dto.nombre || '').trim();
    if (!nombre) throw new BadRequestException('El nombre es obligatorio.');
    const regla = REGLAS_TIPO[dto.tipo];
    if (!regla) throw new BadRequestException('Tipo de oferta inválido.');

    const o = {
      nombre,
      tipo: dto.tipo,
      porcentaje: Number(dto.porcentaje) || 0,
      precio: Number(dto.precio) || 0,
      lleva: Number(dto.lleva) || 0,
      paga: Number(dto.paga) || 0,
      montoMinimo: Number(dto.montoMinimo) || 0,
      desde: dto.desde ? new Date(dto.desde) : null,
      hasta: dto.hasta ? new Date(dto.hasta) : null,
      dias: (dto.dias ?? '').trim(),
      sucursales: (dto.sucursales ?? '').trim(),
      mediosPago: dto.tipo === 'ticket' ? (dto.mediosPago ?? '').trim() : '',
      listas: this.idsCsv(dto.listas),
      incluyeFraccionados: dto.incluyeFraccionados ?? false,
      activa: dto.activa ?? true,
    };
    const error = regla.check(o);
    if (error) throw new BadRequestException(error);
    if (o.desde && o.hasta && o.desde > o.hasta) {
      throw new BadRequestException('La vigencia termina antes de empezar.');
    }
    if (o.dias && !/^[01]{7}$/.test(o.dias)) {
      throw new BadRequestException('Los días van como máscara de 7 (lunes a domingo).');
    }
    if (o.dias === '0000000') throw new BadRequestException('La oferta no vale ningún día.');

    const alcances = (dto.alcances ?? [])
      .filter((a) => ALCANCES.includes(a.tipo as any) && Number(a.refId) > 0)
      .map((a) => ({ tipo: a.tipo as any, refId: Number(a.refId) }));
    if (regla.alcance && !alcances.length) {
      throw new BadRequestException('Elegí a qué productos, paquetes, marcas, categorías o etiquetas alcanza.');
    }

    const componentes = (dto.componentes ?? [])
      .filter((c) => Number(c.productoId) > 0 && Number(c.cantidad) > 0)
      .map((c) => ({ productoId: Number(c.productoId), cantidad: Number(c.cantidad) }));
    if (dto.tipo === 'combo' && componentes.length < 2) {
      throw new BadRequestException('El combo necesita al menos dos productos.');
    }

    return {
      fila: o,
      alcances: regla.alcance ? alcances : [],
      componentes: dto.tipo === 'combo' ? componentes : [],
    };
  }

  private async escribirHijas(tx: any, ofertaId: number, alcances: any[], componentes: any[]) {
    // Nadie referencia estas filas: reemplazarlas enteras es seguro acá.
    await tx.delete(ofertaAlcances).where(eq(ofertaAlcances.ofertaId, ofertaId));
    await tx.delete(ofertaComponentes).where(eq(ofertaComponentes.ofertaId, ofertaId));
    if (alcances.length) await tx.insert(ofertaAlcances).values(alcances.map((a) => ({ ...a, ofertaId })));
    if (componentes.length) await tx.insert(ofertaComponentes).values(componentes.map((c) => ({ ...c, ofertaId })));
  }

  async crear(dto: UpsertOfertaDto) {
    const { fila, alcances, componentes } = this.normalizar(dto);
    return this.db.transaction(async (tx) => {
      const [o] = await tx.insert(ofertas).values(fila).returning();
      await this.escribirHijas(tx, o.id, alcances, componentes);
      return o;
    });
  }

  async editar(id: number, dto: UpsertOfertaDto) {
    const { fila, alcances, componentes } = this.normalizar(dto);
    return this.db.transaction(async (tx) => {
      const [o] = await tx.update(ofertas).set(fila).where(eq(ofertas.id, id)).returning();
      if (!o) throw new NotFoundException('Oferta inexistente.');
      await this.escribirHijas(tx, id, alcances, componentes);
      return o;
    });
  }

  /** Usada en ventas → se desactiva (el ticket viejo la referencia). */
  async borrar(id: number) {
    const [usada] = await this.db.select({ n: sql<number>`count(*)` })
      .from(ventaItems).where(eq(ventaItems.ofertaId, id));
    if (Number(usada?.n) > 0) {
      const [o] = await this.db.update(ofertas).set({ activa: false })
        .where(eq(ofertas.id, id)).returning();
      if (!o) throw new NotFoundException('Oferta inexistente.');
      return { ok: true, desactivada: true };
    }
    await this.db.delete(ofertas).where(eq(ofertas.id, id));
    return { ok: true, desactivada: false };
  }

  /** Para validar al confirmar: las ofertas de ticket con medio de pago exigido. */
  async ticketConMedios(ids: number[]) {
    if (!ids.length) return [];
    // Solo las del ticket que se está cobrando: traer la tabla entera para
    // descartarla en memoria era gratis con diez promos y no lo es con mil.
    const suyas = await this.db.select().from(ofertas).where(inArray(ofertas.id, ids));
    return suyas.filter((o) => o.tipo === 'ticket' && o.mediosPago.trim() !== '');
  }
}

/**
 * Crear una oferta es tocar el precio de TODAS las cajas del sistema: el
 * catálogo del POS se la lleva al abrir el turno. Sin permiso, una promo de
 * "100% en la categoría Aceites" quedaba activa hasta que alguien la notara.
 *
 * La lectura queda abierta a sesión válida: el POS y Vencimientos la consumen.
 */
@Controller('ofertas')
export class OfertasController {
  constructor(private readonly svc: OfertasService) {}

  @Get() listar() { return this.svc.listar(); }

  @Post() @Permiso('ventas.ofertas', 'ofertas')
  crear(@Body() dto: UpsertOfertaDto) { return this.svc.crear(dto); }

  @Patch(':id') @Permiso('ventas.ofertas', 'ofertas')
  editar(@Param('id', ParseIntPipe) id: number, @Body() dto: UpsertOfertaDto) {
    return this.svc.editar(id, dto);
  }

  @Delete(':id') @Permiso('ventas.ofertas', 'ofertas')
  borrar(@Param('id', ParseIntPipe) id: number) { return this.svc.borrar(id); }
}

@Module({
  controllers: [OfertasController],
  providers: [OfertasService],
  exports: [OfertasService],
})
export class OfertasModule {}
