/**
 * FORMATO DE VENTA — catálogo de listas y reglas de acceso
 * ============================================================================
 * El negocio se maneja POR PRODUCTO, no por lista global. La misma "Mayorista 1"
 * puede ir al 30% en un producto y al 50% en otro, así que la lista no lleva
 * plata: solo identidad.
 *
 *     modalidad     carpeta ("Minorista", "Mayorista")
 *       └ lista     número + nombre + orden de preferencia
 *           └ producto_listas   ← acá vive el markup. La fila ES la habilitación.
 *
 * Sin fila, el producto no se vende en esa lista. No se hereda nada, y por eso
 * no hay ningún `resolverLista()`: lo que está guardado es lo que rige.
 *
 * La ÚNICA regla global es la de marca (`reglas_marca`), porque por definición
 * alcanza a muchos productos de una: "12 unidades de Coca-Cola habilitan la
 * modalidad Mayorista". Desbloquea la MODALIDAD, no una lista puntual — cada
 * producto entra con la lista que tenga cargada de esa modalidad, y el que no
 * tenga ninguna se queda con su precio de siempre.
 */
import {
  Body, Controller, Delete, Get, Inject, Injectable, Module, BadRequestException,
  NotFoundException, Param, ParseIntPipe, Patch, Post, Put,
} from '@nestjs/common';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString } from 'class-validator';
import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  clienteListas, listasVenta, marcas, modalidadesVenta, presentaciones, productoListas, productos, reglasMarca, ventaItems,
} from '../db/schema';

/** Una fila del formato de venta, con la identidad de la lista ya pegada. */
export interface FormatoVenta {
  listaId: number;
  /** NULL = el producto suelto. Con id = el paquete fraccionado que se cotiza solo. */
  presentacionId?: number | null;
  modoPrecio: 'markup' | 'precio';
  markup: number;
  precioFijo: number;
  unidades: number;
  codigoBarras: string;
  unidadesMinimas: number;
}

/** Etiqueta legible: "Mayorista 1 · Distribuidor". */
export function etiquetaLista(lista: { numero: number; nombre: string }, modalidad?: { nombre: string }) {
  const base = modalidad ? `${modalidad.nombre} ${lista.numero}` : `Lista ${lista.numero}`;
  return lista.nombre ? `${base} · ${lista.nombre}` : base;
}

