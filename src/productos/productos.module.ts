import {
  Body, Controller, Delete, Get, Inject, Injectable, Module, BadRequestException,
  NotFoundException, Param, ParseIntPipe, Patch, Post, Put,
} from '@nestjs/common';
import { IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString } from 'class-validator';
import { and, eq, gt, inArray, ne, or, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { ConfiguracionModule, ConfiguracionService } from '../configuracion/configuracion.module';
import { ListasModule, ListasService } from '../listas/listas.module';
import { PreciosModule, HistorialPreciosService } from '../precios/precios.module';
import { CatalogosModule } from '../catalogos/catalogos.module';
import {
  categorias, etiquetas, marcas, presentaciones, productoEtiquetas, productoListas,
  productoProveedores, productos, proveedores, stock, subcategorias,
} from '../db/schema';
import {
  costoNetoEntry, costosFormato, formatoActivo, precioLista, precioPresentacion, precioVentaFila,
} from '../inventario/pricing';

/**
 * Alícuotas legales de IVA. Es una lista cerrada a propósito: tipear 2.1 en vez
 * de 21 no da error y descalabra todos los precios del producto en silencio.
 */
const ALICUOTAS_IVA = [0, 2.5, 5, 10.5, 21, 27];

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
}

/**
 * IMPORTACIÓN MASIVA. El plan llega armado desde el navegador, que ya parseó
 * los archivos y mostró la vista previa: acá se valida contra la base y se
 * escribe. Las marcas y los rubros viajan por NOMBRE porque el que importa no
 * conoce los ids — el servidor reusa el que existe o lo crea.
 */
