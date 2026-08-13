/**
 * ACTUALIZACIÓN DE COSTOS Y MÁRGENES
 * ============================================================================
 * En este sistema **el precio de venta no se edita**: se deriva.
 *
 *     costoNeto = costo × (1 − descuento%) × (1 + flete%)
 *     precio    = costoNeto × (1 + ganancia%)
 *
 * Así que "actualizar precios" es mover una de esas palancas. Y no todas son
 * iguales: **costo, descuento y flete son del proveedor** (los cambia él);
 * **la ganancia es una decisión propia** y es transversal a los proveedores.
 * Por eso la UI las separa y este módulo también.
 *
 * Acá NO hay endpoint de simulación: el frontend ya tiene costos y márgenes en
 * memoria, así que previsualiza sin tocar la red. El servidor solo recibe los
 * cambios ya aprobados y los aplica en un único UPDATE.
 *
 * Todo cambio de costo queda registrado en `producto_proveedor_costos`, lo que
 * habilita la auditoría y el **deshacer por lote**.
 */
import {
  Body, Controller, Get, Inject, Injectable, Module, BadRequestException, Param, Post, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, ValidateNested,
} from 'class-validator';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { Permiso } from '../auth/auth.decoradores';
import {
  listasVenta, marcas, modalidadesVenta, precioHistorial, productoListas,
  productoProveedorCostos, productoProveedores, productos, proveedores, roles, usuarios,
} from '../db/schema';
import { ConfiguracionModule, ConfiguracionService } from '../configuracion/configuracion.module';
import { costoNetoEntry, formatoActivo, precioVentaFila } from '../inventario/pricing';

const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * EVOLUCIÓN DE PRECIOS — snapshot-diff.
 *
 * El precio se deriva, así que "cambió el precio" no es un evento: es la
 * consecuencia de otra operación. Después de cada una que puede moverlo, se
 * recalcula el precio FINAL de cada producto×lista tocado y se compara contra
 * el último registrado: solo la diferencia se escribe. Llamarlo dos veces
 * seguidas no duplica nada — es idempotente por construcción.
 */
