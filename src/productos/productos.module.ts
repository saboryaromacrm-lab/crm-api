import {
  Body, Controller, Delete, Get, Inject, Injectable, Module, BadRequestException,
  NotFoundException, Param, ParseIntPipe, Patch, Post, Put, Query,
} from '@nestjs/common';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min,
} from 'class-validator';
import { and, asc, eq, gt, inArray, ne, or, sql } from 'drizzle-orm';
import { ALICUOTAS_TEXTO, esAlicuotaValida } from '../common/iva';
import { DRIZZLE, Database } from '../db/drizzle';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { tienePermiso } from '../auth/auth.guard';
import { ConfiguracionModule, ConfiguracionService } from '../configuracion/configuracion.module';
import { ListasModule, ListasService } from '../listas/listas.module';
import { PreciosModule, HistorialPreciosService } from '../precios/precios.module';
import { CatalogosModule } from '../catalogos/catalogos.module';
import {
  categorias, comprobanteItems, envioCafeteriaItems, etiquetas, incidencias, marcas, movimientos,
  pedidoCafeteriaItems, presentaciones, presupuestoItems, productoEtiquetas, productoListas,
  productoProveedores, productos, proveedores, stock, subcategorias, sucursales,
  transferenciaItems, vencimientos, ventaItems,
} from '../db/schema';
import {
  costoNetoEntry, costoNetoPresentacion, costosFormato, formatoActivo, precioVentaFila,
  type OpcionesPrecio,
} from '../inventario/pricing';
import { PREFIJOS_INTERNOS, armarEan13, esEan13, secuenciaDe } from './ean13';

/*
 * Las alícuotas legales de IVA viven en `common/iva`: es una lista cerrada a
 * propósito —tipear 2.1 en vez de 21 no da error y descalabra los precios en
 * silencio— y la usan también los comprobantes de compra. Estaba solo acá, así
 * que el alta de un comprobante aceptaba cualquier número.
 */

/** Ver `estadoProductoEnum`: activo → discontinuado → archivado, y vuelta. */
const ESTADOS_PRODUCTO = ['activo', 'discontinuado', 'archivado'] as const;

/**
 * Estados de stock que representan mercadería VIVA: la que todavía se puede
 * vender o está por moverse. Lo vencido y lo defectuoso no están acá — ya
 * salieron de circulación, y exigir que estén en cero para archivar dejaría
 * productos imposibles de archivar para siempre.
 */
const ESTADOS_STOCK_VIVO = ['disponible', 'comprometido', 'retenido', 'en_transito'] as const;

class CambiarEstadoDto {
  @IsIn(ESTADOS_PRODUCTO as unknown as string[]) estado!: 'activo' | 'discontinuado' | 'archivado';
  /** Por qué se da de baja. Lo lee quien decide si vale reactivarlo. */
  @IsOptional() @IsString() @MaxLength(300) motivo?: string;
}

class ArchivarLoteDto {
  @IsArray() ids!: number[];
  @IsOptional() @IsString() @MaxLength(300) motivo?: string;
}

class UpsertProductoDto {
  @IsString() nombre!: string;
  @IsOptional() @IsString() descripcion?: string;

  @IsOptional() @IsString() codigoPropio?: string;
  @IsOptional() @IsString() codigoBarras?: string;
  @IsOptional() @IsString() dun?: string;
  @IsOptional() @IsNumber() unidadesPorBulto?: number;

  @IsOptional() @IsInt() marcaId?: number | null;
  @IsOptional() @IsInt() categoriaId?: number | null;
  @IsOptional() @IsInt() subcategoriaId?: number | null;
  @IsOptional() @IsArray() etiquetas?: number[];

  @IsOptional() @IsNumber() iva?: number;
  @IsOptional() @IsInt() redondeo?: number | null;
  @IsOptional() @IsNumber() stockMin?: number;

  @IsOptional() @IsBoolean() publicado?: boolean;
  @IsOptional() @IsString() idExterno?: string;

  /**
   * Granel que NO se vende suelto: existe solo para fraccionarse (el "SOLO
   * STOCK" del sistema viejo). El POS no lo ofrece suelto y la venta lo
   * rechaza; sus presentaciones se venden normal.
   */
  @IsOptional() @IsBoolean() soloFraccionar?: boolean;

  /** Solo en el alta: después el tipo no se cambia (hay stock atado a él). */
  @IsOptional() @IsBoolean() esGranel?: boolean;

  /**
   * Solo en el alta: el proveedor con el que llega el producto. Crea la
   * relación producto/proveedor de entrada, así el producto ya aparece en el
   * buscador de la factura de ese proveedor — sin este campo, la relación
   * recién nacería al cargar el primer comprobante y el filtro lo ocultaría.
   * Para sumar más proveedores después está el Formato de Compra del producto.
   */
  @IsOptional() @IsInt() proveedorId?: number;
  /** Costo de lista de ese proveedor, si ya se conoce (opcional). */
  @IsOptional() @IsNumber() costoInicial?: number;
  /**
   * La ficha comercial del formato inicial (solo alta, con proveedorId): el
   * código con el que ESE proveedor llama al producto, su escala de descuentos
   * en cascada y su flete. Son los mismos campos del Formato de Compra — el
   * alta en dos etapas los pide de entrada para que el producto nazca completo.
   */
  @IsOptional() @IsString() @MaxLength(60) codigoProveedor?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) descuento?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) descuento2?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) descuento3?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) descuento4?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) flete?: number;
}

/**
 * IMPORTACIÓN MASIVA. El plan llega armado desde el navegador, que ya parseó
 * los archivos y mostró la vista previa: acá se valida contra la base y se
 * escribe. Las marcas y los rubros viajan por NOMBRE porque el que importa no
 * conoce los ids — el servidor reusa el que existe o lo crea.
 */
/** Tope de renglones por importación. Ver `importar()`. */
export const MAX_ITEMS_IMPORT = 3000;

class ImportarDto {
  @IsInt() proveedorId!: number;
  /*
   * SIN TOPE, esto era una transacción de decenas de miles de inserts
   * secuenciales con locks sobre `productos`, `marcas` y `categorias`: minutos
   * en los que nadie más puede guardar nada del catálogo. El límite del body son
   * 4 MB, que dan para unos 20.000 items. La masiva de precios ya se defiende con
   * un tope de 5000 filas; acá no había ninguno.
   *
   * 3000 es holgado: el catálogo entero del sistema viejo entró en 92 productos.
   */
  @IsArray() @ArrayMaxSize(MAX_ITEMS_IMPORT, {
    message: `Demasiados renglones en una sola importación (máximo ${MAX_ITEMS_IMPORT}). Partí el archivo.`,
  }) items!: any[];
}