class ImportarDto {
  @IsInt() proveedorId!: number;
  @IsArray() items!: any[];
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
  private async assembleMany(prods: any[]) {
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

    return prods.map((prod) => {
      const mios = provsDe.get(prod.id) ?? [];
      const active = formatoActivo(mios);
      const costoNeto = costoNetoEntry(active, prod.iva);
      // El redondeo del producto pisa al de configuración; null = heredar.
      const opts = { iva: prod.iva, redondeo: prod.redondeo ?? cfg.redondeoPrecio };

      // FORMATO DE VENTA: solo las listas en las que este producto se vende,
      // cada una con SU markup. No hay herencia — lo que no está, no existe.
      const listas = (formatoDe.get(prod.id) ?? [])
        .filter((f: any) => porListaId.has(f.listaId))
        .map((f: any) => {
          const l: any = porListaId.get(f.listaId);
          const pv = precioVentaFila(costoNeto, f, opts);
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

      // Precio de referencia (presentaciones, valuaciones): el piso, o sea lo
      // que vale sin que el ticket habilite nada. Con modo 'precio' el markup
      // no manda, así que se deriva el EQUIVALENTE desde el neto unitario.
      const filaRef = listas.find((l: any) => l.listaId === base?.id) ?? listas[listas.length - 1] ?? null;
      const markupRef = filaRef
        ? (costoNeto > 0 ? ((filaRef.precio / costoNeto) - 1) * 100 : filaRef.markup)
        : 0;

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
        presentaciones: (presDe.get(prod.id) ?? [])
          .map((pr: any) => ({ ...pr, precio: precioPresentacion(costoNeto, pr, markupRef, opts) })),
        // FORMATO DE COMPRA: cada uno con su cadena ya derivada (lista →
        // descuentos → flete → neto → IVA), para que la pantalla solo muestre.
        formatosCompra: mios.map((pv: any) => ({
          ...pv,
          ...costosFormato(pv, prod.iva),
          costoNeto: costoNetoEntry(pv, prod.iva),
        })),
        listas,
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

  async list() {
    const rows = await this.db.select().from(productos).orderBy(productos.id);
    return this.assembleMany(rows);
  }

  async get(id: number) {
    const [p] = await this.db.select().from(productos).where(eq(productos.id, id)).limit(1);
    if (!p) throw new NotFoundException('Producto inexistente.');
    const [armado] = await this.assembleMany([p]);
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
    if (!ALICUOTAS_IVA.includes(iva)) {
      throw new BadRequestException(`Alícuota de IVA inválida. Las válidas son: ${ALICUOTAS_IVA.join(', ')}%.`);
    }
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
      ? await this.db.select({ codigoPropio: productos.codigoPropio, nombre: productos.nombre })
        .from(productos).where(inArray(productos.codigoPropio, codigosPropios))
      : [];
    const existentes = new Map(yaEnBase.map((p) => [p.codigoPropio, p.nombre]));

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
      if (!ALICUOTAS_IVA.includes(Number(p.iva))) {
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

        // Las presentaciones son del granel: en un producto entero no existen.
        const pres = (it.presentaciones || []).filter((x: any) => Number(x.tamKg) > 0);
        if (p.esGranel && pres.length) {
          await tx.insert(presentaciones).values(pres.map((x: any) => ({
            productoId: creado.id,
            tamKg: Number(x.tamKg),
            recargo: Number(x.recargo) || 0,
            codigoBarras: (x.codigoBarras ?? '').trim(),
          })));
        }

        /*
         * El formato de venta se escribe con ESTE tx, no con `setFormato`: ese
         * abre su propia transacción y las filas quedarían fuera del "todo o
         * nada" (y podrían bloquearse entre sí). Los formatos importados no
         * llevan código de barras propio —los códigos viven en el producto y en
         * sus presentaciones—, así que no hay nada más que validar acá.
         */
        const filas = (it.listas || [])
          .filter((l: any) => listasActivas.has(Number(l.listaId)))
          .filter((l: any) => (l.modoPrecio === 'precio' ? Number(l.precioFijo) > 0 : true));
        const vistas = new Set<number>();
        const filasUnicas = filas.filter((l: any) => {
          const id = Number(l.listaId);
          if (vistas.has(id)) return false;
          vistas.add(id);
          return true;
        });
        if (filasUnicas.length) {
          await tx.insert(productoListas).values(filasUnicas.map((l: any) => ({
            productoId: creado.id,
            listaId: Number(l.listaId),
            modoPrecio: (l.modoPrecio === 'precio' ? 'precio' : 'markup') as 'markup' | 'precio',
            markup: Number(l.markup) || 0,
            precioFijo: Number(l.precioFijo) || 0,
            unidades: Math.max(1, Number(l.unidades) || 1),
            codigoBarras: '',
            unidadesMinimas: Math.max(0, Number(l.unidadesMinimas) || 0),
          })));
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

    this.validarIva(dto.iva);
    await this.validarClasificacion(dto);
    await this.validarCodigos(dto, id);

    await this.db.update(productos).set(this.valores(dto, p)).where(eq(productos.id, id));
    if (dto.etiquetas) await this.setEtiquetas(id, dto.etiquetas);
    return this.get(id);
  }

  async remove(id: number) {
    const conStock = await this.db.select().from(stock)
      .where(and(eq(stock.productoId, id), gt(stock.cantidad, 1e-9))).limit(1);
    if (conStock[0]) throw new BadRequestException('No se puede eliminar: el producto tiene stock.');
    await this.db.delete(productos).where(eq(productos.id, id));
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
      productoId: id,
      tamKg: Number(x.tamKg),
      recargo: Number(x.recargo) || 0,
      codigoBarras: (x.codigoBarras ?? '').trim(),
    }));

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

      const [otra] = await this.db.select({ id: presentaciones.id })
        .from(presentaciones)
        .where(and(ne(presentaciones.productoId, id), inArray(presentaciones.codigoBarras, codigos)))
        .limit(1);
      if (otra) throw new BadRequestException('Ese código ya lo usa la presentación de otro producto.');
    }

    await this.db.transaction(async (tx) => {
      await tx.delete(presentaciones).where(eq(presentaciones.productoId, id));
      if (valid.length) await tx.insert(presentaciones).values(valid);
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

    const valores = (f: any, i: number) => ({
      productoId: id,
      proveedorId: Number(f.proveedorId),
      cantidad: Number(f.cantidad) || 1,
      costo: Number(f.costo) || 0,
      descuento: Number(f.descuento) || 0,
      descuento2: Number(f.descuento2) || 0,
      descuento3: Number(f.descuento3) || 0,
      descuento4: Number(f.descuento4) || 0,
      flete: Number(f.flete) || 0,
      modoCosto: (f.modoCosto === 'final' ? 'final' : 'lista') as 'lista' | 'final',
      costoFinal: Number(f.costoFinal) || 0,
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
}

@Controller('productos')
export class ProductosController {
  constructor(private readonly svc: ProductosService) {}

  @Get() list() { return this.svc.list(); }
  /** Antes de `:id`, si no "siguiente-codigo" entra como id y revienta. */
  @Get('siguiente-codigo') siguienteCodigo() { return this.svc.siguienteCodigo(); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }

  @Post() create(@Body() dto: UpsertProductoDto) { return this.svc.create(dto); }
  /** Catálogo completo de un proveedor, en una sola transacción. */
  @Post('importar') importar(@Body() dto: ImportarDto) { return this.svc.importar(dto); }
  @Patch(':id') update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpsertProductoDto) {
    return this.svc.update(id, dto);
  }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }

  @Put(':id/presentaciones')
  setPresentaciones(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.setPresentaciones(id, body?.presentaciones ?? body);
  }

  @Put(':id/formatos-compra')
  setFormatosCompra(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.setFormatosCompra(id, body?.formatos ?? body?.proveedores ?? body);
  }

  @Put(':id/listas')
  setListas(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.setListas(id, body?.listas ?? body?.listasPrecio ?? body);
  }
}

@Module({
  imports: [ConfiguracionModule, ListasModule, CatalogosModule, PreciosModule],
  controllers: [ProductosController],
  providers: [ProductosService],
  exports: [ProductosService],
})
export class ProductosModule {}