@Injectable()
export class HistorialPreciosService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly cfg: ConfiguracionService,
  ) {}

  /** Precio final vigente de cada lista de un conjunto de productos. */
  private async preciosActuales(productoIds: number[]) {
    const cfg = await this.cfg.get('ventas');
    const [prods, formatos, plistas, listas] = await Promise.all([
      this.db.select().from(productos).where(inArray(productos.id, productoIds)),
      this.db.select().from(productoProveedores).where(inArray(productoProveedores.productoId, productoIds)),
      /* Las del producto SUELTO. La evolución de precios es por (producto,
       * lista): si entraran las filas de los paquetes habría dos precios para la
       * misma clave y el historial registraría cualquiera de los dos. El precio
       * de los paquetes todavía no lleva historial — está anotado en /info. */
      this.db.select().from(productoListas)
        .where(and(inArray(productoListas.productoId, productoIds), isNull(productoListas.presentacionId))),
      this.db.select().from(listasVenta).where(eq(listasVenta.activa, true)),
    ]);
    const listasVivas = new Set(listas.map((l) => l.id));
    const out: { productoId: number; listaId: number; precio: number }[] = [];
    for (const p of prods) {
      const cn = costoNetoEntry(formatoActivo(formatos.filter((f) => f.productoId === p.id)), p.iva);
      // Mismo criterio que las pantallas: el redondeo del producto pisa al de
      // configuración. Si acá difiriera, el historial registraría un precio
      // que ninguna etiqueta mostró jamás.
      const redondeo = p.redondeo ?? cfg.redondeoPrecio;
      for (const pl of plistas.filter((x) => x.productoId === p.id)) {
        if (!listasVivas.has(pl.listaId)) continue;
        // El precio que se registra es el FINAL UNITARIO, venga de un markup o
        // de un precio definido — la unidad es la base comparable en el tiempo.
        const pv = precioVentaFila(cn, pl as any, { iva: p.iva, redondeo });
        out.push({ productoId: p.id, listaId: pl.listaId, precio: pv.finalUnitario });
      }
    }
    return out;
  }

  /**
   * Registra los cambios de precio de estos productos. `origen` dice qué
   * palanca se movió; el % lo calcula quien lee, con los dos precios.
   */
  async snapshot(
    productoIds: number[],
    origen: 'inicial' | 'costo' | 'formato_compra' | 'formato_venta' | 'activacion' | 'reversion',
    opts: { detalle?: string; usuarioId?: number | null } = {},
  ) {
    const ids = [...new Set(productoIds)].filter(Boolean);
    if (!ids.length) return { registrados: 0 };

    const actuales = await this.preciosActuales(ids);
    // El último precio registrado de cada producto×lista, en UNA consulta.
    const ultimos = await this.db.execute(sql`
      SELECT DISTINCT ON (producto_id, lista_id) producto_id, lista_id, precio
      FROM precio_historial
      WHERE producto_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
      ORDER BY producto_id, lista_id, id DESC
    `);
    const ultimo = new Map(
      (ultimos.rows as any[]).map((r) => [`${r.producto_id}:${r.lista_id}`, Number(r.precio)]),
    );

    const filas = actuales
      .filter((a) => {
        const prev = ultimo.get(`${a.productoId}:${a.listaId}`);
        return prev === undefined || Math.abs(prev - a.precio) > 0.005;
      })
      .map((a) => {
        const prev = ultimo.get(`${a.productoId}:${a.listaId}`);
        return {
          productoId: a.productoId,
          listaId: a.listaId,
          precioAnterior: prev === undefined ? null : prev,
          precio: money(a.precio),
          origen: (prev === undefined ? 'inicial' : origen) as any,
          detalle: opts.detalle ?? '',
          usuarioId: opts.usuarioId ?? null,
        };
      });

    if (filas.length) await this.db.insert(precioHistorial).values(filas);
    return { registrados: filas.length };
  }

  /**
   * FIRMA DEL ÚLTIMO CAMBIO DE PRECIO. Endpoint deliberadamente barato: lo
   * pollea cada CRM abierto para avisarle al cajero que los precios que tiene
   * en pantalla quedaron viejos.
   *
   * La firma es el `id` más alto del historial, no la fecha: es monotónico,
   * no discute con zonas horarias y dos tandas en el mismo segundo no se
   * confunden. `productos` cuenta los distintos de ESA tanda — `snapshot()`
   * inserta todo en una transacción, así que comparten el `now()`.
   *
   * Del AUTOR viajan tres datos y cada uno decide algo en el aviso:
   *   - `usuarioId`: para no avisarle a quien hizo el cambio — ya lo sabe, y un
   *     cartel sobre lo que él mismo acaba de hacer entrena a ignorar carteles.
   *   - `usuarioRol`: el aviso salta solo si lo cambió la ADMINISTRACIÓN, que es
   *     la única que toca precios. Un `null` acá significa cambio sin autor
   *     registrado, que también es de administración (un cajero no tiene con
   *     qué mover un precio), así que ese caso también avisa.
   *   - `usuarioNombre`: para que el cartel diga de quién vino.
   */
  async ultimoCambio() {
    const [ultimo] = await this.db
      .select({
        id: precioHistorial.id,
        fecha: precioHistorial.fecha,
        origen: precioHistorial.origen,
        detalle: precioHistorial.detalle,
        usuarioId: precioHistorial.usuarioId,
        usuarioNombre: usuarios.nombre,
        usuarioRol: roles.clave,
      })
      .from(precioHistorial)
      .leftJoin(usuarios, eq(usuarios.id, precioHistorial.usuarioId))
      .leftJoin(roles, eq(roles.id, usuarios.rolId))
      .orderBy(desc(precioHistorial.id))
      .limit(1);

    if (!ultimo) {
      return {
        id: 0, fecha: null, origen: null, detalle: '',
        usuarioId: null, usuarioNombre: null, usuarioRol: null, productos: 0,
      };
    }

    const [tanda] = await this.db
      .select({ n: sql<number>`count(distinct ${precioHistorial.productoId})::int` })
      .from(precioHistorial)
      .where(eq(precioHistorial.fecha, ultimo.fecha));

    return { ...ultimo, productos: Number(tanda?.n) || 1 };
  }

  /**
   * La evolución, lista para mostrar: con producto, marca y lista resueltos.
   * Los filtros finos (búsqueda, marca) los aplica la pantalla en memoria —
   * el volumen es chico y el modal filtra con cada tecla.
   */
  async evolucion(q: { productoId?: number; desde?: string; limit?: number } = {}) {
    const conds: any[] = [];
    if (q.productoId) conds.push(eq(precioHistorial.productoId, q.productoId));
    if (q.desde) conds.push(sql`${precioHistorial.fecha} >= ${new Date(q.desde)}`);

    const filas = await this.db
      .select({
        id: precioHistorial.id,
        fecha: precioHistorial.fecha,
        productoId: precioHistorial.productoId,
        listaId: precioHistorial.listaId,
        precioAnterior: precioHistorial.precioAnterior,
        precio: precioHistorial.precio,
        origen: precioHistorial.origen,
        detalle: precioHistorial.detalle,
        producto: productos.nombre,
        codigo: productos.codigoBarras,
        codigoPropio: productos.codigoPropio,
        marcaId: productos.marcaId,
        marca: marcas.nombre,
        listaNumero: listasVenta.numero,
        listaNombre: listasVenta.nombre,
        modalidad: modalidadesVenta.nombre,
        usuario: usuarios.nombre,
      })
      .from(precioHistorial)
      .innerJoin(productos, eq(productos.id, precioHistorial.productoId))
      .leftJoin(marcas, eq(marcas.id, productos.marcaId))
      .innerJoin(listasVenta, eq(listasVenta.id, precioHistorial.listaId))
      .innerJoin(modalidadesVenta, eq(modalidadesVenta.id, listasVenta.modalidadId))
      .leftJoin(usuarios, eq(usuarios.id, precioHistorial.usuarioId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(precioHistorial.id))
      .limit(Math.min(q.limit ?? 500, 2000));

    return filas.map((f) => ({
      ...f,
      lista: `${f.modalidad} ${f.listaNumero}${f.listaNombre ? ` · ${f.listaNombre}` : ''}`,
      // El % acá y no en cada pantalla: una sola definición del número.
      variacion: f.precioAnterior && f.precioAnterior > 0
        ? money(((f.precio - f.precioAnterior) / f.precioAnterior) * 100)
        : null,
    }));
  }
}