@Injectable()
export class ProductosService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly cfg: ConfiguracionService,
    private readonly listas: ListasService,
    private readonly evolucion: HistorialPreciosService,
  ) {}

  /* ------------------------------ Armado ------------------------------ */

  /**
   * Arma N productos con SIETE consultas, no siete por producto. `list()` corre
   * cada vez que se abre Compras: con la versión anterior (una tanda de
   * consultas por fila) el catálogo se ponía más lento con cada alta.
   *
   * `get()` reusa esto mismo con un solo producto, así que hay una sola forma
   * de armar la respuesta y no pueden divergir.
   */
  /**
   * `verCostos`: si es false, la respuesta sale SIN los costos de compra ni los
   * márgenes. Ver el recorte al final de este método.
   */
  private async assembleMany(prods: any[], verCostos = true) {
    if (!prods.length) return [];
    const ids = prods.map((p) => p.id);
    const solo = ids.length === 1 ? ids[0] : null;
    // Con un solo producto se filtra en la base; con todos, traer la tabla
    // entera y cruzar en memoria sale más barato que N consultas filtradas.
    const filtro = (col: any) => (solo != null ? eq(col, solo) : undefined);

    const [pres, provs, formato, etqs, cfg, cat, cats] = await Promise.all([
      this.db.select().from(presentaciones).where(filtro(presentaciones.productoId)),
      this.db.select().from(productoProveedores).where(filtro(productoProveedores.productoId)),
      solo != null ? this.listas.formatoDe(solo) : this.listas.formatoTodos(),
      this.db.select().from(productoEtiquetas).where(filtro(productoEtiquetas.productoId)),
      this.cfg.get('ventas'),
      this.listas.catalogo(),
      this.catalogoPlano(),
    ]);

    const activas = cat.listas.filter((l: any) => l.activa);
    const porListaId = new Map(activas.map((l: any) => [l.id, l]));
    const base = activas.find((l: any) => l.id === cfg.listaBaseId) || activas[0] || null;

    /** Agrupa por `productoId` una sola vez, para no filtrar la lista por fila. */
    const idx = (rows: any[]): Map<number, any[]> => {
      const m = new Map<number, any[]>();
      for (const r of rows) {
        const arr = m.get(r.productoId);
        if (arr) arr.push(r); else m.set(r.productoId, [r]);
      }
      return m;
    };
    const presDe = idx(pres);
    const provsDe = idx(provs);
    const formatoDe = idx(formato);
    const etqsDe = idx(etqs);
    /** Las filas de formato de venta de cada PAQUETE, aparte de las de su madre. */
    const formatoPresDe = new Map<number, any[]>();
    for (const f of formato) {
      if (!f.presentacionId) continue;
      const arr = formatoPresDe.get(f.presentacionId);
      if (arr) arr.push(f); else formatoPresDe.set(f.presentacionId, [f]);
    }

    /**
     * FORMATO DE VENTA hecho precio: las filas de algo que se vende, con la
     * identidad de su lista y los tres precios ya derivados.
     *
     * Lo usan la madre y cada paquete sin distinción — un paquete es la misma
     * cosa con otro costo (el del kilo × su tamaño). Que el armado sea uno es lo
     * que evita que la madre y sus hijos deriven el precio de dos maneras.
     */
    const armarFormato = (filas: any[], costo: number, opts: OpcionesPrecio) => filas
      .filter((f: any) => porListaId.has(f.listaId))
      .map((f: any) => {
        const l: any = porListaId.get(f.listaId);
        const pv = precioVentaFila(costo, f, opts);
        return {
          listaId: f.listaId,
          modalidadId: l.modalidadId, modalidad: l.modalidad,
          numero: l.numero, nombre: l.nombre, etiqueta: l.etiqueta, orden: l.orden,
          modoPrecio: f.modoPrecio,
          markup: f.markup,
          precioFijo: f.precioFijo,
          unidades: f.unidades,
          codigoBarras: f.codigoBarras,
          unidadesMinimas: f.unidadesMinimas,
          precio: pv.netoUnitario,
          precioFinalUnitario: pv.finalUnitario,
          precioFinalFormato: pv.finalFormato,
        };
      })
      .sort((a: any, b: any) => a.orden - b.orden);

    /** El piso: lo que se paga sin que el ticket habilite nada. */
    const filaPiso = (listas: any[]) => listas.find((l) => l.listaId === base?.id) ?? listas[listas.length - 1] ?? null;

    return prods.map((prod) => {
      const mios = provsDe.get(prod.id) ?? [];
      const active = formatoActivo(mios);
      const costoNeto = costoNetoEntry(active, prod.iva);
      // El redondeo del producto pisa al de configuración; null = heredar.
      const opts = { iva: prod.iva, redondeo: prod.redondeo ?? cfg.redondeoPrecio };

      // FORMATO DE VENTA del producto SUELTO: las filas sin presentación. Las de
      // sus paquetes van con cada paquete — si entraran acá, la madre mostraría
      // como propios los precios de sus hijos.
      const listas = armarFormato((formatoDe.get(prod.id) ?? []).filter((f: any) => !f.presentacionId), costoNeto, opts);

      const misEtq = (etqsDe.get(prod.id) ?? []).map((e: any) => e.etiquetaId);

      return {
        ...prod,
        // Nombres resueltos: la pantalla no tiene que cruzar catálogos, y las
        // vistas que ya usaban `marca`/`categoria` como texto siguen andando.
        marca: cats.marca.get(prod.marcaId) ?? '',
        categoria: cats.categoria.get(prod.categoriaId) ?? '',
        subcategoria: cats.subcategoria.get(prod.subcategoriaId) ?? '',
        etiquetas: misEtq,
        etiquetasNombres: misEtq.map((id: number) => cats.etiqueta.get(id)).filter(Boolean),
        costoNeto,
        /*
         * Cada paquete con SU formato de venta y su costo derivado. `precio` es
         * el del piso, y es NULL cuando el paquete todavía no tiene ninguna
         * lista cargada: no es cero, es "no tiene precio" — el POS lo bloquea y
         * la etiqueta avisa antes de imprimir. Un cero se vendería.
         */
        presentaciones: (presDe.get(prod.id) ?? []).map((pr: any) => {
          const costoPaquete = costoNetoPresentacion(costoNeto, pr.tamKg);
          const suyas = armarFormato(formatoPresDe.get(pr.id) ?? [], costoPaquete, opts);
          const piso = filaPiso(suyas);
          return {
            ...pr,
            costoNeto: costoPaquete,
            listas: suyas,
            sinFormato: suyas.length === 0,
            precio: piso ? piso.precio : null,
            precioFinal: piso ? piso.precioFinalUnitario : null,
          };
        }),
        /*
         * FORMATO DE COMPRA: cada uno con su cadena ya derivada (lista →
         * descuentos → flete → neto → IVA), para que la pantalla solo muestre.
         *
         * SE RECORTA SEGÚN QUIÉN PREGUNTA. Acá viajan el costo de compra, los
         * cuatro descuentos, el flete y el costo neto — o sea el MARGEN de cada
         * producto. Este listado lo lee todo el sistema (el POS necesita los
         * precios), así que quedaba abierto a cualquier sesión mientras
         * `/precios/historial` —el mismo tipo de dato— estaba cerrado con
         * permiso. Era la inconsistencia de abrir las lecturas: se cerró una
         * puerta y quedó la otra.
         */
        formatosCompra: mios.map((pv: any) => (verCostos
          ? {
            ...pv,
            ...costosFormato(pv, prod.iva),
            costoNeto: costoNetoEntry(pv, prod.iva),
          }
          /*
           * Sin permiso se recortan LOS IMPORTES, no la fila entera. Lo
           * sensible es cuánto se paga, no de quién se compra: vaciar el arreglo
           * rompía en silencio todo filtro por proveedor —el del listado de
           * productos y el del explorador del catálogo del pedido, que hace
           * `formatosCompra.some(e => e.proveedorId === X)` y habría devuelto
           * cero resultados sin decir por qué.
           */
          : {
            id: pv.id,
            productoId: pv.productoId,
            proveedorId: pv.proveedorId,
            /** El tamaño del bulto ("la bolsa es de 20 kg") no es un importe. */
            cantidad: pv.cantidad,
            usarParaPrecio: pv.usarParaPrecio,
            codigoProveedor: pv.codigoProveedor,
          })),
        listas: verCostos ? listas : listas.map((l: any) => ({ ...l, markup: null })),
      };
    });
  }

  /** Diccionarios id → nombre de los cuatro catálogos, para resolver sin joins. */
  private async catalogoPlano() {
    const [ms, cs, ss, es] = await Promise.all([
      this.db.select({ id: marcas.id, nombre: marcas.nombre }).from(marcas),
      this.db.select({ id: categorias.id, nombre: categorias.nombre }).from(categorias),
      this.db.select({ id: subcategorias.id, nombre: subcategorias.nombre }).from(subcategorias),
      this.db.select({ id: etiquetas.id, nombre: etiquetas.nombre }).from(etiquetas),
    ]);
    const mapa = (rows: { id: number; nombre: string }[]) => new Map(rows.map((r) => [r.id, r.nombre]));
    return { marca: mapa(ms), categoria: mapa(cs), subcategoria: mapa(ss), etiqueta: mapa(es) };
  }

  async list(verCostos = true) {
    const rows = await this.db.select().from(productos).orderBy(productos.id);
    return this.assembleMany(rows, verCostos);
  }

  async get(id: number, verCostos = true) {
    const [p] = await this.db.select().from(productos).where(eq(productos.id, id)).limit(1);
    if (!p) throw new NotFoundException('Producto inexistente.');
    const [armado] = await this.assembleMany([p], verCostos);
    return armado;
  }

  /* ---------------------------- Validaciones ---------------------------- */

  /**
   * Los tres códigos del producto (propio, de barras, DUN) más los de las
   * presentaciones tienen que ser únicos ENTRE TODOS. Si dos cosas responden al
   * mismo código, el escáner de la caja queda sin desempate y termina cobrando
   * cualquier cosa.
   *
   * Los índices de la base garantizan la unicidad dentro de cada tabla; el
   * cruce entre `productos` y `presentaciones` solo se puede validar acá.
   */
  private async validarCodigos(dto: UpsertProductoDto, exceptoId?: number) {
    const campos: [string, string][] = [
      ['código propio', (dto.codigoPropio ?? '').trim()],
      ['código de barras', (dto.codigoBarras ?? '').trim()],
      ['DUN', (dto.dun ?? '').trim()],
    ];
    const usados = campos.filter(([, v]) => v !== '');
    if (!usados.length) return;

    // Repetidos dentro del mismo formulario.
    const vistos = new Map<string, string>();
    for (const [etq, val] of usados) {
      const previo = vistos.get(val);
      if (previo) throw new BadRequestException(`El ${etq} y el ${previo} no pueden ser iguales.`);
      vistos.set(val, etq);
    }

    const valores = usados.map(([, v]) => v);
    const condProd = or(
      inArray(productos.codigoPropio, valores),
      inArray(productos.codigoBarras, valores),
      inArray(productos.dun, valores),
    );
    const [choqueProd, choquePres] = await Promise.all([
      this.db.select({ id: productos.id, nombre: productos.nombre })
        .from(productos)
        .where(exceptoId ? and(ne(productos.id, exceptoId), condProd) : condProd)
        .limit(1),
      this.db.select({ id: presentaciones.id, productoId: presentaciones.productoId })
        .from(presentaciones)
        .where(inArray(presentaciones.codigoBarras, valores))
        .limit(1),
    ]);
    if (choqueProd[0]) {
      throw new BadRequestException(`Ese código ya lo usa el producto "${choqueProd[0].nombre}".`);
    }
    if (choquePres[0]) {
      throw new BadRequestException('Ese código ya lo usa una presentación de otro producto.');
    }
  }

  /** La subcategoría tiene que colgar de la categoría elegida. */
  private async validarClasificacion(dto: UpsertProductoDto) {
    if (!dto.subcategoriaId) return;
    const [sub] = await this.db.select().from(subcategorias)
      .where(eq(subcategorias.id, dto.subcategoriaId)).limit(1);
    if (!sub) throw new BadRequestException('Subcategoría inválida.');
    if (dto.categoriaId && sub.categoriaId !== dto.categoriaId) {
      throw new BadRequestException('La subcategoría no pertenece a esa categoría.');
    }
  }

  private validarIva(iva?: number) {
    if (iva == null) return;
    if (!esAlicuotaValida(iva)) {
      throw new BadRequestException(`Alícuota de IVA inválida. Las válidas son: ${ALICUOTAS_TEXTO}%.`);
    }
  }

  /**
   * TODOS los códigos que ya identifican algo, en un solo Set.
   *
   * Son TRES tablas y no una: el producto (su EAN, su código propio y el DUN
   * del bulto), la presentación fraccionada y el FORMATO DE VENTA (el EAN de la
   * caja). Las tres se escanean en la misma caja, así que un código repetido
   * entre ellas es una ambigüedad — y el único de la base no puede verlo porque
   * es por tabla.
   */
  private async codigosEnUso(): Promise<Set<string>> {
    const [prods, press, formatos] = await Promise.all([
      this.db.select({
        barras: productos.codigoBarras, propio: productos.codigoPropio, dun: productos.dun,
      }).from(productos),
      this.db.select({ codigo: presentaciones.codigoBarras }).from(presentaciones),
      this.db.select({ codigo: productoListas.codigoBarras }).from(productoListas),
    ]);
    const set = new Set<string>();
    for (const p of prods) for (const c of [p.barras, p.propio, p.dun]) if (c) set.add(c);
    for (const p of press) if (p.codigo) set.add(p.codigo);
    for (const f of formatos) if (f.codigo) set.add(f.codigo);
    return set;
  }

  /** Prefijo de la serie interna, salteando el que usa la balanza. */
  private async prefijoInterno() {
    let balanza = '20';
    try {
      const cfg: any = await this.cfg.get('ventas');
      balanza = String(cfg?.balanzaPrefijo || '20');
    } catch { /* sin config, el default de la balanza es 20 */ }
    return PREFIJOS_INTERNOS.find((p) => p !== balanza) ?? PREFIJOS_INTERNOS[0];
  }

  /**
   * Un EAN-13 propio LIBRE, para el botón "Generar" de la presentación.
   *
   * Sigue la secuencia de la serie (el mayor emitido + 1) en vez de sortear un
   * número: así los códigos internos quedan legibles y ordenados por antigüedad.
   * Igual se comprueba contra todos los códigos en uso antes de devolverlo — la
   * secuencia se puede haber saltado a mano, y dos altas al mismo tiempo pueden
   * pedir el mismo número (el único de la base es la última palabra).
   */
  async siguienteEan13(excluir: string[] = []) {
    const prefijo = await this.prefijoInterno();
    const usados = await this.codigosEnUso();
    // Los que ya están en la pantalla y todavía no se guardaron: sin esto,
    // agregar tres presentaciones de una daba el mismo código tres veces.
    for (const c of excluir) if (c) usados.add(String(c).trim());
    let ultima = 0;
    for (const c of usados) {
      const sec = secuenciaDe(c, prefijo);
      if (sec != null && sec > ultima) ultima = sec;
    }
    for (let i = 1; i <= 1000; i += 1) {
      const codigo = armarEan13(prefijo, ultima + i);
      if (!usados.has(codigo)) return { codigo, prefijo };
    }
    throw new BadRequestException('No encontré un código libre en la serie interna. Avisá: hay que ampliar el prefijo.');
  }

  /**
   * Siguiente código propio libre. Mira solo los que son puramente numéricos:
   * si alguien cargó "ALF-001" a mano, no rompe la secuencia ni la hereda.
   */
  async siguienteCodigo() {
    const [r] = await this.db
      .select({ max: sql<string>`coalesce(max("codigo_propio"::bigint), 0)` })
      .from(productos)
      .where(sql`"codigo_propio" ~ '^[0-9]+$'`);
    return { codigo: String((Number(r?.max) || 0) + 1) };
  }

  /* ------------------------------ Escritura ------------------------------ */

  /** Campos comunes al alta y a la edición, ya normalizados. */
  private valores(dto: UpsertProductoDto, previo?: any) {
    return {
      nombre: dto.nombre.trim(),
      descripcion: (dto.descripcion ?? previo?.descripcion ?? '').trim(),
      codigoPropio: (dto.codigoPropio ?? previo?.codigoPropio ?? '').trim(),
      codigoBarras: (dto.codigoBarras ?? previo?.codigoBarras ?? '').trim(),
      dun: (dto.dun ?? previo?.dun ?? '').trim(),
      unidadesPorBulto: Number(dto.unidadesPorBulto ?? previo?.unidadesPorBulto ?? 1) || 1,
      marcaId: dto.marcaId ?? null,
      categoriaId: dto.categoriaId ?? null,
      subcategoriaId: dto.subcategoriaId ?? null,
      iva: dto.iva ?? previo?.iva ?? 21,
      stockMin: Number(dto.stockMin ?? previo?.stockMin ?? 0) || 0,
      // `undefined` = no lo mandaron (queda como estaba); `null` = heredar.
      redondeo: dto.redondeo === undefined ? (previo?.redondeo ?? null) : dto.redondeo,
      publicado: dto.publicado ?? previo?.publicado ?? false,
      soloFraccionar: dto.soloFraccionar ?? previo?.soloFraccionar ?? false,
      idExterno: (dto.idExterno ?? previo?.idExterno ?? '').trim(),
    };
  }

  /**
   * Siguiente código interno: el mayor numérico existente + 1. TODO producto
   * tiene código interno — es el que el negocio usa para buscar y para las
   * planillas; si el alta no lo trae, se asigna solo y no quedan huecos.
   */
  private async proximoCodigoPropio(): Promise<string> {
    const rows = await this.db.select({ c: productos.codigoPropio }).from(productos);
    let max = 1000;
    for (const r of rows) {
      const n = parseInt(r.c, 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return String(max + 1);
  }

  async create(dto: UpsertProductoDto) {
    if (dto.soloFraccionar && !dto.esGranel) {
      throw new BadRequestException('"Solo para fraccionar" es para productos a granel.');
    }
    this.validarIva(dto.iva);
    await this.validarClasificacion(dto);
    await this.validarCodigos(dto);

    // Se valida ANTES de insertar: un proveedor inválido no puede dejar el
    // producto creado a medias, sin la relación que el alta prometía.
    let prov: any = null;
    if (dto.proveedorId) {
      [prov] = await this.db.select().from(proveedores).where(eq(proveedores.id, Number(dto.proveedorId))).limit(1);
      if (!prov) throw new BadRequestException('El proveedor elegido no existe.');
    }

    const valores = this.valores(dto);
    if (!valores.codigoPropio) valores.codigoPropio = await this.proximoCodigoPropio();

    const [p] = await this.db.insert(productos).values({
      ...valores,
      tipo: dto.esGranel ? 'granel' : 'entero',
    }).returning();

    if (dto.etiquetas?.length) await this.setEtiquetas(p.id, dto.etiquetas);

    // La relación nace con el producto. Es la primera, así que fija el precio
    // (misma regla que la recepción: sin alternativa, no hay nada que elegir).
    if (prov) {
      await this.db.insert(productoProveedores).values({
        productoId: p.id,
        proveedorId: prov.id,
        cantidad: 1,
        costo: Number(dto.costoInicial) || 0,
        descuento: Number(dto.descuento) || 0,
        descuento2: Number(dto.descuento2) || 0,
        descuento3: Number(dto.descuento3) || 0,
        descuento4: Number(dto.descuento4) || 0,
        flete: Number(dto.flete) || 0,
        codigoProveedor: (dto.codigoProveedor ?? '').trim(),
        usarParaPrecio: true,
      });
    }
    return this.get(p.id);
  }

  /* ============================ IMPORTACIÓN MASIVA ============================ *
   * Un catálogo entero (un proveedor, cientos de productos) en UNA transacción:
   * o entra todo o no entra nada. Sin esto, un choque de código en el producto
   * 60 dejaba 59 a medias y el segundo intento duplicaba.
   *
   * El PLAN llega armado desde el navegador (que ya mostró la vista previa):
   * acá se valida contra la base, se resuelven marcas y rubros por NOMBRE
   * —creando los que falten— y se escribe. Es IDEMPOTENTE por código interno:
   * lo que ya existe se saltea y se informa, nunca se sobreescribe (actualizar
   * costos es trabajo de la factura, no de una importación).
   */
  async importar(dto: ImportarDto) {
    const items = dto.items || [];
    if (!items.length) throw new BadRequestException('No hay nada para importar.');

    const [prov] = await this.db.select().from(proveedores)
      .where(eq(proveedores.id, Number(dto.proveedorId))).limit(1);
    if (!prov) throw new BadRequestException('El proveedor elegido no existe.');

    const listasActivas = new Set((await this.listas.listasActivas()).map((l: any) => l.id));

    /* ---- Qué NO se puede crear: se descarta antes de abrir la transacción ---- */
    const codigosPropios = items.map((x) => (x.producto?.codigoPropio ?? '').trim()).filter(Boolean);
    const yaEnBase = codigosPropios.length
      ? await this.db.select({
        codigoPropio: productos.codigoPropio, nombre: productos.nombre, estado: productos.estado,
      }).from(productos).where(inArray(productos.codigoPropio, codigosPropios))
      : [];
    /* El importador nunca pisa lo que ya existe: lo saltea. Eso también evita
     * que un archivado REVIVA en silencio porque volvió a aparecer en el CSV —
     * pero el motivo tiene que decir que está dado de baja, si no el usuario
     * cree que ya está disponible y en realidad hay que reactivarlo. */
    const existentes = new Map(yaEnBase.map((p) => [
      p.codigoPropio,
      p.estado === 'activo' ? p.nombre : `${p.nombre} — ${p.estado}, hay que reactivarlo`,
    ]));

    // Todos los códigos de barras que ya usa el sistema (producto, presentación
    // o formato de venta): uno no puede identificar dos cosas distintas.
    const [barrasProd, barrasPres, barrasFmt] = await Promise.all([
      this.db.select({ c: productos.codigoBarras, d: productos.dun, p: productos.codigoPropio }).from(productos),
      this.db.select({ c: presentaciones.codigoBarras }).from(presentaciones),
      this.db.select({ c: productoListas.codigoBarras }).from(productoListas),
    ]);
    const barrasUsadas = new Set([
      ...barrasProd.flatMap((x) => [x.c, x.d]),
      ...barrasPres.map((x) => x.c),
      ...barrasFmt.map((x) => x.c),
    ].filter(Boolean));

    const saltados: { codigo: string; nombre: string; motivo: string }[] = [];
    const aCrear: any[] = [];
    const vistosCodigo = new Set<string>();
    const vistosBarras = new Set<string>();

    for (const it of items) {
      const p = it.producto || {};
      const codigo = (p.codigoPropio ?? '').trim();
      const nombre = (p.nombre ?? '').trim();
      if (!nombre) { saltados.push({ codigo, nombre, motivo: 'sin nombre' }); continue; }
      if (!codigo) { saltados.push({ codigo, nombre, motivo: 'sin código interno' }); continue; }
      if (existentes.has(codigo)) {
        saltados.push({ codigo, nombre, motivo: `ya existe como "${existentes.get(codigo)}"` });
        continue;
      }
      if (vistosCodigo.has(codigo)) { saltados.push({ codigo, nombre, motivo: 'código repetido en el archivo' }); continue; }
      if (!esAlicuotaValida(p.iva)) {
        saltados.push({ codigo, nombre, motivo: `IVA inválido (${p.iva}%)` });
        continue;
      }
      // Los códigos de barras del producto y de sus presentaciones, juntos.
      const barras = [p.codigoBarras, ...(it.presentaciones || []).map((x: any) => x.codigoBarras)]
        .map((c) => (c ?? '').trim()).filter(Boolean);
      const choca = barras.find((c) => barrasUsadas.has(c) || vistosBarras.has(c));
      if (choca) { saltados.push({ codigo, nombre, motivo: `el código de barras ${choca} ya está en uso` }); continue; }

      vistosCodigo.add(codigo);
      barras.forEach((c) => vistosBarras.add(c));
      aCrear.push(it);
    }

    if (!aCrear.length) return { ok: true, creados: 0, saltados, marcasCreadas: [], rubrosCreados: [] };

    /* ---- Marcas y rubros por nombre: se reusa lo que hay, se crea lo que falta ---- */
    const marcasCreadas: string[] = [];
    const rubrosCreados: string[] = [];
    const ids: number[] = [];

    await this.db.transaction(async (tx) => {
      const clave = (s: string) => s.trim().toLowerCase();
      const marcaPorNombre = new Map(
        (await tx.select().from(marcas)).map((m: any) => [clave(m.nombre), m.id]),
      );
      const catPorNombre = new Map(
        (await tx.select().from(categorias)).map((c: any) => [clave(c.nombre), c.id]),
      );
      const subPorNombre = new Map(
        (await tx.select().from(subcategorias)).map((s: any) => [clave(s.nombre), s.id]),
      );

      const idMarca = async (nombre?: string) => {
        const n = (nombre ?? '').trim();
        if (!n) return null;
        if (marcaPorNombre.has(clave(n))) return marcaPorNombre.get(clave(n))!;
        const [m] = await tx.insert(marcas).values({ nombre: n }).returning();
        marcaPorNombre.set(clave(n), m.id);
        marcasCreadas.push(n);
        return m.id;
      };
      const idCategoria = async (nombre?: string) => {
        const n = (nombre ?? '').trim() || 'Alimentos';
        if (catPorNombre.has(clave(n))) return catPorNombre.get(clave(n))!;
        const [c] = await tx.insert(categorias).values({ nombre: n }).returning();
        catPorNombre.set(clave(n), c.id);
        rubrosCreados.push(n);
        return c.id;
      };
      const idSub = async (nombre: string | undefined, categoriaId: number) => {
        const n = (nombre ?? '').trim();
        if (!n) return null;
        if (subPorNombre.has(clave(n))) return subPorNombre.get(clave(n))!;
        const [s] = await tx.insert(subcategorias).values({ nombre: n, categoriaId }).returning();
        subPorNombre.set(clave(n), s.id);
        rubrosCreados.push(n);
        return s.id;
      };

      for (const it of aCrear) {
        const p = it.producto;
        const categoriaId = await idCategoria(p.categoriaNombre);
        const [creado] = await tx.insert(productos).values({
          nombre: p.nombre.trim(),
          descripcion: (p.descripcion ?? '').trim(),
          codigoPropio: p.codigoPropio.trim(),
          codigoBarras: (p.codigoBarras ?? '').trim(),
          dun: '',
          unidadesPorBulto: Math.max(1, Number(p.unidadesPorBulto) || 1),
          marcaId: await idMarca(p.marcaNombre),
          categoriaId,
          subcategoriaId: await idSub(p.subcategoriaNombre, categoriaId),
          iva: Number(p.iva),
          tipo: p.esGranel ? 'granel' : 'entero',
          publicado: !!p.publicado,
          idExterno: String(p.idExterno ?? '').trim(),
        }).returning();
        ids.push(creado.id);

        const f = it.formatoCompra || {};
        await tx.insert(productoProveedores).values({
          productoId: creado.id,
          proveedorId: prov.id,
          cantidad: Number(f.cantidad) > 0 ? Number(f.cantidad) : 1,
          costo: Number(f.costo) || 0,
          descuento: Number(f.descuento) || 0,
          descuento2: Number(f.descuento2) || 0,
          descuento3: Number(f.descuento3) || 0,
          descuento4: Number(f.descuento4) || 0,
          flete: Number(f.flete) || 0,
          modoCosto: f.modoCosto === 'final' ? 'final' : 'lista',
          costoFinal: Number(f.costoFinal) || 0,
          usarParaPrecio: true, // es el único formato del producto recién creado
          codigoProveedor: (f.codigoProveedor ?? '').trim(),
        });

        /*
         * El formato de venta se escribe con ESTE tx, no con `setFormato`: ese
         * abre su propia transacción y las filas quedarían fuera del "todo o
         * nada" (y podrían bloquearse entre sí). Los formatos importados no
         * llevan código de barras propio —los códigos viven en el producto y en
         * sus presentaciones—, así que no hay nada más que validar acá.
         */
        const filasVenta = (crudas: any[], presId: number | null) => {
          const vistas = new Set<number>();
          return (crudas || [])
            .filter((l: any) => listasActivas.has(Number(l.listaId)))
            .filter((l: any) => (l.modoPrecio === 'precio' ? Number(l.precioFijo) > 0 : true))
            .filter((l: any) => {
              const id = Number(l.listaId);
              if (vistas.has(id)) return false;
              vistas.add(id);
              return true;
            })
            .map((l: any) => ({
              productoId: creado.id,
              presentacionId: presId,
              listaId: Number(l.listaId),
              modoPrecio: (l.modoPrecio === 'precio' ? 'precio' : 'markup') as 'markup' | 'precio',
              markup: Number(l.markup) || 0,
              precioFijo: Number(l.precioFijo) || 0,
              unidades: Math.max(1, Number(l.unidades) || 1),
              codigoBarras: '',
              unidadesMinimas: Math.max(0, Number(l.unidadesMinimas) || 0),
            }));
        };

        const delProducto = filasVenta(it.listas, null);
        if (delProducto.length) await tx.insert(productoListas).values(delProducto);

        /*
         * Las presentaciones son del granel: en un producto entero no existen.
         * Cada una entra con SU formato de venta, que el archivo del sistema
         * viejo ya trae — allá el markup era por presentación (el kilo al 48%, el
         * de 250 g al 66%). Antes eso se traducía a un `recargo` sobre la madre;
         * ahora el modelo es el mismo que el del sistema viejo y el markup del
         * paquete entra tal cual. Se insertan de a una para usar el id que
         * devuelve cada una, sin depender del orden del insert múltiple.
         */
        if (p.esGranel) {
          for (const x of (it.presentaciones || [])) {
            if (!(Number(x.tamKg) > 0)) continue;
            const [row] = await tx.insert(presentaciones).values({
              productoId: creado.id,
              tamKg: Number(x.tamKg),
              codigoBarras: (x.codigoBarras ?? '').trim(),
            }).returning();
            const suyas = filasVenta(x.listas, row.id);
            if (suyas.length) await tx.insert(productoListas).values(suyas);
          }
        }
      }
    });

    // El primer precio de cada producto queda en la evolución: un solo snapshot
    // para todos, no uno por producto (son cientos).
    if (ids.length) await this.evolucion.snapshot(ids, 'inicial');

    return { ok: true, creados: ids.length, saltados, marcasCreadas, rubrosCreados };
  }

  async update(id: number, dto: UpsertProductoDto) {
    const [p] = await this.db.select().from(productos).where(eq(productos.id, id)).limit(1);
    if (!p) throw new NotFoundException('Producto inexistente.');

    // "Solo para fraccionar" es un candado sobre la venta SUELTA: en un
    // producto entero no significa nada y aceptarlo sería guardar ruido.
    if (dto.soloFraccionar && p.tipo !== 'granel') {
      throw new BadRequestException('"Solo para fraccionar" es para productos a granel.');
    }

    this.validarIva(dto.iva);
    await this.validarClasificacion(dto);
    await this.validarCodigos(dto, id);

    await this.db.update(productos).set(this.valores(dto, p)).where(eq(productos.id, id));
    if (dto.etiquetas) await this.setEtiquetas(id, dto.etiquetas);
    return this.get(id);
  }

  /* ==================== CICLO DE VIDA ====================
   *
   * El producto NO se borra: se da de baja y se puede reactivar. Eliminar de
   * verdad queda SOLO para el que no dejó ninguna huella (un duplicado del
   * importador, un alta con el dedo) — y cuando no se puede, el mensaje dice
   * cuál es la huella y qué hacer en su lugar.
   */

  /**
   * Todo lo que ata al producto a la historia del negocio. Cada entrada dice
   * cómo se llama en la pantalla, así el mensaje de error es entendible sin
   * saber nada de tablas.
   */
  private async huellas(id: number) {
    const cuenta = async (tabla: any, columna: any) => {
      const [r] = await this.db.select({ n: sql<number>`count(*)::int` })
        .from(tabla).where(eq(columna, id));
      return Number(r?.n) || 0;
    };
    const [ventas, compras, presup, movs, transf, incid, vencs, enviosCafe, pedidosCafe] = await Promise.all([
      cuenta(ventaItems, ventaItems.productoId),
      cuenta(comprobanteItems, comprobanteItems.productoId),
      cuenta(presupuestoItems, presupuestoItems.productoId),
      cuenta(movimientos, movimientos.productoId),
      cuenta(transferenciaItems, transferenciaItems.productoId),
      cuenta(incidencias, incidencias.productoId),
      cuenta(vencimientos, vencimientos.productoId),
      cuenta(envioCafeteriaItems, envioCafeteriaItems.productoId),
      cuenta(pedidoCafeteriaItems, pedidoCafeteriaItems.productoId),
    ]);
    const lista: string[] = [];
    if (ventas) lista.push(`${ventas} venta(s)`);
    if (compras) lista.push(`${compras} renglón(es) de compra`);
    if (presup) lista.push(`${presup} presupuesto(s)`);
    if (transf) lista.push(`${transf} transferencia(s)`);
    if (incid) lista.push(`${incid} incidencia(s)`);
    if (vencs) lista.push(`${vencs} registro(s) de vencimiento`);
    if (enviosCafe) lista.push(`${enviosCafe} envío(s) a la cafetería`);
    if (pedidosCafe) lista.push(`${pedidosCafe} pedido(s) de la cafetería`);
    if (movs) lista.push(`${movs} movimiento(s) de stock`);
    return lista;
  }

  /**
   * Cambia el estado del ciclo de vida. Los candados que importan:
   *   · Archivar exige que no quede stock (lo que hay en góndola no se puede
   *     vender si el producto está archivado: sería plata muerta). Se avisa
   *     dónde está para liquidarlo o darlo de baja por merma antes.
   *   · Archivar una madre de fraccionados exige que sus paquetes tampoco
   *     tengan stock — mismo criterio que borrar una presentación con stock.
   */
  async cambiarEstado(id: number, dto: CambiarEstadoDto) {
    const [p] = await this.db.select().from(productos).where(eq(productos.id, id)).limit(1);
    if (!p) throw new NotFoundException('Producto inexistente.');
    const estado = dto.estado;
    if (p.estado === estado) return this.get(id);

    if (estado === 'archivado') {
      /* Solo la mercadería VIVA frena el archivado: lo vencido y lo defectuoso
       * ya está fuera de circulación (nadie lo va a vender) y bloquear por eso
       * dejaría productos imposibles de archivar para siempre. Lo comprometido
       * y lo que viaja SÍ frenan: se van a mover.
       * Sin filtro de presentación a propósito: el stock de los fraccionados
       * cuenta igual — archivar la madre y dejar sus paquetes sin poder
       * venderse es el mismo problema, visto desde el otro lado. */
      const filas = await this.db.select({
        cantidad: stock.cantidad, sucursalId: stock.sucursalId, presentacionId: stock.presentacionId,
      }).from(stock).where(and(
        eq(stock.productoId, id),
        gt(stock.cantidad, 1e-9),
        inArray(stock.estado, [...ESTADOS_STOCK_VIVO]),
      ));
      if (filas.length) {
        const sucs = await this.db.select().from(sucursales);
        const detalle = filas.slice(0, 4).map((f) => {
          const suc = sucs.find((s) => s.id === f.sucursalId)?.nombre ?? `sucursal ${f.sucursalId}`;
          return `${f.cantidad} en ${suc}${f.presentacionId ? ' (fraccionado)' : ''}`;
        }).join(', ');
        throw new BadRequestException(
          `Todavía queda stock: ${detalle}. Archivado no se puede vender — liquidalo primero (una oferta) o dalo de baja por merma. Mientras tanto podés dejarlo "discontinuado": deja de comprarse pero se sigue vendiendo hasta agotar.`,
        );
      }
    }

    const [out] = await this.db.update(productos).set({
      estado,
      estadoDesde: new Date(),
      motivoBaja: estado === 'activo' ? '' : (dto.motivo ?? '').trim(),
    }).where(eq(productos.id, id)).returning();
    return { ...(await this.get(out.id)) };
  }

  /**
   * LOS DISCONTINUADOS QUE YA SE AGOTARON: candidatos a archivar.
   *
   * Es una SUGERENCIA, no un automatismo, y la diferencia importa. Archivar en
   * el acto en que se vende la última unidad rompería cosas reales: el catálogo
   * del POS se carga al abrir la caja, así que un cajero con el ticket ya
   * armado vería "está archivado" sobre algo que tenía en pantalla; y una
   * devolución o la anulación de ese mismo ticket devuelve el stock. Por eso
   * decide una persona (y el camino de vuelta sí es automático:
   * `despertarArchivado` en el inventario).
   *
   * Los tres filtros, cada uno por una razón:
   *   · sin stock VIVO en NINGUNA sucursal — incluido `en_transito`: lo que
   *     está arriba de un camión todavía va a llegar a algún lado;
   *   · sin movimientos en los últimos `DIAS_GRACIA` días — recién agotado, una
   *     devolución es probable y sugerir archivarlo el mismo día es ruido;
   *   · discontinuado, obviamente: el activo no se toca.
   */
  async sugerenciasArchivado() {
    const DIAS_GRACIA = 30;
    const corte = new Date();
    corte.setDate(corte.getDate() - DIAS_GRACIA);

    const filas = await this.db.select({
      id: productos.id,
      nombre: productos.nombre,
      codigoPropio: productos.codigoPropio,
      motivoBaja: productos.motivoBaja,
      estadoDesde: productos.estadoDesde,
      ultimoMovimiento: sql<string | null>`(
        select max(m.fecha) from movimientos m where m.producto_id = ${productos.id}
      )`,
    }).from(productos)
      .where(and(
        eq(productos.estado, 'discontinuado'),
        // Sin una sola unidad viva, en ninguna sucursal ni presentación.
        sql`not exists (
          select 1 from stock s
           where s.producto_id = ${productos.id}
             and s.cantidad > 1e-9
             and s.estado in ('disponible', 'comprometido', 'retenido', 'en_transito')
        )`,
        // Quieto hace rato: sin movimientos recientes (o sin ninguno nunca).
        sql`not exists (
          select 1 from movimientos m
           where m.producto_id = ${productos.id} and m.fecha >= ${corte}
        )`,
      ))
      .orderBy(asc(productos.nombre));

    return { diasGracia: DIAS_GRACIA, productos: filas };
  }

  /**
   * Archiva varios de una. Cada uno se revalida con `cambiarEstado` (el estado
   * pudo cambiar entre que se mostró la sugerencia y el clic: una devolución lo
   * despertó, alguien lo reactivó). Lo que no se pudo, se informa — nunca se
   * archiva a medias en silencio.
   */
  async archivarLote(ids: number[], motivo?: string) {
    const limpios = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    if (!limpios.length) throw new BadRequestException('No hay productos para archivar.');
    const archivados: string[] = [];
    const omitidos: { nombre: string; razon: string }[] = [];
    for (const id of limpios) {
      const [p] = await this.db.select({ nombre: productos.nombre }).from(productos)
        .where(eq(productos.id, id)).limit(1);
      try {
        await this.cambiarEstado(id, {
          estado: 'archivado',
          motivo: (motivo ?? '').trim() || 'Discontinuado y sin stock',
        } as CambiarEstadoDto);
        archivados.push(p?.nombre ?? String(id));
      } catch (e: any) {
        omitidos.push({ nombre: p?.nombre ?? String(id), razon: e?.message ?? 'no se pudo' });
      }
    }
    return { archivados, omitidos };
  }

  async remove(id: number) {
    const [p] = await this.db.select().from(productos).where(eq(productos.id, id)).limit(1);
    if (!p) throw new NotFoundException('Producto inexistente.');

    const conStock = await this.db.select().from(stock)
      .where(and(eq(stock.productoId, id), gt(stock.cantidad, 1e-9))).limit(1);
    if (conStock[0]) {
      throw new BadRequestException(
        'No se puede eliminar: el producto tiene stock. Si ya no se trae más, dalo de baja (se sigue vendiendo hasta agotar) en lugar de borrarlo.',
      );
    }

    const huellas = await this.huellas(id);
    if (huellas.length) {
      throw new BadRequestException(
        `No se puede eliminar: el producto ya tiene historia (${huellas.join(', ')}). Borrarlo dejaría documentos viejos incompletos. Dalo de baja: deja de aparecer y se puede reactivar cuando vuelvas a traerlo, conservando precios e historial.`,
      );
    }

    /* Sin huella: se puede borrar de verdad. Las filas de stock en CERO se
     * limpian primero — no son información y la FK es `restrict` desde la
     * 0051 (antes un cascade se llevaba existencias en silencio). */
    await this.db.transaction(async (tx) => {
      await tx.delete(stock).where(eq(stock.productoId, id));
      await tx.delete(productos).where(eq(productos.id, id));
    });
    return { ok: true };
  }

  /** Reemplaza el juego de etiquetas del producto. */
  async setEtiquetas(id: number, ids: number[]) {
    const limpios = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    await this.db.transaction(async (tx) => {
      await tx.delete(productoEtiquetas).where(eq(productoEtiquetas.productoId, id));
      if (limpios.length) {
        await tx.insert(productoEtiquetas)
          .values(limpios.map((etiquetaId) => ({ productoId: id, etiquetaId })));
      }
    });
  }

  /** Reemplaza las presentaciones del producto (granel). */
  async setPresentaciones(id: number, items: any[]) {
    const [p] = await this.db.select().from(productos).where(eq(productos.id, id)).limit(1);
    if (!p) throw new NotFoundException('Producto inexistente.');
    if (p.tipo !== 'granel') throw new BadRequestException('Solo los productos a granel tienen presentaciones.');

    const valid = (items || []).filter((x) => Number(x.tamKg) > 0).map((x) => ({
      id: Number(x.id) || null,
      productoId: id,
      tamKg: Number(x.tamKg),
      codigoBarras: (x.codigoBarras ?? '').trim(),
    }));

    /*
     * EL CÓDIGO NUEVO TIENE QUE SER UN EAN-13 DE VERDAD.
     *
     * Se exige solo en los códigos que NACEN O CAMBIAN acá. Los que ya estaban
     * pasan intactos aunque no cumplan: en la base hay 71 heredados del sistema
     * viejo (13 con el verificador mal y 58 que no llegan a 13 dígitos), y
     * rechazarlos dejaría esas presentaciones sin poder guardar ni un cambio de
     * recargo. Se arreglan de a uno, con el botón Generar, cuando toque.
     *
     * Vaciar el código SÍ se permite: es un acto deliberado para sacar uno malo.
     * Lo que no se permite es que una presentación NUEVA nazca sin código —
     * sería un paquete que la caja no puede escanear.
     */
    const previas = await this.db.select().from(presentaciones).where(eq(presentaciones.productoId, id));
    const codigoPrevio = new Map(previas.map((p: any) => [p.id, p.codigoBarras || '']));
    const comoDice = (tamKg: number) => (tamKg < 1 ? `${Math.round(tamKg * 1000)} g` : `${tamKg} kg`);
    for (const v of valid) {
      const antes = v.id ? (codigoPrevio.get(v.id) ?? '') : null;
      if (antes === v.codigoBarras) continue;  // no lo tocó: no se juzga
      if (!v.codigoBarras) {
        if (antes === null) {
          throw new BadRequestException(
            `La presentación de ${comoDice(v.tamKg)} necesita un código de barras: es el que la caja escanea en el paquete. Con el botón "Generar" sale uno propio.`,
          );
        }
        continue;  // se lo saca a propósito
      }
      if (!esEan13(v.codigoBarras)) {
        throw new BadRequestException(
          `El código "${v.codigoBarras}" de la presentación de ${comoDice(v.tamKg)} no es un EAN-13 válido: son 13 dígitos y el último es el verificador. Copiá el del fabricante o usá "Generar".`,
        );
      }
    }

    // Mismo criterio que en el producto: un código no puede identificar dos
    // cosas. Se valida contra las otras presentaciones y contra los productos.
    const codigos = valid.map((v) => v.codigoBarras).filter(Boolean);
    if (new Set(codigos).size !== codigos.length) {
      throw new BadRequestException('Hay dos presentaciones con el mismo código de barras.');
    }
    if (codigos.length) {
      const [ajeno] = await this.db.select({ id: productos.id, nombre: productos.nombre })
        .from(productos)
        .where(or(
          inArray(productos.codigoPropio, codigos),
          inArray(productos.codigoBarras, codigos),
          inArray(productos.dun, codigos),
        )).limit(1);
      if (ajeno) throw new BadRequestException(`Ese código ya lo usa el producto "${ajeno.nombre}".`);

      const [otra] = await this.db.select({ id: presentaciones.id, tamKg: presentaciones.tamKg, nombre: productos.nombre })
        .from(presentaciones)
        .innerJoin(productos, eq(productos.id, presentaciones.productoId))
        .where(and(ne(presentaciones.productoId, id), inArray(presentaciones.codigoBarras, codigos)))
        .limit(1);
      if (otra) {
        throw new BadRequestException(
          `Ese código ya lo usa la presentación de ${comoDice(otra.tamKg)} de "${otra.nombre}".`,
        );
      }

      /*
       * La TERCERA puerta, que faltaba: el código del FORMATO DE VENTA (el EAN
       * de la caja). El POS también busca por ahí, así que un código repetido
       * entre un paquete fraccionado y una caja hace que escanear cargue
       * cualquiera de los dos. El único de la base no lo ve: es por tabla.
       */
      const [formato] = await this.db.select({ nombre: productos.nombre, unidades: productoListas.unidades })
        .from(productoListas)
        .innerJoin(productos, eq(productos.id, productoListas.productoId))
        .where(inArray(productoListas.codigoBarras, codigos))
        .limit(1);
      if (formato) {
        throw new BadRequestException(
          `Ese código ya lo usa el formato de venta de "${formato.nombre}" (×${formato.unidades}).`,
        );
      }
    }

    /*
     * ACTUALIZA POR ID, no borra-y-reinserta. No es estilo: `stock` cascadea
     * por `presentacion_id`, así que el reemplazo total borraba EL STOCK de
     * todos los fraccionados en cada guardado de la pestaña — aunque no se
     * hubiera sacado ninguna. (La misma lección que `setFormatosCompra` con su
     * historial de costos.) Solo se borra lo que el usuario sacó de la lista,
     * y sacar una presentación CON STOCK se rechaza: ese stock son paquetes
     * reales en el depósito, no un renglón de configuración.
     */
    await this.db.transaction(async (tx) => {
      const actuales = await tx.select().from(presentaciones)
        .where(eq(presentaciones.productoId, id));
      const vigentes = new Set(valid.map((v) => v.id).filter(Boolean));

      for (const vieja of actuales) {
        if (vigentes.has(vieja.id)) continue;
        const [conStock] = await tx.select({ id: stock.id }).from(stock)
          .where(and(eq(stock.presentacionId, vieja.id), gt(stock.cantidad, 1e-9)))
          .limit(1);
        if (conStock) {
          const tam = vieja.tamKg < 1 ? `${Math.round(vieja.tamKg * 1000)} g` : `${vieja.tamKg} kg`;
          throw new BadRequestException(
            `La presentación de ${tam} tiene paquetes en stock: no se puede borrar. Vendé o ajustá ese stock primero.`,
          );
        }
        await tx.delete(presentaciones).where(eq(presentaciones.id, vieja.id));
      }

      const porId = new Map(actuales.map((a: any) => [a.id, a]));
      for (const v of valid) {
        if (v.id && porId.has(v.id)) {
          /*
           * EL TAMAÑO NO SE CAMBIA CON PAQUETES EN STOCK.
           *
           * Borrar una presentación con stock ya estaba cerrado tres líneas más
           * arriba; cambiarle el tamaño no, y es peor, porque no falla: pasa en
           * silencio y reescribe el pasado. Con 500 paquetes de 0,5 kg cargados,
           * guardar 5 kg convierte 250 kg de mercadería en 2.500 al instante —
           * el costo del paquete se multiplica por diez (`costoNetoPresentacion`),
           * la valorización del stock y el reporte de pérdidas mienten en la
           * misma proporción, y corregir un fraccionado devuelve al granel diez
           * veces los kilos que salieron.
           *
           * Un tamaño mal cargado se arregla creando la presentación correcta y
           * dando de baja la equivocada, que es lo que deja rastro.
           */
          const vieja: any = porId.get(v.id);
          if (Math.abs(Number(vieja.tamKg) - Number(v.tamKg)) > 1e-9) {
            const [conStock] = await tx.select({ id: stock.id }).from(stock)
              .where(and(eq(stock.presentacionId, v.id), gt(stock.cantidad, 1e-9)))
              .limit(1);
            if (conStock) {
              const tam = vieja.tamKg < 1 ? `${Math.round(vieja.tamKg * 1000)} g` : `${vieja.tamKg} kg`;
              throw new BadRequestException(
                `La presentación de ${tam} tiene paquetes en stock: no se le puede cambiar el tamaño `
                + '(cambiaría el costo y la equivalencia en granel de lo que ya está cargado). '
                + 'Creá la presentación con el tamaño correcto y dale de baja a esta.',
              );
            }
          }
          await tx.update(presentaciones)
            .set({ tamKg: v.tamKg, codigoBarras: v.codigoBarras })
            .where(eq(presentaciones.id, v.id));
        } else {
          await tx.insert(presentaciones).values({
            productoId: id, tamKg: v.tamKg, codigoBarras: v.codigoBarras,
          });
        }
      }
    });
    return this.get(id);
  }

  /**
   * Reemplaza el FORMATO DE COMPRA del producto: en qué presentaciones se
   * compra, a qué costo y cuál de todas fija el precio de venta.
   *
   * Actualiza POR ID en vez de borrar e insertar. No es un detalle de estilo:
   * el historial de costos referencia estas filas con `ON DELETE CASCADE`, así
   * que borrarlas todas en cada guardado —como se hacía antes— vaciaba en
   * silencio la auditoría entera del producto. Solo se borra lo que el usuario
   * sacó de verdad de la lista.
   */
  async setFormatosCompra(id: number, filas: any[]) {
    const [p] = await this.db.select().from(productos).where(eq(productos.id, id)).limit(1);
    if (!p) throw new NotFoundException('Producto inexistente.');

    const validas = (filas || []).filter((e) => Number(e.proveedorId));
    for (const f of validas) {
      if (!(Number(f.cantidad) > 0)) {
        throw new BadRequestException('La cantidad por bulto tiene que ser mayor a cero.');
      }
    }

    // Uno y solo uno fija el precio: sin esto, `formatoActivo()` elegiría el
    // primero que encuentre y el costo del producto dependería del orden de
    // las filas, que no es una decisión de nadie.
    let activo = validas.findIndex((f) => f.usarParaPrecio);
    if (activo < 0) activo = 0;

    const existentes = await this.db.select().from(productoProveedores)
      .where(eq(productoProveedores.productoId, id));
    const porId = new Map(existentes.map((e) => [e.id, e]));
    const enviados = new Set(validas.map((f) => Number(f.id)).filter((n) => porId.has(n)));

    /*
     * PISOS Y TECHOS DEL FORMATO DE COMPRA.
     *
     * Entraban con `Number(x) || 0` pelado, y de acá sale la cascada que fija el
     * PRECIO DE GÓNDOLA: un `costo: -5000` o un `descuento: 150` daban costo
     * neto negativo y el producto quedaba con precio bajo cero en la caja. No hay
     * clamp más abajo en la cadena, así que el único lugar donde se puede cortar
     * es la puerta.
     *
     * `plata` también filtra Infinity: `Number("1e999")` da Infinity y
     * sobrevive a un `|| 0`, y en una columna `double precision` Postgres lo
     * acepta — envenenando todo total que lo toque, sin vuelta atrás.
     */
    const plata = (v: unknown, tope = 1_000_000_000) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return 0;
      return Math.min(n, tope);
    };
    /** Un descuento es un porcentaje: fuera de 0–100 no significa nada. */
    const pct = (v: unknown) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return 0;
      return Math.min(n, 100);
    };

    const valores = (f: any, i: number) => ({
      productoId: id,
      proveedorId: Number(f.proveedorId),
      cantidad: plata(f.cantidad, 1_000_000) || 1,
      costo: plata(f.costo),
      descuento: pct(f.descuento),
      descuento2: pct(f.descuento2),
      descuento3: pct(f.descuento3),
      descuento4: pct(f.descuento4),
      flete: plata(f.flete),
      modoCosto: (f.modoCosto === 'final' ? 'final' : 'lista') as 'lista' | 'final',
      costoFinal: plata(f.costoFinal),
      usarParaPrecio: i === activo,
      codigoProveedor: (f.codigoProveedor ?? '').trim(),
    });

    await this.db.transaction(async (tx) => {
      for (const e of existentes) {
        if (!enviados.has(e.id)) {
          await tx.delete(productoProveedores).where(eq(productoProveedores.id, e.id));
        }
      }
      for (let i = 0; i < validas.length; i += 1) {
        const f = validas[i];
        const fid = Number(f.id);
        if (porId.has(fid)) {
          await tx.update(productoProveedores).set(valores(f, i))
            .where(eq(productoProveedores.id, fid));
        } else {
          await tx.insert(productoProveedores).values(valores(f, i));
        }
      }
    });
    // El costo pudo cambiar → el precio también. Queda en la evolución.
    await this.evolucion.snapshot([id], 'formato_compra');
    return this.get(id);
  }

  /**
   * Reemplaza el FORMATO DE VENTA del producto: en qué listas se vende, con qué
   * markup y desde cuántas unidades. La lista aporta solo su identidad; el
   * precio lo define esta tabla.
   */
  async setListas(id: number, items: any[]) {
    const [p] = await this.db.select().from(productos).where(eq(productos.id, id)).limit(1);
    if (!p) throw new NotFoundException('Producto inexistente.');
    await this.listas.setFormato(id, items || []);
    // Markup nuevo o lista nueva = precio nuevo. Queda en la evolución.
    await this.evolucion.snapshot([id], 'formato_venta');
    return this.get(id);
  }

  /**
   * El formato de venta de UN PAQUETE fraccionado (0053).
   *
   * Devuelve el producto MADRE completo: el paquete no es una entidad separada
   * para la pantalla —vive dentro de su madre, con su stock y sus movimientos—
   * así que quien guardó recibe todo el árbol actualizado de una.
   *
   * No dispara `evolucion.snapshot`: el historial de precios es por (producto,
   * lista) y todavía no distingue paquetes, así que llamarlo daría la impresión
   * de auditoría sin auditar nada. Está anotado como pendiente en /info.
   */
  async setListasPresentacion(presId: number, items: any[]) {
    const [pr] = await this.db.select().from(presentaciones)
      .where(eq(presentaciones.id, presId)).limit(1);
    if (!pr) throw new NotFoundException('Presentación inexistente.');
    await this.listas.setFormatoPresentacion(presId, items || []);
    return this.get(pr.productoId);
  }
}

