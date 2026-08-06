/**
 * CATÁLOGOS DEL PRODUCTO — marcas, categorías › subcategorías, etiquetas
 * ============================================================================
 * Cuatro catálogos con el mismo ciclo de vida, así que comparten un núcleo en
 * vez de repetirse cuatro veces. Lo único propio de cada uno es a qué tablas
 * hay que mirar para saber si está EN USO y qué hay que reapuntar al fusionar;
 * eso vive en `CATALOGOS`, una tabla de definiciones, y el resto es genérico.
 *
 * Dos reglas que sostienen todo:
 *
 *   1. NO se borra lo que está en uso, se desactiva. Un producto viejo con su
 *      marca en null es un dato perdido para siempre.
 *   2. La unicidad se mide NORMALIZADA (sin acentos ni mayúsculas). Es lo único
 *      que evita que el catálogo se vuelva a ensuciar: sin esto, "Cachafaz" y
 *      "CACHAFAZ" conviven y las reglas de marca se parten al medio.
 */
import {
  Body, Controller, Delete, Get, Inject, Injectable, Module, BadRequestException,
  NotFoundException, Param, ParseIntPipe, Patch, Post,
} from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  categorias, etiquetas, marcas, productoEtiquetas, productos, reglasMarca, subcategorias,
} from '../db/schema';