/** Marca comparable: sin mayúsculas, acentos ni espacios de más. */
export function normMarca(v: any): string {
  return String(v ?? '').trim().toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

/* ------------------------------- DTOs ------------------------------- */

class UpsertModalidadDto {
  @IsString() nombre!: string;
  @IsOptional() @IsInt() orden?: number;
  @IsOptional() @IsBoolean() activa?: boolean;
}

/** La lista ya no lleva markup ni condición: son del producto. */
class UpsertListaDto {
  @IsInt() modalidadId!: number;
  @IsOptional() @IsInt() numero?: number;      // si no viene, el siguiente libre
  @IsString() nombre!: string;
  @IsOptional() @IsInt() orden?: number;
  @IsOptional() @IsBoolean() activa?: boolean;
}

class UpsertReglaMarcaDto {
  @IsInt() marcaId!: number;
  @IsNumber() unidadesMinimas!: number;
  @IsInt() modalidadId!: number;
  @IsOptional() @IsBoolean() activa?: boolean;
}

@Injectable()
export class ListasService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Catálogo completo: modalidades, listas y reglas de marca. Es chico y
   * estable (decenas de filas), así que viaja entero y todo se resuelve en
   * memoria — cotizar no cuesta una llamada.
   */
  async catalogo() {
    const [mods, lists, reglas] = await Promise.all([
      this.db.select().from(modalidadesVenta).orderBy(asc(modalidadesVenta.orden), asc(modalidadesVenta.id)),
      this.db.select().from(listasVenta).orderBy(asc(listasVenta.orden), asc(listasVenta.id)),
      // La marca viaja resuelta: el motor del POS compara por id, pero la
      // pantalla necesita el nombre y no tiene por qué cruzar otro catálogo.
      this.db.select({
        id: reglasMarca.id,
        marcaId: reglasMarca.marcaId,
        marca: marcas.nombre,
        unidadesMinimas: reglasMarca.unidadesMinimas,
        modalidadId: reglasMarca.modalidadId,
        activa: reglasMarca.activa,
      })
        .from(reglasMarca)
        .innerJoin(marcas, eq(marcas.id, reglasMarca.marcaId))
        .orderBy(asc(marcas.nombre)),
    ]);
    const porModalidad = new Map(mods.map((m) => [m.id, m]));
    return {
      modalidades: mods,
      listas: lists.map((l) => ({
        ...l,
        modalidad: porModalidad.get(l.modalidadId)?.nombre ?? '',
        etiqueta: etiquetaLista(l, porModalidad.get(l.modalidadId)),
      })),
      reglasMarca: reglas.map((r) => ({
        ...r,
        modalidad: porModalidad.get(r.modalidadId)?.nombre ?? '',
      })),
    };
  }

  /** Listas activas ordenadas por preferencia. Base de toda cotización. */
  async listasActivas() {
    return this.db.select().from(listasVenta)
      .where(eq(listasVenta.activa, true))
      .orderBy(asc(listasVenta.orden), asc(listasVenta.id));
  }

  /* ---------------------------- Modalidades ---------------------------- */

  async crearModalidad(dto: UpsertModalidadDto) {
    const nombre = dto.nombre.trim();
    if (!nombre) throw new BadRequestException('El nombre es obligatorio.');
    const [m] = await this.db.insert(modalidadesVenta)
      .values({ nombre, orden: dto.orden ?? 0, activa: dto.activa ?? true })
      .returning();
    return m;
  }

  async editarModalidad(id: number, dto: UpsertModalidadDto) {
    const [m] = await this.db.update(modalidadesVenta).set({
      nombre: dto.nombre.trim(),
      orden: dto.orden ?? 0,
      activa: dto.activa ?? true,
    }).where(eq(modalidadesVenta.id, id)).returning();
    if (!m) throw new NotFoundException('Modalidad inexistente.');
    return m;
  }

  async borrarModalidad(id: number) {
    const [conListas] = await this.db.select({ n: sql<number>`count(*)` })
      .from(listasVenta).where(eq(listasVenta.modalidadId, id));
    if (Number(conListas?.n) > 0) {
      throw new BadRequestException('La modalidad tiene listas. Borralas o movelas antes.');
    }
    await this.db.delete(modalidadesVenta).where(eq(modalidadesVenta.id, id));
    return { ok: true };
  }

  /* ------------------------------- Listas ------------------------------- */

  /** Siguiente número libre dentro de la modalidad. Nunca reutiliza los dados de baja. */
  private async siguienteNumero(modalidadId: number) {
    const [r] = await this.db
      .select({ max: sql<number>`coalesce(max(${listasVenta.numero}), 0)` })
      .from(listasVenta).where(eq(listasVenta.modalidadId, modalidadId));
    return (Number(r?.max) || 0) + 1;
  }

  async crearLista(dto: UpsertListaDto) {
    const [mod] = await this.db.select().from(modalidadesVenta)
      .where(eq(modalidadesVenta.id, dto.modalidadId)).limit(1);
    if (!mod) throw new BadRequestException('Modalidad inválida.');

    const numero = dto.numero ?? await this.siguienteNumero(dto.modalidadId);
    const [dup] = await this.db.select().from(listasVenta)
      .where(and(eq(listasVenta.modalidadId, dto.modalidadId), eq(listasVenta.numero, numero))).limit(1);
    if (dup) throw new BadRequestException(`Ya existe la lista ${numero} en ${mod.nombre}.`);

    const [l] = await this.db.insert(listasVenta).values({
      modalidadId: dto.modalidadId,
      numero,
      nombre: dto.nombre.trim(),
      orden: dto.orden ?? 0,
      activa: dto.activa ?? true,
    }).returning();
    return l;
  }

  /**
   * El NÚMERO no se edita: es parte de la identidad que referencian clientes y
   * ventas viejas. Cambiarlo reescribiría el historial en silencio.
   */
  async editarLista(id: number, dto: UpsertListaDto) {
    const [l] = await this.db.update(listasVenta).set({
      nombre: dto.nombre.trim(),
      orden: dto.orden ?? 0,
      activa: dto.activa ?? true,
    }).where(eq(listasVenta.id, id)).returning();
    if (!l) throw new NotFoundException('Lista inexistente.');
    return l;
  }

  /**
   * Con ventas hechas se **desactiva** en vez de borrarse: los renglones viejos
   * la referencian y su precio tiene que seguir siendo explicable.
   */
  async borrarLista(id: number) {
    const [usada] = await this.db.select({ n: sql<number>`count(*)` })
      .from(ventaItems).where(eq(ventaItems.listaId, id));
    if (Number(usada?.n) > 0) {
      const [l] = await this.db.update(listasVenta).set({ activa: false })
        .where(eq(listasVenta.id, id)).returning();
      return { ok: true, desactivada: true, lista: l };
    }
    await this.db.delete(listasVenta).where(eq(listasVenta.id, id));
    return { ok: true, desactivada: false };
  }

  /* --------------------------- Reglas de marca --------------------------- */

  async reglas() {
    return (await this.catalogo()).reglasMarca;
  }

  /** Valida marca + modalidad + mínimo. Común al alta y a la edición. */
  private async validarRegla(dto: UpsertReglaMarcaDto, exceptoId?: number) {
    if (!(Number(dto.unidadesMinimas) > 0)) {
      throw new BadRequestException('El mínimo de unidades tiene que ser mayor a cero.');
    }
    const [[marca], [mod]] = await Promise.all([
      this.db.select().from(marcas).where(eq(marcas.id, dto.marcaId)).limit(1),
      this.db.select().from(modalidadesVenta).where(eq(modalidadesVenta.id, dto.modalidadId)).limit(1),
    ]);
    if (!marca) throw new BadRequestException('Marca inválida.');
    if (!mod) throw new BadRequestException('Modalidad inválida.');

    const conds: any[] = [eq(reglasMarca.marcaId, dto.marcaId), eq(reglasMarca.modalidadId, dto.modalidadId)];
    if (exceptoId) conds.push(ne(reglasMarca.id, exceptoId));
    const [dup] = await this.db.select().from(reglasMarca).where(and(...conds)).limit(1);
    if (dup) throw new BadRequestException(`Ya hay una regla de ${marca.nombre} para ${mod.nombre}.`);
  }

  async crearRegla(dto: UpsertReglaMarcaDto) {
    await this.validarRegla(dto);
    const [r] = await this.db.insert(reglasMarca).values({
      marcaId: dto.marcaId,
      unidadesMinimas: Number(dto.unidadesMinimas),
      modalidadId: dto.modalidadId,
      activa: dto.activa ?? true,
    }).returning();
    return r;
  }

  async editarRegla(id: number, dto: UpsertReglaMarcaDto) {
    await this.validarRegla(dto, id);
    const [r] = await this.db.update(reglasMarca).set({
      marcaId: dto.marcaId,
      unidadesMinimas: Number(dto.unidadesMinimas) || 0,
      modalidadId: dto.modalidadId,
      activa: dto.activa ?? true,
    }).where(eq(reglasMarca.id, id)).returning();
    if (!r) throw new NotFoundException('Regla inexistente.');
    return r;
  }

  async borrarRegla(id: number) {
    await this.db.delete(reglasMarca).where(eq(reglasMarca.id, id));
    return { ok: true };
  }

  /* -------------------- Listas predeterminadas del cliente -------------------- */

  async listasDeCliente(clienteId: number) {
    return this.db
      .select({
        listaId: clienteListas.listaId,
        numero: listasVenta.numero,
        nombre: listasVenta.nombre,
        modalidadId: listasVenta.modalidadId,
        orden: listasVenta.orden,
      })
      .from(clienteListas)
      .innerJoin(listasVenta, eq(listasVenta.id, clienteListas.listaId))
      .where(and(eq(clienteListas.clienteId, clienteId), eq(listasVenta.activa, true)))
      .orderBy(asc(listasVenta.orden), asc(listasVenta.id));
  }

  /** Reemplaza el conjunto de listas predeterminadas del cliente. */
  async setListasDeCliente(clienteId: number, listaIds: number[]) {
    const ids = [...new Set((listaIds || []).filter((x) => Number.isInteger(x)))];
    await this.db.transaction(async (tx) => {
      await tx.delete(clienteListas).where(eq(clienteListas.clienteId, clienteId));
      if (ids.length) {
        await tx.insert(clienteListas).values(ids.map((listaId) => ({ clienteId, listaId })));
      }
    });
    return this.listasDeCliente(clienteId);
  }

  /* ---------------------- Formato de venta del producto ---------------------- */

  /** De fila de la base a `FormatoVenta`. Una sola forma de mapear, tres lectores. */
  private aFormato(f: any): FormatoVenta & { productoId: number } {
    return {
      productoId: f.productoId,
      presentacionId: f.presentacionId ?? null,
      listaId: f.listaId,
      modoPrecio: f.modoPrecio as any,
      markup: f.markup,
      precioFijo: f.precioFijo,
      unidades: f.unidades,
      codigoBarras: f.codigoBarras,
      unidadesMinimas: f.unidadesMinimas,
    };
  }

  /**
   * El formato de venta de TODA la familia del producto: el suelto y el de cada
   * uno de sus paquetes. Viene junto porque el armado del producto necesita las
   * dos cosas en la misma pasada; cada fila dice de quién es en `presentacionId`.
   */
  async formatoDe(productoId: number): Promise<(FormatoVenta & { productoId: number })[]> {
    const filas = await this.db.select().from(productoListas)
      .where(eq(productoListas.productoId, productoId));
    return filas.map((f) => this.aFormato(f));
  }

  /** El formato de venta de UN paquete fraccionado. */
  async formatoDePresentacion(presentacionId: number): Promise<(FormatoVenta & { productoId: number })[]> {
    const filas = await this.db.select().from(productoListas)
      .where(eq(productoListas.presentacionId, presentacionId));
    return filas.map((f) => this.aFormato(f));
  }

  /**
   * El formato de venta de TODOS los productos, en una consulta. Lo usa el
   * listado de Compras: pedir el de cada producto por separado era el N+1 que
   * hacía que abrir el catálogo se pusiera más lento con cada alta.
   */
  async formatoTodos(): Promise<(FormatoVenta & { productoId: number })[]> {
    const filas = await this.db.select().from(productoListas);
    return filas.map((f) => this.aFormato(f));
  }

  /**
   * Reemplaza el formato de venta del PRODUCTO SUELTO (la unidad, o el granel
   * por kg). A diferencia del modelo viejo NO se filtra nada por "coincide con
   * la lista": acá no hay herencia, la fila es el dato. Lo único que se descarta
   * son las listas que no existen o están dadas de baja.
   */
  async setFormato(productoId: number, filas: any[]) {
    return this.guardarFormato(productoId, null, filas);
  }

  /**
   * Reemplaza el formato de venta de UN PAQUETE fraccionado. Mismo cuerpo que el
   * del producto: el paquete se cotiza igual, solo cambia sobre qué costo.
   */
  async setFormatoPresentacion(presentacionId: number, filas: any[]) {
    const [pr] = await this.db.select().from(presentaciones)
      .where(eq(presentaciones.id, presentacionId)).limit(1);
    if (!pr) throw new NotFoundException('Presentación inexistente.');
    return this.guardarFormato(pr.productoId, presentacionId, filas);
  }

  /**
   * Las filas de UN ámbito: el producto suelto (`presentacionId` null) o uno de
   * sus paquetes. Existe porque las dos cosas viven en la misma tabla, y sin
   * este filtro el guardado de la madre borraría el precio de todos sus hijos.
   */
  private ambito(productoId: number, presentacionId: number | null) {
    return presentacionId == null
      ? and(eq(productoListas.productoId, productoId), isNull(productoListas.presentacionId))
      : eq(productoListas.presentacionId, presentacionId);
  }

  private async guardarFormato(productoId: number, presentacionId: number | null, filas: any[]) {
    const activas = await this.listasActivas();
    const validas = new Set(activas.map((l) => l.id));

    const vistos = new Set<number>();
    const rows = (filas || [])
      .map((f) => ({
        productoId,
        presentacionId,
        listaId: Number(f.listaId),
        modoPrecio: (f.modoPrecio === 'precio' ? 'precio' : 'markup') as any,
        markup: Number(f.markup) || 0,
        precioFijo: Number(f.precioFijo) || 0,
        unidades: Math.max(1, Number(f.unidades) || 1),
        codigoBarras: (f.codigoBarras ?? '').trim(),
        unidadesMinimas: Math.max(0, Number(f.unidadesMinimas) || 0),
      }))
      // Una lista no puede aparecer dos veces: el índice único lo rechazaría
      // con un error de base en vez de con un mensaje entendible.
      .filter((f) => {
        if (!validas.has(f.listaId) || vistos.has(f.listaId)) return false;
        vistos.add(f.listaId);
        return true;
      });

    for (const r of rows) {
      if (r.modoPrecio === 'precio' && !(r.precioFijo > 0)) {
        throw new BadRequestException('Con precio definido, el precio del formato tiene que ser mayor a 0.');
      }
    }

    // Los códigos de formato compiten con TODOS los demás códigos del sistema:
    // si la caja responde al mismo código que otra cosa, el escáner de la caja
    // queda sin desempate. Dos consultas chicas, no una por fila.
    const codigos = rows.map((r) => r.codigoBarras).filter(Boolean);
    if (new Set(codigos).size !== codigos.length) {
      throw new BadRequestException('Dos formatos de venta no pueden compartir el código de barras.');
    }
    if (codigos.length) {
      const [enProductos, enPresentaciones, enFormatos] = await Promise.all([
        this.db.select({ id: productos.id }).from(productos).where(or(
          inArray(productos.codigoBarras, codigos), inArray(productos.dun, codigos), inArray(productos.codigoPropio, codigos),
        )),
        this.db.select({ id: presentaciones.id }).from(presentaciones)
          .where(inArray(presentaciones.codigoBarras, codigos)),
        this.db.select({
          id: productoListas.id, productoId: productoListas.productoId, presentacionId: productoListas.presentacionId,
        }).from(productoListas).where(inArray(productoListas.codigoBarras, codigos)),
      ]);
      // Del choque con otros formatos se descuentan las filas de ESTE ámbito:
      // son las que están por reemplazarse. Se filtra acá y no en el WHERE
      // porque "no es mi ámbito" con un NULL adentro es más claro en JS.
      const ajenos = enFormatos.filter((f) => f.productoId !== productoId
        || (f.presentacionId ?? null) !== presentacionId);
      if (enProductos.length || enPresentaciones.length || ajenos.length) {
        throw new BadRequestException('Un código de formato ya lo usa otro producto, presentación o formato.');
      }
    }

    await this.db.transaction(async (tx) => {
      await tx.delete(productoListas).where(this.ambito(productoId, presentacionId));
      if (rows.length) await tx.insert(productoListas).values(rows);
    });
    return presentacionId == null
      ? (await this.formatoDe(productoId)).filter((f) => !f.presentacionId)
      : this.formatoDePresentacion(presentacionId);
  }
}

