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
  Body, Controller, Delete, Get, Inject, Injectable, Logger, Module, BadRequestException,
  NotFoundException, OnModuleDestroy, OnModuleInit, Param, ParseIntPipe, Patch, Post,
} from '@nestjs/common';
import {
  IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString,
} from 'class-validator';
import { asc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { exigirNoExclusivoCoffit } from '../productos/exclusivoCoffit';
import { Auth, Permiso, Sesion } from '../auth/auth.decoradores';
import { ofertaAlcances, ofertaComponentes, ofertaStockInicial, ofertas, stock, usuarios, ventaItems } from '../db/schema';
import { MARGEN_AL_EMPEZAR_MS, alcanzaProducto, cubreSucursal, estadoOferta, inicioOferta, productosParaAlcance } from './alcance';
/** El reloj de las fotos: las programadas se fotografían en la primera vuelta después de arrancar. */
const CADA_MS_FOTO = 10 * 60_000;

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
  /** Para rematar mercadería por vencer (0187). */
  @IsOptional() @IsBoolean() porVencer?: boolean;
  @IsOptional() @IsArray() alcances?: AlcanceDto[];
  @IsOptional() @IsArray() componentes?: ComponenteDto[];
}

@Injectable()
export class OfertasService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Ofertas');
  private reloj: ReturnType<typeof setInterval> | null = null;

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.OFERTAS_FOTO === '0') return;
    const tic = () => { void this.fotografiarStock().catch((e) => this.log.warn(`foto del stock: ${(e as Error).message}`)); };
    const primero = setTimeout(tic, 60_000);
    primero.unref();
    this.reloj = setInterval(tic, CADA_MS_FOTO);
    this.reloj.unref();
  }

  onModuleDestroy() {
    if (this.reloj) clearInterval(this.reloj);
  }

  /**
   * LA FOTO DEL STOCK AL EMPEZAR (0189): el disponible de cada artículo que la
   * oferta alcanza, en cada sucursal donde corre. Con eso Métricas dice «empezó
   * con 40, se vendieron 28 con la oferta». Se toma UNA vez por artículo y
   * sucursal (lo ya fotografiado no se pisa).
   *
   *   · sin `ids` (el reloj): las vigentes que todavía no tienen foto
   *     (`foto_stock_en` nulo) —las programadas que arrancaron, y las que ya
   *     corrían antes de la 0189—;
   *   · con `ids` (al crear o editar): además completa lo que se sumó al alcance.
   *
   * La de ticket no alcanza artículos: no lleva foto.
   */
  async fotografiarStock(ids?: number[]) {
    const ahora = new Date();
    const vigentes = (await this.listar()).filter((o) => o.tipo !== 'ticket'
      && (!ids || ids.includes(o.id)) && estadoOferta(o, ahora) === 'vigente');
    if (!vigentes.length) return 0;
    const aTomar = ids ? vigentes : vigentes.filter((o) => !o.fotoStockEn);
    if (!aTomar.length) return 0;
    const hechas = await this.db.select({
      ofertaId: ofertaStockInicial.ofertaId, productoId: ofertaStockInicial.productoId,
      presentacionId: ofertaStockInicial.presentacionId, sucursalId: ofertaStockInicial.sucursalId,
    }).from(ofertaStockInicial).where(inArray(ofertaStockInicial.ofertaId, aTomar.map((o) => o.id)));

    const clave = (o: number, p: number, pr: number, s: number) => `${o}|${p}|${pr}|${s}`;
    const ya = new Set(hechas.map((h) => clave(h.ofertaId, h.productoId, h.presentacionId, h.sucursalId)));
    const [prods, filas] = await Promise.all([
      productosParaAlcance(this.db),
      this.db.select({ productoId: stock.productoId, presentacionId: stock.presentacionId, sucursalId: stock.sucursalId, cantidad: stock.cantidad })
        .from(stock).where(eq(stock.estado, 'disponible')),
    ]);
    const porId = new Map(prods.map((p) => [p.id, p]));
    const nuevas = new Map<string, typeof ofertaStockInicial.$inferInsert>();
    for (const o of aTomar) {
      const inicio = inicioOferta(o);
      const alEmpezar = !!inicio && ahora.getTime() - inicio.getTime() <= MARGEN_AL_EMPEZAR_MS;
      for (const f of filas) {
        const prod = porId.get(f.productoId);
        if (!prod || !cubreSucursal(o, f.sucursalId) || !alcanzaProducto(o, prod, f.presentacionId)) continue;
        const k = clave(o.id, f.productoId, f.presentacionId ?? 0, f.sucursalId);
        if (ya.has(k)) continue;
        const previa = nuevas.get(k);
        if (previa) previa.cantidad = (previa.cantidad ?? 0) + f.cantidad;
        else {
          nuevas.set(k, {
            ofertaId: o.id, productoId: f.productoId, presentacionId: f.presentacionId ?? 0, sucursalId: f.sucursalId,
            cantidad: f.cantidad, tomadoEn: ahora, alEmpezar,
          });
        }
      }
    }
    const lote = [...nuevas.values()];
    await this.db.transaction(async (tx) => {
      for (let i = 0; i < lote.length; i += 500) {
        await tx.insert(ofertaStockInicial).values(lote.slice(i, i + 500)).onConflictDoNothing();
      }
      /* Sacada, aunque no haya dado filas: «empezó sin stock» no es «no hay foto». */
      const sinMarca = aTomar.filter((o) => !o.fotoStockEn).map((o) => o.id);
      if (sinMarca.length) await tx.update(ofertas).set({ fotoStockEn: ahora }).where(inArray(ofertas.id, sinMarca));
    });
    return lote.length;
  }

  /** Después de guardar: la foto no frena ni hace fallar el alta (el reloj la reintenta). */
  private async fotoDe(id: number) {
    await this.fotografiarStock([id]).catch((e) => this.log.warn(`foto del stock de la oferta ${id}: ${(e as Error).message}`));
  }

  /** Todas, con alcances, componentes y el nombre de quien la creó. El panel filtra en memoria. */
  async listar() {
    const [os, als, comps] = await Promise.all([
      this.db.select({ ...getTableColumns(ofertas), creadoPorNombre: usuarios.nombre })
        .from(ofertas).leftJoin(usuarios, eq(usuarios.id, ofertas.creadoPor)).orderBy(asc(ofertas.id)),
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
      porVencer: dto.porVencer ?? false,
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
    /* Lo de uso exclusivo de Coffit no se vende: tampoco va en oferta (19/10/2026). */
    await exigirNoExclusivoCoffit(tx, [
      ...alcances.filter((a) => a.tipo === 'producto').map((a) => a.refId),
      ...componentes.map((c) => c.productoId),
    ], 'poner en oferta');
    // Nadie referencia estas filas: reemplazarlas enteras es seguro acá.
    await tx.delete(ofertaAlcances).where(eq(ofertaAlcances.ofertaId, ofertaId));
    await tx.delete(ofertaComponentes).where(eq(ofertaComponentes.ofertaId, ofertaId));
    if (alcances.length) await tx.insert(ofertaAlcances).values(alcances.map((a) => ({ ...a, ofertaId })));
    if (componentes.length) await tx.insert(ofertaComponentes).values(componentes.map((c) => ({ ...c, ofertaId })));
  }

  /**
   * `auto` (0188): la arma la regla de vencimiento. Desde la pantalla siempre
   * es `false`: lo que crea o edita una persona es manual y la regla no lo toca.
   */
  async crear(dto: UpsertOfertaDto, usuarioId: number | null = null, auto = false) {
    const { fila, alcances, componentes } = this.normalizar(dto);
    const creada = await this.db.transaction(async (tx) => {
      const [o] = await tx.insert(ofertas).values({ ...fila, creadoPor: usuarioId, autoVencimiento: auto }).returning();
      await this.escribirHijas(tx, o.id, alcances, componentes);
      return o;
    });
    await this.fotoDe(creada.id);
    return creada;
  }

  async editar(id: number, dto: UpsertOfertaDto, auto = false) {
    const { fila, alcances, componentes } = this.normalizar(dto);
    const editada = await this.db.transaction(async (tx) => {
      const [o] = await tx.update(ofertas).set({ ...fila, autoVencimiento: auto }).where(eq(ofertas.id, id)).returning();
      if (!o) throw new NotFoundException('Oferta inexistente.');
      await this.escribirHijas(tx, id, alcances, componentes);
      return o;
    });
    /* Lo que se sumó al alcance se fotografía ahora (ya no «al empezar»). */
    await this.fotoDe(id);
    return editada;
  }

  /** Atada a un registro de vencimiento: es por vencimiento (0187). */
  async marcarPorVencer(id: number) {
    await this.db.update(ofertas).set({ porVencer: true }).where(eq(ofertas.id, id));
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
  crear(@Body() dto: UpsertOfertaDto, @Auth() sesion: Sesion) { return this.svc.crear(dto, sesion.usuarioId); }

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