@Controller('productos')
export class ProductosController {
  constructor(private readonly svc: ProductosService) {}

  /*
   * El catálogo lo lee todo el sistema, así que la LECTURA sigue abierta — pero
   * los costos de compra y los márgenes solo viajan a quien tiene permiso para
   * verlos. Sin esto, un cajero leía el margen de cada producto con el mismo
   * token que le da su propio login.
   */
  @Get() list(@Auth() auth: Sesion) {
    return this.svc.list(tienePermiso(auth.permisos, ['precios', 'compras.productos']));
  }
  /** Antes de `:id`, si no "siguiente-codigo" entra como id y revienta. */
  @Get('siguiente-codigo') siguienteCodigo() { return this.svc.siguienteCodigo(); }
  /**
   * Un EAN-13 propio libre para el botón "Generar" de la presentación.
   * `excluir` son los códigos que la pantalla tiene sin guardar todavía.
   */
  @Get('siguiente-ean') siguienteEan(@Query('excluir') excluir?: string) {
    return this.svc.siguienteEan13(String(excluir || '').split(',').filter(Boolean));
  }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number, @Auth() auth: Sesion) {
    return this.svc.get(id, tienePermiso(auth.permisos, ['precios', 'compras.productos']));
  }

  @Permiso('compras.productos')
  @Post() create(@Body() dto: UpsertProductoDto) { return this.svc.create(dto); }
  /** Catálogo completo de un proveedor, en una sola transacción. */
  @Permiso('compras.productos')
  @Post('importar') importar(@Body() dto: ImportarDto) { return this.svc.importar(dto); }
  @Permiso('compras.productos')
  @Patch(':id') update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpsertProductoDto) {
    return this.svc.update(id, dto);
  }
  @Permiso('compras.productos')
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }

  /** Dar de baja (discontinuado / archivado) y reactivar: el mismo endpoint. */
  @Permiso('compras.productos')
  @Post(':id/estado')
  cambiarEstado(@Param('id', ParseIntPipe) id: number, @Body() dto: CambiarEstadoDto) {
    return this.svc.cambiarEstado(id, dto);
  }

  /* Los discontinuados que ya se agotaron: sugerencia, no automatismo. */
  @Get('sugerencias/archivado') sugerenciasArchivado() { return this.svc.sugerenciasArchivado(); }
  @Permiso('compras.productos')
  @Post('archivar-lote') archivarLote(@Body() dto: ArchivarLoteDto) {
    return this.svc.archivarLote(dto.ids, dto.motivo);
  }

  @Permiso('compras.productos')
  @Put(':id/presentaciones')
  setPresentaciones(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.setPresentaciones(id, body?.presentaciones ?? body);
  }

  @Permiso('compras.productos')
  @Put(':id/formatos-compra')
  setFormatosCompra(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.setFormatosCompra(id, body?.formatos ?? body?.proveedores ?? body);
  }

  @Permiso('precios', 'ventas.listas')
  @Put(':id/listas')
  setListas(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.setListas(id, body?.listas ?? body?.listasPrecio ?? body);
  }

  /**
   * El formato de venta de un PAQUETE fraccionado. Va por su propia ruta y no
   * por la de la madre: son dos cosas que se cotizan por separado, y mezclarlas
   * en un mismo PUT haría que guardar una pudiera borrar la otra.
   */
  @Permiso('precios', 'ventas.listas')
  @Put('presentaciones/:presId/listas')
  setListasPresentacion(@Param('presId', ParseIntPipe) presId: number, @Body() body: any) {
    return this.svc.setListasPresentacion(presId, body?.listas ?? body);
  }
}

@Module({
  imports: [ConfiguracionModule, ListasModule, CatalogosModule, PreciosModule],
  controllers: [ProductosController],
  providers: [ProductosService],
  exports: [ProductosService],
})
export class ProductosModule {}