@Controller('listas')
export class ListasController {
  constructor(private readonly svc: ListasService) {}

  @Get() catalogo() { return this.svc.catalogo(); }

  @Post('modalidades') crearMod(@Body() dto: UpsertModalidadDto) { return this.svc.crearModalidad(dto); }
  @Patch('modalidades/:id') editarMod(@Param('id', ParseIntPipe) id: number, @Body() dto: UpsertModalidadDto) {
    return this.svc.editarModalidad(id, dto);
  }
  @Delete('modalidades/:id') borrarMod(@Param('id', ParseIntPipe) id: number) { return this.svc.borrarModalidad(id); }

  /* Reglas de marca — la única condición global. */
  @Get('reglas-marca') reglas() { return this.svc.reglas(); }
  @Post('reglas-marca') crearRegla(@Body() dto: UpsertReglaMarcaDto) { return this.svc.crearRegla(dto); }
  @Patch('reglas-marca/:id') editarRegla(@Param('id', ParseIntPipe) id: number, @Body() dto: UpsertReglaMarcaDto) {
    return this.svc.editarRegla(id, dto);
  }
  @Delete('reglas-marca/:id') borrarRegla(@Param('id', ParseIntPipe) id: number) { return this.svc.borrarRegla(id); }

  /** Listas predeterminadas de un cliente (reemplaza el conjunto completo). */
  @Put('cliente/:id')
  setCliente(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.setListasDeCliente(id, body?.listas ?? []);
  }

  @Post() crear(@Body() dto: UpsertListaDto) { return this.svc.crearLista(dto); }
  @Patch(':id') editar(@Param('id', ParseIntPipe) id: number, @Body() dto: UpsertListaDto) {
    return this.svc.editarLista(id, dto);
  }
  @Delete(':id') borrar(@Param('id', ParseIntPipe) id: number) { return this.svc.borrarLista(id); }
}

@Module({
  controllers: [ListasController],
  providers: [ListasService],
  exports: [ListasService],
})
export class ListasModule {}