/** Texto comparable: sin acentos, sin caja, sin espacios de más. */
export function norm(v: string) {
  return (v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();
}

export type TipoCatalogo = 'marcas' | 'categorias' | 'subcategorias' | 'etiquetas';

/**
 * Qué mirar para cada catálogo. `usos` responde "¿se puede borrar?" y `mover`
 * responde "¿qué hay que reapuntar al fusionar?". Agregar un catálogo nuevo es
 * agregar una entrada acá, no otro CRUD.
 */
const CATALOGOS: Record<TipoCatalogo, {
  tabla: any;
  singular: string;
  /** Tablas donde el id aparece referenciado. */
  usos: { tabla: any; col: any; que: string }[];
  /**
   * Al fusionar A→B: qué reapuntar. Van como nombres de tabla/columna porque
   * es un UPDATE masivo en SQL crudo — una sola sentencia por tabla en vez de
   * traer las filas para volver a escribirlas.
   * `unicoCon` es la otra mitad de un índice único, donde reapuntar a ciegas
   * chocaría.
   */
  mover: { tabla: string; col: string; unicoCon?: string }[];
}> = {
  marcas: {
    tabla: marcas,
    singular: 'La marca',
    usos: [
      { tabla: productos, col: productos.marcaId, que: 'productos' },
      { tabla: reglasMarca, col: reglasMarca.marcaId, que: 'reglas de marca' },
    ],
    mover: [
      { tabla: 'productos', col: 'marca_id' },
      { tabla: 'reglas_marca', col: 'marca_id', unicoCon: 'modalidad_id' },
    ],
  },
  categorias: {
    tabla: categorias,
    singular: 'La categoría',
    usos: [
      { tabla: productos, col: productos.categoriaId, que: 'productos' },
      { tabla: subcategorias, col: subcategorias.categoriaId, que: 'subcategorías' },
    ],
    mover: [
      { tabla: 'productos', col: 'categoria_id' },
      { tabla: 'subcategorias', col: 'categoria_id', unicoCon: 'nombre' },
    ],
  },
  subcategorias: {
    tabla: subcategorias,
    singular: 'La subcategoría',
    usos: [{ tabla: productos, col: productos.subcategoriaId, que: 'productos' }],
    mover: [{ tabla: 'productos', col: 'subcategoria_id' }],
  },
  etiquetas: {
    tabla: etiquetas,
    singular: 'La etiqueta',
    usos: [{ tabla: productoEtiquetas, col: productoEtiquetas.etiquetaId, que: 'productos' }],
    mover: [{ tabla: 'producto_etiquetas', col: 'etiqueta_id', unicoCon: 'producto_id' }],
  },
};

class UpsertCatalogoDto {
  @IsString() nombre!: string;
  /** Solo subcategorías. */
  @IsOptional() @IsInt() categoriaId?: number;
  /** Solo etiquetas. */
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsBoolean() activa?: boolean;
}

class FusionarDto {
  @IsInt() haciaId!: number;
}

@Injectable()
export class CatalogosService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Los cuatro catálogos de una. Son chicos y estables (decenas de filas), así
   * que viajan enteros con el bootstrap y el frontend filtra en memoria: la
   * cascada categoría › subcategoría no cuesta una llamada por tecla.
   */
  async catalogo() {
    const [ms, cs, ss, es] = await Promise.all([
      this.db.select().from(marcas).orderBy(asc(marcas.nombre)),
      this.db.select().from(categorias).orderBy(asc(categorias.nombre)),
      this.db.select().from(subcategorias).orderBy(asc(subcategorias.nombre)),
      this.db.select().from(etiquetas).orderBy(asc(etiquetas.nombre)),
    ]);
    return { marcas: ms, categorias: cs, subcategorias: ss, etiquetas: es };
  }

  private def(tipo: string) {
    const d = CATALOGOS[tipo as TipoCatalogo];
    if (!d) throw new BadRequestException('Catálogo inexistente.');
    return d;
  }

  /**
   * ¿Ya existe con ese nombre? Compara normalizado, no por igualdad exacta:
   * el índice único de la base atrapa el duplicado literal, esto atrapa el que
   * difiere en un acento o en la caja, que es el que de verdad ensucia.
   */
  private async duplicado(tipo: TipoCatalogo, nombre: string, categoriaId?: number, exceptoId?: number) {
    const d = this.def(tipo);
    const conds: any[] = [];
    if (exceptoId) conds.push(ne(d.tabla.id, exceptoId));
    // En subcategorías el nombre solo choca dentro de la misma categoría.
    if (tipo === 'subcategorias' && categoriaId) conds.push(eq(subcategorias.categoriaId, categoriaId));
    const filas = await this.db.select().from(d.tabla).where(conds.length ? and(...conds) : undefined);
    const n = norm(nombre);
    return filas.find((f: any) => norm(f.nombre) === n) ?? null;
  }

  async crear(tipo: TipoCatalogo, dto: UpsertCatalogoDto) {
    const d = this.def(tipo);
    const nombre = (dto.nombre || '').trim();
    if (!nombre) throw new BadRequestException('El nombre es obligatorio.');

    if (tipo === 'subcategorias') {
      if (!dto.categoriaId) throw new BadRequestException('La subcategoría necesita una categoría.');
      const [cat] = await this.db.select().from(categorias).where(eq(categorias.id, dto.categoriaId)).limit(1);
      if (!cat) throw new BadRequestException('Categoría inválida.');
    }

    const dup = await this.duplicado(tipo, nombre, dto.categoriaId);
    if (dup) throw new BadRequestException(`Ya existe: "${dup.nombre}".`);

    const values: any = { nombre, activa: dto.activa ?? true };
    if (tipo === 'subcategorias') values.categoriaId = dto.categoriaId;
    if (tipo === 'etiquetas') values.color = (dto.color ?? '').trim();

    const filas = await this.db.insert(d.tabla).values(values).returning() as any[];
    return filas[0];
  }

  async editar(tipo: TipoCatalogo, id: number, dto: UpsertCatalogoDto) {
    const d = this.def(tipo);
    const nombre = (dto.nombre || '').trim();
    if (!nombre) throw new BadRequestException('El nombre es obligatorio.');

    const [actual] = await this.db.select().from(d.tabla).where(eq(d.tabla.id, id)).limit(1);
    if (!actual) throw new NotFoundException(`${d.singular} no existe.`);

    const catId = tipo === 'subcategorias' ? (dto.categoriaId ?? (actual as any).categoriaId) : undefined;
    const dup = await this.duplicado(tipo, nombre, catId, id);
    if (dup) throw new BadRequestException(`Ya existe: "${dup.nombre}".`);

    const values: any = { nombre, activa: dto.activa ?? true };
    if (tipo === 'subcategorias') values.categoriaId = catId;
    if (tipo === 'etiquetas') values.color = (dto.color ?? '').trim();

    const filas = await this.db.update(d.tabla).set(values).where(eq(d.tabla.id, id)).returning() as any[];
    return filas[0];
  }

  /** Cuántas filas lo referencian, por tabla. */
  private async contarUsos(tipo: TipoCatalogo, id: number) {
    const d = this.def(tipo);
    const partes = await Promise.all(d.usos.map(async (u) => {
      const [r] = await this.db.select({ n: sql<number>`count(*)` }).from(u.tabla).where(eq(u.col, id));
      return { que: u.que, n: Number(r?.n) || 0 };
    }));
    return partes.filter((p) => p.n > 0);
  }

  /**
   * En uso → se desactiva y sigue existiendo. Sin uso → se borra de verdad.
   * Devuelve cuál de las dos cosas pasó para que la pantalla lo diga.
   */
  async borrar(tipo: TipoCatalogo, id: number) {
    const d = this.def(tipo);
    const usos = await this.contarUsos(tipo, id);
    if (usos.length) {
      const filas = await this.db.update(d.tabla).set({ activa: false } as any)
        .where(eq(d.tabla.id, id)).returning() as any[];
      const row = filas[0];
      if (!row) throw new NotFoundException(`${d.singular} no existe.`);
      return {
        ok: true, desactivada: true, row,
        detalle: usos.map((u) => `${u.n} ${u.que}`).join(', '),
      };
    }
    await this.db.delete(d.tabla).where(eq(d.tabla.id, id));
    return { ok: true, desactivada: false };
  }

  /**
   * FUSIONAR — el antídoto contra el catálogo sucio. Todo lo que apunta a
   * `desdeId` pasa a `haciaId` y el origen desaparece.
   *
   * El detalle fino son los índices únicos: si un producto ya tiene las dos
   * etiquetas que estamos fusionando, reapuntar a ciegas viola
   * `uq_producto_etiqueta`. Por eso, donde hay `unicoCon`, primero se borra la
   * fila que ya existe del lado destino y recién después se reapunta.
   */
  async fusionar(tipo: TipoCatalogo, desdeId: number, haciaId: number) {
    const d = this.def(tipo);
    if (desdeId === haciaId) throw new BadRequestException('Elegí dos distintas.');

    const [origen] = await this.db.select().from(d.tabla).where(eq(d.tabla.id, desdeId)).limit(1);
    const [destino] = await this.db.select().from(d.tabla).where(eq(d.tabla.id, haciaId)).limit(1);
    if (!origen || !destino) throw new NotFoundException(`${d.singular} no existe.`);

    // Fusionar subcategorías de distintas categorías movería productos de
    // rubro sin que nadie lo pida.
    if (tipo === 'subcategorias' && (origen as any).categoriaId !== (destino as any).categoriaId) {
      throw new BadRequestException('Solo se fusionan subcategorías de la misma categoría.');
    }

    await this.db.transaction(async (tx) => {
      for (const m of d.mover) {
        const t = sql.raw(`"${m.tabla}"`);
        const col = sql.raw(`"${m.col}"`);
        if (m.unicoCon) {
          const par = sql.raw(`"${m.unicoCon}"`);
          // Las filas del origen cuyo par ya existe en el destino sobran:
          // reapuntarlas violaría el índice único. Se descartan primero.
          await tx.execute(sql`
            DELETE FROM ${t} o
            WHERE o.${col} = ${desdeId}
              AND EXISTS (SELECT 1 FROM ${t} d WHERE d.${col} = ${haciaId} AND d.${par} = o.${par})`);
        }
        await tx.execute(sql`UPDATE ${t} SET ${col} = ${haciaId} WHERE ${col} = ${desdeId}`);
      }
      await tx.delete(d.tabla).where(eq(d.tabla.id, desdeId));
    });

    return { ok: true, destino };
  }
}

@Controller('catalogos')
export class CatalogosController {
  constructor(private readonly svc: CatalogosService) {}

  @Get() catalogo() { return this.svc.catalogo(); }

  @Post(':tipo') crear(@Param('tipo') tipo: TipoCatalogo, @Body() dto: UpsertCatalogoDto) {
    return this.svc.crear(tipo, dto);
  }

  @Patch(':tipo/:id') editar(
    @Param('tipo') tipo: TipoCatalogo,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpsertCatalogoDto,
  ) {
    return this.svc.editar(tipo, id, dto);
  }

  @Delete(':tipo/:id') borrar(@Param('tipo') tipo: TipoCatalogo, @Param('id', ParseIntPipe) id: number) {
    return this.svc.borrar(tipo, id);
  }

  @Post(':tipo/:id/fusionar') fusionar(
    @Param('tipo') tipo: TipoCatalogo,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: FusionarDto,
  ) {
    return this.svc.fusionar(tipo, id, dto.haciaId);
  }
}

@Module({
  controllers: [CatalogosController],
  providers: [CatalogosService],
  exports: [CatalogosService],
})
export class CatalogosModule {}