class CambioCostoDto {
  /** id de `producto_proveedores`. */
  @IsInt() id!: number;
  @IsOptional() @IsNumber() costo?: number;
  @IsOptional() @IsNumber() descuento?: number;
  @IsOptional() @IsNumber() flete?: number;
}

class ActualizarCostosDto {
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => CambioCostoDto)
  cambios!: CambioCostoDto[];
  @IsOptional() @IsIn(['manual', 'masiva', 'recepcion']) origen?: 'manual' | 'masiva' | 'recepcion';
  @IsOptional() @IsString() motivo?: string;
  @IsOptional() @IsInt() usuarioId?: number;
}

class CambioMargenDto {
  @IsInt() id!: number;
  @IsNumber() valor!: number;
}

/**
 * Los `id` son filas de `producto_listas`. Tenía un `tipo` para elegir entre eso
 * y `presentaciones.recargo`; desde la 0053 el paquete tiene su propia fila en
 * la misma tabla, así que el segundo destino desapareció — y la masiva ganó de
 * arriba la capacidad de mover el margen de los paquetes.
 */
class ActualizarMargenesDto {
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => CambioMargenDto)
  cambios!: CambioMargenDto[];
  @IsOptional() @IsString() motivo?: string;
  @IsOptional() @IsInt() usuarioId?: number;
}

@Injectable()
export class PreciosService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly evolucion: HistorialPreciosService,
  ) {}

  /** Punto único para registrar evolución desde afuera (recepción de comprobantes). */
  registrarEvolucion(productoIds: number[], origen: any, opts: any = {}) {
    return this.evolucion.snapshot(productoIds, origen, opts);
  }

  /* ------------------------------ Costos ------------------------------ */

  /**
   * Aplica cambios de costo/descuento/flete y deja el rastro.
   *
   * Corre en una transacción y en dos pasos: un UPDATE masivo con VALUES (no
   * uno por fila: actualizar 800 costos no puede ser 800 viajes) y un INSERT
   * con el historial. Devuelve el `lote`, que es lo que después permite
   * deshacer la tanda entera.
   */
  async actualizarCostos(dto: ActualizarCostosDto, tx?: any) {
    const ejecutar = async (db: any) => {
      const ids = [...new Set(dto.cambios.map((c) => c.id))];
      if (!ids.length) throw new BadRequestException('No hay cambios para aplicar.');
      if (ids.length > 5000) throw new BadRequestException('Demasiadas filas en una sola actualización (máximo 5000).');

      const actuales = await db.select().from(productoProveedores).where(inArray(productoProveedores.id, ids));
      const porId = new Map(actuales.map((e: any) => [e.id, e]));

      /** Estado final de cada entrada: lo que no viene en el cambio no se toca. */
      const finales = dto.cambios
        .map((c) => {
          const a: any = porId.get(c.id);
          if (!a) return null;
          const nuevo = {
            id: c.id,
            costo: money(Math.max(0, c.costo ?? a.costo)),
            descuento: money(Math.max(0, c.descuento ?? a.descuento)),
            flete: money(Math.max(0, c.flete ?? a.flete)),
          };
          const sinCambio = Math.abs(nuevo.costo - a.costo) < 0.005
            && Math.abs(nuevo.descuento - a.descuento) < 0.005
            && Math.abs(nuevo.flete - a.flete) < 0.005;
          return sinCambio ? null : { nuevo, anterior: a };
        })
        .filter(Boolean) as { nuevo: any; anterior: any }[];

      if (!finales.length) return { ok: true, actualizados: 0, lote: '' };

      const valores = sql.join(
        finales.map(({ nuevo }) => sql`(${nuevo.id}::int, ${nuevo.costo}::double precision, ${nuevo.descuento}::double precision, ${nuevo.flete}::double precision)`),
        sql`, `,
      );
      await db.execute(sql`
        UPDATE producto_proveedores AS t
        SET costo = v.costo, descuento = v.descuento, flete = v.flete
        FROM (VALUES ${valores}) AS v(id, costo, descuento, flete)
        WHERE t.id = v.id
      `);

      const lote = `L${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      await db.insert(productoProveedorCostos).values(finales.map(({ nuevo, anterior }) => ({
        productoProveedorId: nuevo.id,
        costoAnterior: anterior.costo, descuentoAnterior: anterior.descuento, fleteAnterior: anterior.flete,
        costo: nuevo.costo, descuento: nuevo.descuento, flete: nuevo.flete,
        origen: (dto.origen ?? 'manual') as any,
        motivo: dto.motivo ?? '',
        lote,
        usuarioId: dto.usuarioId ?? null,
        comprobanteId: (dto as any).comprobanteId ?? null,
      })));

      // `anterior` es la fila completa de producto_proveedores: de ahí sale el
      // producto para el snapshot de evolución de precios.
      return { ok: true, actualizados: finales.length, lote, productoIds: [...new Set(finales.map((f) => f.anterior.productoId))] };
    };

    // Si viene `tx`, corre dentro de la transacción del llamador (recepción de
    // comprobante): el costo y el comprobante se guardan juntos o no se guarda
    // nada — y la evolución de precios la registra el llamador DESPUÉS del
    // commit, porque acá los datos nuevos todavía no son visibles.
    if (tx) return ejecutar(tx);
    const res = await this.db.transaction(ejecutar);
    await this.evolucion.snapshot(res.productoIds ?? [], 'costo', { detalle: dto.motivo ?? '', usuarioId: dto.usuarioId ?? null });
    return res;
  }

  /* ------------------------------ Márgenes ------------------------------ */

  /**
   * Masiva de márgenes sobre las filas de `producto_listas` — el formato de
   * venta, sea del producto suelto o de un paquete fraccionado (desde la 0053
   * viven en la misma tabla, así que una sola masiva mueve las dos cosas).
   *
   * Las filas en modo **precio definido** se saltean: ese precio lo fijó una
   * persona y un % masivo no debe pisarlo. Mueve la góndola, así que registra
   * evolución de precios (origen `formato_venta`).
   */
  async actualizarMargenes(dto: ActualizarMargenesDto) {
    const cambios = dto.cambios.filter((c) => Number.isInteger(c.id) && Number.isFinite(c.valor));
    if (!cambios.length) throw new BadRequestException('No hay cambios para aplicar.');
    if (cambios.length > 5000) throw new BadRequestException('Demasiadas filas en una sola actualización (máximo 5000).');

    const ids = [...new Set(cambios.map((c) => c.id))];
    const actuales = await this.db.select().from(productoListas).where(inArray(productoListas.id, ids));
    const porId = new Map(actuales.map((f) => [f.id, f]));

    // Solo filas reales, en modo markup y con un valor efectivamente distinto.
    const finales = cambios
      .map((c) => {
        const a = porId.get(c.id);
        if (!a || a.modoPrecio === 'precio') return null;
        const nuevo = money(Math.max(0, c.valor));
        return Math.abs(nuevo - a.markup) < 0.005 ? null : { id: c.id, valor: nuevo, productoId: a.productoId };
      })
      .filter(Boolean) as { id: number; valor: number; productoId: number }[];
    if (!finales.length) return { ok: true, actualizados: 0 };

    const valores = sql.join(
      finales.map((f) => sql`(${f.id}::int, ${f.valor}::double precision)`),
      sql`, `,
    );
    await this.db.execute(sql`
      UPDATE producto_listas AS t
      SET markup = v.valor
      FROM (VALUES ${valores}) AS v(id, valor)
      WHERE t.id = v.id
    `);
    await this.evolucion.snapshot(
      [...new Set(finales.map((f) => f.productoId))],
      'formato_venta',
      { detalle: dto.motivo ?? 'Actualización masiva de márgenes', usuarioId: dto.usuarioId ?? null },
    );
    return { ok: true, actualizados: finales.length };
  }

  /* -------------------------- Proveedor activo -------------------------- */

  /**
   * Pasa el proveedor activo de varios productos y lo **audita en la misma
   * tabla que los costos**.
   *
   * El activo define qué costo manda el precio de venta, así que cambiarlo
   * mueve la góndola igual que un aumento. Si no quedara registrado, el
   * historial no podría explicar por qué cambió un precio.
   *
   * Salta los productos donde ese proveedor ya es el activo y los que no tienen
   * entrada de costo para él (no habría de dónde sacar el precio).
   */
  async activarProveedor(
    o: {
      productoIds: number[]; proveedorId: number;
      origen?: 'manual' | 'masiva' | 'recepcion'; motivo?: string;
      usuarioId?: number; comprobanteId?: number;
    },
    tx?: any,
  ) {
    const ejecutar = async (db: any) => {
      const ids = [...new Set(o.productoIds || [])].filter(Boolean);
      if (!ids.length) return { ok: true, activados: 0, lote: '' };

      // Todos los formatos de compra de esos productos, para saber cuál manda
      // hoy y cuál pasaría a mandar.
      const formatos = await db.select().from(productoProveedores)
        .where(inArray(productoProveedores.productoId, ids));
      const porProducto = new Map<number, any[]>();
      for (const f of formatos as any[]) {
        const arr = porProducto.get(f.productoId);
        if (arr) arr.push(f); else porProducto.set(f.productoId, [f]);
      }

      const cambios: { actual: any; destino: any }[] = [];
      for (const pid of ids) {
        const suyos = porProducto.get(pid) ?? [];
        const destino = suyos.find((f) => f.proveedorId === o.proveedorId);
        if (!destino) continue;                       // ese proveedor no lo vende
        const actual = suyos.find((f) => f.usarParaPrecio) ?? null;
        if (actual && actual.id === destino.id) continue;   // ya manda
        cambios.push({ actual, destino });
      }
      if (!cambios.length) return { ok: true, activados: 0, lote: '' };

      for (const { destino } of cambios) {
        await db.update(productoProveedores).set({ usarParaPrecio: false })
          .where(eq(productoProveedores.productoId, destino.productoId));
        await db.update(productoProveedores).set({ usarParaPrecio: true })
          .where(eq(productoProveedores.id, destino.id));
      }

      const lote = `A${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      await db.insert(productoProveedorCostos).values(cambios.map(({ actual, destino }) => ({
        productoProveedorId: destino.id,
        // El costo no cambia acá: lo que cambia es CUÁL costo se usa.
        costoAnterior: destino.costo, descuentoAnterior: destino.descuento, fleteAnterior: destino.flete,
        costo: destino.costo, descuento: destino.descuento, flete: destino.flete,
        // Guardan FORMATOS, no proveedores: con dos formatos del mismo
        // proveedor, el id del proveedor ya no alcanza para volver atrás.
        activoAnterior: actual?.id ?? null,
        activoNuevo: destino.id,
        origen: (o.origen ?? 'manual') as any,
        motivo: o.motivo ?? 'Cambio de formato de compra activo',
        lote,
        usuarioId: o.usuarioId ?? null,
        comprobanteId: o.comprobanteId ?? null,
      })));

      return {
        ok: true, activados: cambios.length, lote,
        productoIds: cambios.map(({ destino }) => destino.productoId),
      };
    };
    if (tx) return ejecutar(tx);
    const res: any = await this.db.transaction(ejecutar);
    if (res.productoIds?.length) {
      await this.evolucion.snapshot(res.productoIds ?? [], 'activacion', { detalle: o.motivo ?? '', usuarioId: o.usuarioId ?? null });
    }
    return res;
  }

  /* ------------------------------ Auditoría ------------------------------ */

  /** Historial de costos con nombres resueltos, para leerlo sin cruzar tablas. */
  async historial(q: { productoId?: number; proveedorId?: number; lote?: string; limit?: number }) {
    const conds: any[] = [];
    if (q.productoId) conds.push(eq(productoProveedores.productoId, Number(q.productoId)));
    if (q.proveedorId) conds.push(eq(productoProveedores.proveedorId, Number(q.proveedorId)));
    if (q.lote) conds.push(eq(productoProveedorCostos.lote, q.lote));

    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    return this.db
      .select({
        id: productoProveedorCostos.id,
        fecha: productoProveedorCostos.fecha,
        lote: productoProveedorCostos.lote,
        origen: productoProveedorCostos.origen,
        motivo: productoProveedorCostos.motivo,
        comprobanteId: productoProveedorCostos.comprobanteId,
        productoProveedorId: productoProveedorCostos.productoProveedorId,
        costoAnterior: productoProveedorCostos.costoAnterior,
        descuentoAnterior: productoProveedorCostos.descuentoAnterior,
        fleteAnterior: productoProveedorCostos.fleteAnterior,
        costo: productoProveedorCostos.costo,
        descuento: productoProveedorCostos.descuento,
        flete: productoProveedorCostos.flete,
        activoAnterior: productoProveedorCostos.activoAnterior,
        activoNuevo: productoProveedorCostos.activoNuevo,
        productoId: productoProveedores.productoId,
        producto: productos.nombre,
        proveedor: proveedores.nombre,
        usuario: usuarios.nombre,
      })
      .from(productoProveedorCostos)
      .innerJoin(productoProveedores, eq(productoProveedores.id, productoProveedorCostos.productoProveedorId))
      .innerJoin(productos, eq(productos.id, productoProveedores.productoId))
      .innerJoin(proveedores, eq(proveedores.id, productoProveedores.proveedorId))
      .leftJoin(usuarios, eq(usuarios.id, productoProveedorCostos.usuarioId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(productoProveedorCostos.id))
      .limit(limit);
  }

  /**
   * Deshacer un lote: restaura los valores anteriores de cada fila.
   *
   * Se **saltea** las entradas cuyo valor vigente ya no coincide con lo que
   * dejó el lote: significa que alguien las volvió a cambiar después, y pisarlas
   * borraría ese cambio más nuevo sin avisar. Se informa cuáles quedaron afuera.
   *
   * La reversión no borra: agrega filas nuevas con origen `reversion`, así el
   * historial sigue siendo append-only y se puede leer qué pasó.
   */
  async revertirLote(lote: string, usuarioId?: number) {
    if (!lote) throw new BadRequestException('Indicá el lote a revertir.');

    const res: any = await this.db.transaction(async (tx) => {
      const filas = await tx.select().from(productoProveedorCostos)
        .where(eq(productoProveedorCostos.lote, lote));
      if (!filas.length) throw new BadRequestException('No existe ese lote de actualización.');

      const ids = filas.map((f: any) => f.productoProveedorId);
      const actuales = await tx.select().from(productoProveedores).where(inArray(productoProveedores.id, ids));
      const porId = new Map(actuales.map((e: any) => [e.id, e]));

      // Productos involucrados, solo si el lote además cambió el proveedor activo.
      const prodIds = [...new Set(actuales.map((e: any) => e.productoId))];

      const revertibles: any[] = [];
      const salteadas: any[] = [];
      for (const f of filas as any[]) {
        const a: any = porId.get(f.productoProveedorId);
        if (!a) { salteadas.push({ id: f.productoProveedorId, motivo: 'La entrada ya no existe.' }); continue; }
        const intacta = Math.abs(a.costo - f.costo) < 0.005
          && Math.abs(a.descuento - f.descuento) < 0.005
          && Math.abs(a.flete - f.flete) < 0.005;
        if (!intacta) { salteadas.push({ id: f.productoProveedorId, motivo: 'Cambió después de este lote.' }); continue; }

        // Si la fila cambió el formato activo, ese cambio también tiene que
        // seguir vigente; si no, revertirlo pisaría una decisión más nueva.
        if (f.activoNuevo != null) {
          const vigente: any = porId.get(f.activoNuevo);
          if (!vigente?.usarParaPrecio) {
            salteadas.push({ id: f.productoProveedorId, motivo: 'El formato activo cambió después de este lote.' });
            continue;
          }
        }
        revertibles.push({ f, a });
      }

      if (revertibles.length) {
        const valores = sql.join(
          revertibles.map(({ f }) => sql`(${f.productoProveedorId}::int, ${f.costoAnterior}::double precision, ${f.descuentoAnterior}::double precision, ${f.fleteAnterior}::double precision)`),
          sql`, `,
        );
        await tx.execute(sql`
          UPDATE producto_proveedores AS t
          SET costo = v.costo, descuento = v.descuento, flete = v.flete
          FROM (VALUES ${valores}) AS v(id, costo, descuento, flete)
          WHERE t.id = v.id
        `);

        // Los cambios de formato activo del lote también vuelven atrás.
        for (const { f, a } of revertibles) {
          if (f.activoNuevo == null) continue;
          await tx.update(productoProveedores).set({ usarParaPrecio: false })
            .where(eq(productoProveedores.productoId, a.productoId));
          if (f.activoAnterior != null) {
            await tx.update(productoProveedores).set({ usarParaPrecio: true })
              .where(eq(productoProveedores.id, f.activoAnterior));
          }
        }

        const nuevoLote = `R${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
        await tx.insert(productoProveedorCostos).values(revertibles.map(({ f, a }) => ({
          productoProveedorId: f.productoProveedorId,
          costoAnterior: a.costo, descuentoAnterior: a.descuento, fleteAnterior: a.flete,
          costo: f.costoAnterior, descuento: f.descuentoAnterior, flete: f.fleteAnterior,
          // Invertidos: esta fila deshace lo que hizo la original.
          activoAnterior: f.activoNuevo ?? null,
          activoNuevo: f.activoNuevo != null ? (f.activoAnterior ?? null) : null,
          origen: 'reversion' as any,
          motivo: `Reversión del lote ${lote}`,
          lote: nuevoLote,
          usuarioId: usuarioId ?? null,
        })));
      }

      return { ok: true, revertidos: revertibles.length, salteados: salteadas, productoIds: prodIds };
    });
    // Después del commit: la reversión también mueve precios y queda en la evolución.
    if (res.productoIds?.length) {
      await this.evolucion.snapshot(res.productoIds ?? [], 'reversion', { detalle: `Reversión del lote ${lote}`, usuarioId: usuarioId ?? null });
    }
    return res;
  }
}

/*
 * PRECIOS: escrituras Y lecturas. El historial dice cuanto se gana con cada
 * producto -- no es un dato mas del catalogo.
 */
@Controller('precios')
@Permiso('precios')
export class PreciosController {
  constructor(
    private readonly svc: PreciosService,
    private readonly evolucionSvc: HistorialPreciosService,
  ) {}

  /**
   * Firma del último cambio de precio. Lo pollea cada CRM abierto para avisarle
   * al cajero que su catálogo quedó viejo; por eso tiene que ser barato.
   */
  @Get('ultimo-cambio')
  ultimoCambio() { return this.evolucionSvc.ultimoCambio(); }

  /** Evolución del PRECIO DE VENTA (no del costo): para Alt+F5 y la pestaña del producto. */
  @Get('evolucion')
  evolucion(
    @Query('productoId') productoId?: string,
    @Query('desde') desde?: string,
    @Query('limit') limit?: string,
  ) {
    return this.evolucionSvc.evolucion({
      productoId: productoId ? Number(productoId) : undefined,
      desde,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('historial')
  historial(
    @Query('productoId') productoId?: string,
    @Query('proveedorId') proveedorId?: string,
    @Query('lote') lote?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.historial({
      productoId: productoId ? Number(productoId) : undefined,
      proveedorId: proveedorId ? Number(proveedorId) : undefined,
      lote,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('costos') costos(@Body() dto: ActualizarCostosDto) { return this.svc.actualizarCostos(dto); }
  @Post('margenes') margenes(@Body() dto: ActualizarMargenesDto) { return this.svc.actualizarMargenes(dto); }
  @Post('revertir/:lote') revertir(@Param('lote') lote: string) { return this.svc.revertirLote(lote); }
}

@Module({
  imports: [ConfiguracionModule],
  controllers: [PreciosController],
  providers: [PreciosService, HistorialPreciosService],
  exports: [PreciosService, HistorialPreciosService],
})
export class PreciosModule {}
