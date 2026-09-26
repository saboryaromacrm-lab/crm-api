import { Inject, Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { and, asc, eq, getTableColumns, gte, inArray, isNotNull, isNull, lte, ne, or, desc, sql } from 'drizzle-orm';
import { fechaLocal } from '../common/documentos';
import { agruparPor, grupo } from '../common/agrupar';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  productos, presentaciones, productoProveedores, productoListas, listasVenta, proveedores, roles, sucursales, usuarios,
  stock, movimientos, transferencias, transferenciaItems, transferenciaHist, incidencias,
  comprobantes, facturaLecturas, pedidosCafeteria, vencimientos,
  marcas, categorias, subcategorias, etiquetas, productoEtiquetas,
  conteos, conteoItems, ventas, clientes,
  fraccionOperadores, fraccionamientos, fraccionamientoItems,
} from '../db/schema';
import { ConfiguracionService } from '../configuracion/configuracion.module';
import { ListasService } from '../listas/listas.module';
import { costoNetoEntry, costoNetoPresentacion, costoPrecioEntry, costosFormato, formatoActivo, precioLista, precioVentaFila } from './pricing';
import { conPermisosBase } from '../auth/permisos-base';

/** Metadatos de tipos de movimiento (dir: +1 entrada, −1 salida, 0 contextual). */
/**
 * Abreviaturas cortas para el código del libro de Operaciones, donde la columna
 * es angosta. `Liq` tiene que ser distinguible de `FC` de un vistazo: es el
 * único de los tres que no es fiscal.
 */
const ABREV_LIBRO: Record<string, string> = {
  remito: 'REM',
  liquidacion: 'Liq',
  factura: 'FC',
};

const TIPOS_MOV: Record<string, { label: string; dir: number }> = {
  compra: { label: 'Compra', dir: 1 },
  fraccionamiento: { label: 'Fraccionamiento', dir: 0 },
  venta_granel: { label: 'Venta a granel', dir: -1 },
  venta_fraccionada: { label: 'Venta fraccionada', dir: -1 },
  devolucion: { label: 'Devolución', dir: 1 },
  ajuste: { label: 'Ajuste', dir: 0 },
  merma: { label: 'Merma', dir: -1 },
  vencido: { label: 'Producto vencido', dir: -1 },
  defectuoso: { label: 'Producto defectuoso', dir: -1 },
  transferencia: { label: 'Transferencia', dir: 0 },
  envio_cafeteria: { label: 'Envío a Cafetería', dir: -1 },
};

/** Fraccionado (0102): la mañana va hasta las 14; de ahí en adelante, la tarde. */
const TURNO_TARDE_DESDE = 14;
/** Cuánto para atrás se puede asentar un fraccionado que se olvidó cargar. */
const DIAS_ASENTAR_ATRAS = 30;

type EstadoStock ='disponible' | 'comprometido' | 'retenido' | 'defectuoso' | 'vencido' | 'en_transito';
type Coord = { productoId: number; sucursalId: number; presentacionId: number | null; estado: EstadoStock };

/**
 * Motor de inventario. Toda la lógica de stock, operaciones, transferencias e
 * incidencias. Cada operación que muta stock corre dentro de una transacción y
 * registra un movimiento. Los errores de validación lanzan BadRequestException.
 */
@Injectable()
export class InventarioService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly cfg: ConfiguracionService,
    private readonly listas: ListasService,
  ) {}

  /* ------------------------- Utilidades de dominio ------------------------- */
  private fmtTam(kg: number): string {
    return kg < 1 ? `${Math.round(kg * 1000)} g` : `${kg} kg`;
  }
  /** Cantidades a 3 decimales (el granel llega hasta el gramo). Corta el ruido
   *  binario de restar dos doubles: 10 − 3 puede dar 6.999999999999999. */
  private cant3(n: number): number {
    return Math.round((Number(n) || 0) * 1000) / 1000;
  }
  /**
   * PAQUETES Y UNIDADES SE CUENTAN ENTEROS (25/9/2026). Solo el granel suelto
   * va en kilos con decimales; "2,5 paquetes" no sube a ningún camión y "2,5
   * recibidos" es un faltante que no se puede investigar.
   */
  private exigirEntero(prod: any, presId: number | null, c: number) {
    if (this.unidadDe(prod.tipo, presId) === 'kg') return;
    if (Math.abs(c - Math.round(c)) > 1e-9) {
      throw new BadRequestException(`${prod.nombre}: ${presId ? 'los paquetes' : 'las unidades'} van enteros (llegó ${String(c).replace('.', ',')}).`);
    }
  }

  private unidadDe(tipo: string, presId: number | null): 'kg' | 'u' {
    return tipo === 'granel' && !presId ? 'kg' : 'u';
  }
  private fmtCant(tipo: string, presId: number | null, cant: number): string {
    if (this.unidadDe(tipo, presId) === 'kg') return `${cant} kg`;
    return `${Math.round(cant)} ${presId ? 'paq.' : 'u.'}`;
  }

  /* ------------------------- Núcleo de stock ------------------------- */
  private coordWhere(c: Coord) {
    return and(
      eq(stock.productoId, c.productoId),
      eq(stock.sucursalId, c.sucursalId),
      c.presentacionId == null ? isNull(stock.presentacionId) : eq(stock.presentacionId, c.presentacionId),
      eq(stock.estado, c.estado),
    );
  }
  private async getEntry(tx: any, c: Coord) {
    /* `orderBy(id)`: si una coordenada quedó con dos filas, todos leen y tocan
     * la MISMA (la más vieja) — la misma que toma `cantConCandado`. */
    const rows = await tx.select().from(stock).where(this.coordWhere(c)).orderBy(stock.id).limit(1);
    return rows[0];
  }
  private async getOrCreate(tx: any, c: Coord) {
    const found = await this.getEntry(tx, c);
    if (found) return found;
    const [created] = await tx.insert(stock).values({
      productoId: c.productoId, sucursalId: c.sucursalId, presentacionId: c.presentacionId, estado: c.estado, cantidad: 0,
    }).returning();
    return created;
  }
  /**
   * Los deltas de stock son RELATIVOS en SQL (`cantidad = cantidad + δ`), nunca
   * un valor absoluto calculado en memoria. Con el valor absoluto, dos
   * operaciones concurrentes sobre la misma fila leían el mismo número y una
   * pisaba a la otra en silencio — el clásico lost update, y en el stock eso
   * es plata. El delta relativo lo resuelve la base, que para eso está.
   */
  private async addDelta(tx: any, c: Coord, delta: number) {
    const e = await this.getOrCreate(tx, c);
    await tx.execute(sql`UPDATE stock SET cantidad = cantidad + ${delta} WHERE id = ${e.id}`);
    if (delta > 0 && c.estado === 'disponible') await this.despertarArchivado(tx, c.productoId);
  }

  /**
   * ENTRÓ MERCADERÍA DE UN PRODUCTO ARCHIVADO → vuelve a discontinuado.
   *
   * "Archivado con stock" es un estado imposible: mercadería que existe y que
   * el sistema no deja vender. Pasa de verdad — una devolución del cliente, la
   * anulación de un ticket, un ajuste de inventario — y por eso se resuelve
   * solo. La asimetría es deliberada:
   *
   *   · ARCHIVAR cierra puertas → lo decide una persona (por eso hay
   *     sugerencia y no automatismo: ver `sugerenciasArchivado`).
   *   · DES-ARCHIVAR abre puertas → lo hace el sistema, porque lo contrario
   *     es dejar plata inmovilizada esperando que alguien se acuerde.
   *
   * Vuelve a `discontinuado` y no a `activo`: que reaparezca una unidad no
   * significa que se haya vuelto a comprar. Sigue sin entrar a las compras
   * hasta que alguien lo reactive de verdad.
   *
   * Va en `addDelta` a propósito: es el ÚNICO lugar por donde pasa todo
   * aumento de stock (compra, devolución, ajuste, reingreso por anulación,
   * recepción de transferencia, fraccionamiento), así que ningún camino nuevo
   * se lo puede olvidar. El UPDATE es condicional: si no estaba archivado no
   * toca nada, y no hay carrera posible.
   */
  private async despertarArchivado(tx: any, productoId: number) {
    await tx.execute(sql`
      UPDATE productos
         SET estado = 'discontinuado',
             estado_desde = now(),
             motivo_baja = 'Volvió a haber stock (devolución, anulación o ajuste): se reabrió para poder venderlo'
       WHERE id = ${productoId} AND estado = 'archivado'`);
  }
  private async cant(tx: any, productoId: number, sucursalId: number, presentacionId: number | null, estado: EstadoStock) {
    const e = await this.getEntry(tx, { productoId, sucursalId, presentacionId, estado });
    return e ? e.cantidad : 0;
  }

  /**
   * LEER CON CANDADO: el saldo de una coordenada, tomando su fila hasta el fin
   * de la transacción (25/9/2026).
   *
   * Fraccionar LEÍA el granel, comparaba y después descontaba. Entre la lectura
   * y el descuento no había nada: dos registros al mismo tiempo leían los dos
   * "hay 126 kg", los dos pasaban y el granel quedaba en −74 kg — mercadería
   * fraccionada que no existía. Con `FOR UPDATE` el segundo ESPERA a que el
   * primero termine y recién ahí lee, ya con el número descontado.
   *
   * Es para las lecturas que deciden un descuento (fraccionar, corregir, armar
   * un pedido). Las demás siguen con `cant`, sin candado: no hace falta frenar
   * a nadie para mostrar un número.
   */
  private async cantConCandado(tx: any, productoId: number, sucursalId: number, presentacionId: number | null, estado: EstadoStock) {
    const r: any = await tx.execute(sql`
      SELECT cantidad FROM stock
       WHERE producto_id = ${productoId} AND sucursal_id = ${sucursalId}
         AND ${presentacionId == null ? sql`presentacion_id IS NULL` : sql`presentacion_id = ${presentacionId}`}
         AND estado = ${estado}
       ORDER BY id
       FOR UPDATE`);
    const filas = r.rows ?? r;
    return filas.length ? Number(filas[0].cantidad) : 0;
  }
  /**
   * MUEVE STOCK DE UN ESTADO A OTRO, o **corta la operación entera**.
   *
   * Antes devolvía `false` cuando no había con qué mover, y **ninguno de sus
   * ocho llamadores miraba el retorno**. Eso no era un descuido de uno: era el
   * contrato mal elegido, porque el `false` no tiene ningún camino natural hacia
   * el usuario. La cadena que salía de ahí, con 10 unidades:
   *
   *   1. Se confirma la lista de una transferencia. Entre la validación y este
   *      `move`, una venta del POS se lleva el stock: no se reserva nada, pero
   *      el movimiento de auditoría "stock reservado" se inserta igual.
   *   2. El despacho intenta comprometido → en_tránsito y falla igual, en
   *      silencio, e inserta "despacho hacia destino".
   *   3. La recepción da por hecho que hay algo en tránsito y suma en el
   *      destino: **el origen queda en −10 y el destino gana 10 unidades que
   *      nunca existieron**, con tres movimientos diciendo que todo salió bien.
   *
   * Ahora LANZA. Está siempre adentro de una transacción, así que el throw
   * revierte todo lo que la operación venía haciendo — que es exactamente lo que
   * se quiere: si la mercadería no está, el documento no se emite.
   */
  private async move(tx: any, base: Omit<Coord, 'estado'>, desde: EstadoStock, hacia: EstadoStock, c: number): Promise<void> {
    const from = await this.getOrCreate(tx, { ...base, estado: desde });
    if (from.cantidad + 1e-9 < c) this.sinStock(desde, from.cantidad, c);
    // El WHERE re-verifica el saldo EN el UPDATE: si otra transacción se llevó
    // el stock entre la lectura y acá, no descuenta de más — no toca ninguna
    // fila, y la operación se corta igual que arriba.
    const res: any = await tx.execute(
      sql`UPDATE stock SET cantidad = cantidad - ${c} WHERE id = ${from.id} AND cantidad >= ${c} - 1e-9`,
    );
    if (!res.rowCount) this.sinStock(desde, from.cantidad, c);
    const to = await this.getOrCreate(tx, { ...base, estado: hacia });
    await tx.execute(sql`UPDATE stock SET cantidad = cantidad + ${c} WHERE id = ${to.id}`);
  }

  /** Un solo mensaje para las dos salidas de `move`, en castellano de mostrador. */
  private sinStock(estado: EstadoStock, hay: number, pedido: number): never {
    const donde: Record<string, string> = {
      disponible: 'disponible', comprometido: 'comprometido',
      en_transito: 'en tránsito', retenido: 'retenido',
      defectuoso: 'como defectuoso', vencido: 'como vencido',
    };
    throw new BadRequestException(
      `No hay stock ${donde[estado] ?? estado} suficiente: hay ${Math.round(hay * 1000) / 1000} y hacen falta ${pedido}. `
      + 'La operación no se registró.',
    );
  }

  /* ------------------------- Costos / precios ------------------------- */

  /**
   * Contexto para cotizar un producto con la lista BASE (el piso del sistema).
   * Los movimientos internos —fraccionamiento, mermas, valuaciones— no tienen
   * cliente ni ticket, así que no hay condición que evaluar: van siempre al
   * piso. El precio por cliente lo resuelve el punto de venta.
   */
  private async ctxPrecio(tx: any, productoId: number) {
    const [prod] = await tx.select().from(productos).where(eq(productos.id, productoId)).limit(1);
    if (!prod) return { cn: 0, iva: 0, markup: 0, tieneLista: false, redondeo: 0, listaBaseId: null as number | null };
    const [provs, formato, cfg, listas] = await Promise.all([
      tx.select().from(productoProveedores).where(eq(productoProveedores.productoId, productoId)),
      // Las del producto SUELTO. Sin el `isNull` entrarían las de sus paquetes y
      // el granel podría cotizarse con el precio de una bolsa de 500 g.
      tx.select().from(productoListas)
        .where(and(eq(productoListas.productoId, productoId), isNull(productoListas.presentacionId))),
      this.cfg.get('ventas'),
      tx.select().from(listasVenta).where(eq(listasVenta.activa, true))
        .orderBy(asc(listasVenta.orden), asc(listasVenta.id)),
    ]);
    const activas = new Set(listas.map((l: any) => l.id));
    const suyas = formato.filter((f: any) => activas.has(f.listaId));
    const base = listas.find((l: any) => l.id === cfg.listaBaseId) || listas[0] || null;
    // La del piso si el producto la tiene; si no, la de peor orden entre las
    // suyas (la más cara), que es lo que se cobra sin habilitar nada.
    const fila = suyas.find((f: any) => f.listaId === base?.id)
      ?? [...suyas].sort((a: any, b: any) => {
        const oa = listas.findIndex((l: any) => l.id === a.listaId);
        const ob = listas.findIndex((l: any) => l.id === b.listaId);
        return ob - oa;
      })[0] ?? null;
    const active = formatoActivo(provs as any[]);
    // La BASE del precio, no el costo real: la parte sin factura entra sin el
    // IVA que el negocio absorbe (0072) — mismo número que usa el POS.
    const cn = costoPrecioEntry(active, prod.iva);
    // Markup EQUIVALENTE de la fila: con precio definido el markup no manda,
    // así que se deriva desde el neto unitario del formato.
    const pv = fila ? precioVentaFila(cn, fila as any, { iva: prod.iva, redondeo: cfg.redondeoPrecio }) : null;
    return {
      cn,
      iva: prod.iva,
      markup: pv && cn > 0 ? ((pv.netoUnitario / cn) - 1) * 100 : (fila?.markup ?? 0),
      tieneLista: !!fila,
      redondeo: cfg.redondeoPrecio,
      /** La lista del piso, para cotizar un paquete con el mismo criterio. */
      listaBaseId: (base?.id ?? null) as number | null,
    };
  }

  private async precioBase(tx: any, productoId: number): Promise<number> {
    const { cn, iva, markup, tieneLista, redondeo } = await this.ctxPrecio(tx, productoId);
    return tieneLista ? precioLista(cn, markup, { iva, redondeo }) : cn;
  }

  /**
   * Precio de UN PAQUETE fraccionado, con SU formato de venta (0053).
   *
   * Se toma el de la lista base —el piso, lo mismo que muestran las pantallas— y
   * si el paquete no tiene ninguna fila cargada NO se devuelve cero: se corta. Un
   * cero acá sería una venta a precio cero, y el motivo aparecería recién en el
   * arqueo de caja.
   */
  private async precioPres(tx: any, presentacionId: number): Promise<number> {
    const [pres] = await tx.select().from(presentaciones).where(eq(presentaciones.id, presentacionId)).limit(1);
    if (!pres) throw new BadRequestException('Presentación inexistente.');
    const { cn, iva, redondeo, listaBaseId } = await this.ctxPrecio(tx, pres.productoId);
    const suyas = await tx.select().from(productoListas)
      .where(eq(productoListas.presentacionId, presentacionId));
    if (!suyas.length) {
      const tam = pres.tamKg < 1 ? `${Math.round(pres.tamKg * 1000)} g` : `${pres.tamKg} kg`;
      throw new BadRequestException(
        `El paquete de ${tam} no tiene formato de venta cargado, así que no tiene precio. Cargalo en su ficha (Compras › Productos → el fraccionado).`,
      );
    }
    const fila = suyas.find((f: any) => f.listaId === listaBaseId) ?? suyas[suyas.length - 1];
    return precioVentaFila(costoNetoPresentacion(cn, pres.tamKg), fila, { iva, redondeo }).netoUnitario;
  }

  /* ------------------------- Movimiento ------------------------- */
  /**
   * EL TIPO DE LA INCIDENCIA QUE DEJA UNA VENTA SIN STOCK (0096).
   *
   * No se llama "error de stock": el sistema no se equivocó, vendió lo que se
   * le pidió. Lo que dice es que el inventario tenía MENOS de lo que había en
   * la góndola, y que hay que ir a contar.
   */
  static readonly TIPO_VENTA_SIN_STOCK = 'venta_sin_stock';

  /**
   * Cuántas RESUELTAS viajan en el listado. Las abiertas van todas siempre —
   * son las que hay que cerrar y las que alimentan el contador del menú.
   *
   * Existe porque `incidencias` viajaba ENTERA en la foto del inventario, que
   * es la llamada que abre Almacén y Compras. Mientras las incidencias eran un
   * faltante de transferencia cada tanto eso estaba acotado; con las ventas sin
   * stock pasa a ser algo de todos los días, y esa tabla se volvía una bola de
   * nieve que hace más lenta la apertura de dos módulos cada mes que pasa.
   */
  static readonly TOPE_INCIDENCIAS_RESUELTAS = 300;

  private async mov(tx: any, campos: any) {
    const [m] = await tx.insert(movimientos).values(campos).returning();
    return m;
  }

  private async getProducto(tx: any, id: number) {
    const [p] = await tx.select().from(productos).where(eq(productos.id, id)).limit(1);
    return p;
  }

  /**
   * QUIÉN FRACCIONÓ (0102). El operador es obligatorio en cuanto existe al
   * menos uno activo que pueda trabajar en esa sucursal; antes de cargar el
   * primero, fraccionar sigue andando sin él (si no, el sistema se trabaría
   * el día que se instala). Con `obligatorio` en falso (la corrección) solo
   * se valida el que venga.
   */
  private async operadorDeFraccion(tx: any, operadorId: number | null | undefined, sucursalId: number, obligatorio: boolean): Promise<number | null> {
    if (operadorId) {
      const [op] = await tx.select().from(fraccionOperadores).where(eq(fraccionOperadores.id, operadorId)).limit(1);
      if (!op) throw new BadRequestException('Ese operador no existe.');
      if (!op.activo) throw new BadRequestException(`${op.nombre} está dado de baja como operador.`);
      if (op.sucursalId != null && op.sucursalId !== sucursalId) {
        throw new BadRequestException(`${op.nombre} no fracciona en esta sucursal.`);
      }
      return op.id;
    }
    if (!obligatorio) return null;
    const [hay] = await tx.select({ id: fraccionOperadores.id }).from(fraccionOperadores)
      .where(and(
        eq(fraccionOperadores.activo, true),
        or(isNull(fraccionOperadores.sucursalId), eq(fraccionOperadores.sucursalId, sucursalId)),
      )).limit(1);
    if (hay) throw new BadRequestException('Elegí quién fraccionó.');
    return null;
  }

  /**
   * El registro del historial (cabecera) y sus renglones: dos INSERT, en la
   * misma transacción que movió el stock. Paquetes y kilos con signo.
   */
  private turnoDe(d: Date): 'manana' | 'tarde' {
    return d.getHours() < TURNO_TARDE_DESDE ? 'manana' : 'tarde';
  }

  /**
   * CUÁNDO SE HIZO. Sin día ni turno —o con los de este momento— es ahora
   * (`fecha` null: la pone la base, igual a `registrado_en`). Asentado
   * después, la fecha es el COMIENZO de ese turno: no se inventa una hora que
   * nadie anotó. No se asienta un turno que todavía no empezó, ni más atrás de
   * 30 días: eso ya no es un olvido, es un error de tipeo del año o del mes.
   */
  private momentoDeFraccionado(dia?: string, turno?: 'manana' | 'tarde') {
    const ahora = new Date();
    const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    const hoy = iso(ahora);
    const t = turno ?? this.turnoDe(ahora);
    const d = dia ?? hoy;
    if (d === hoy && t === this.turnoDe(ahora)) return { fecha: null as Date | null, turno: t };
    const fecha = new Date(`${d}T${t === 'manana' ? '08:00:00' : `${TURNO_TARDE_DESDE}:00:00`}`);
    if (Number.isNaN(fecha.getTime()) || iso(fecha) !== d) throw new BadRequestException(`La fecha ${d} no existe.`);
    if (fecha.getTime() > ahora.getTime()) throw new BadRequestException('Ese turno todavía no empezó: no se puede asentar a futuro.');
    // Por DÍA, como el calendario de la pantalla: "30 días atrás" incluye la mañana de ese día.
    const minimo = iso(new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() - DIAS_ASENTAR_ATRAS));
    if (d < minimo) throw new BadRequestException(`Solo se puede asentar hasta ${DIAS_ASENTAR_ATRAS} días atrás.`);
    return { fecha, turno: t };
  }

  private async registrarFraccionamiento(tx: any, f: {
    origen: 'manual' | 'correccion' | 'pedido';
    sucursalId: number; operadorId: number | null; usuarioId?: number | null;
    transferenciaId?: number | null; motivo?: string;
    /** Asentado después: comienzo del turno. Sin esto, es ahora. */
    fecha?: Date | null; turno?: 'manana' | 'tarde';
    items: { productoId: number; presentacionId: number; tamKg: number; paquetes: number; movimientoId: number | null }[];
  }) {
    const items = f.items.filter((i) => i.paquetes !== 0);
    if (!items.length) return null;
    const [h] = await tx.insert(fraccionamientos).values({
      ...(f.fecha ? { fecha: f.fecha } : {}),
      turno: f.turno ?? this.turnoDe(new Date()),
      origen: f.origen,
      sucursalId: f.sucursalId,
      operadorId: f.operadorId,
      usuarioId: f.usuarioId ?? null,
      kg: this.cant3(items.reduce((a, i) => a + i.paquetes * i.tamKg, 0)),
      paquetes: items.reduce((a, i) => a + i.paquetes, 0),
      transferenciaId: f.transferenciaId ?? null,
      motivo: f.motivo ?? '',
    }).returning({ id: fraccionamientos.id });
    await tx.insert(fraccionamientoItems).values(items.map((i) => ({
      fraccionamientoId: h.id, productoId: i.productoId, presentacionId: i.presentacionId,
      tamKg: i.tamKg, paquetes: i.paquetes, movimientoId: i.movimientoId,
    })));
    return h.id as number;
  }
  /**
   * Los productos de un lote de renglones en UNA consulta, por id. Es lo que
   * usan las operaciones que recorren los ítems de un documento (la venta que
   * egresa stock, la nota que lo reingresa): antes cada renglón hacía su
   * propio viaje a la base por el producto, adentro de la transacción y con
   * la venta tomada con candado — quince renglones, quince viajes en fila
   * mientras la otra caja espera.
   */
  private async productosDe(tx: any, ids: number[]) {
    const limpios = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];
    const filas = limpios.length ? await tx.select().from(productos).where(inArray(productos.id, limpios)) : [];
    return new Map<number, any>(filas.map((p: any) => [p.id, p]));
  }
  /**
   * LA FOTO DEL PRODUCTO DESPUÉS DE MOVER SU STOCK: sus filas de stock (todas
   * las sucursales y estados) y su estado de catálogo.
   *
   * Viaja en la respuesta de cada operación de stock (venta suelta,
   * fraccionamiento, corrección, movimiento manual) para que la pantalla
   * actualice SOLO ese producto. Hasta ahora, después de cada una de esas
   * operaciones el CRM volvía a bajar el inventario ENTERO —10 MB con 2.700
   * productos, y el armado de precios de todos ellos en el servidor— por un
   * fraccionamiento de tres paquetes. Con cuatro personas trabajando, ese
   * armado repetido era lo que dejaba la API sin responder a las cajas.
   *
   * Se lee DENTRO de la misma transacción, así que es exactamente lo que quedó
   * guardado: la pantalla termina igual de exacta que recargando todo. El
   * estado del producto va porque un ingreso puede despertar a un archivado
   * (`despertarArchivado`), y eso también tiene que verse.
   */
  private async fotoProducto(tx: any, productoId: number) {
    const [filas, [p]] = await Promise.all([
      tx.select().from(stock).where(eq(stock.productoId, productoId)),
      tx.select({ id: productos.id, estado: productos.estado, estadoDesde: productos.estadoDesde, motivoBaja: productos.motivoBaja })
        .from(productos).where(eq(productos.id, productoId)).limit(1),
    ]);
    return { stock: filas, producto: p ?? null };
  }
  private async distribuidoraId(tx: any): Promise<number | null> {
    const [s] = await tx.select().from(sucursales).where(eq(sucursales.tipo, 'distribuidora')).limit(1);
    return s ? s.id : null;
  }

  /* ============================ OPERACIONES ============================ */

  /** Compra: ingresa mercadería, suma stock disponible y marca el proveedor activo. */
  async opCompra(o: any) {
    return this.db.transaction(async (tx) => {
      const prod = await this.getProducto(tx, o.productoId);
      if (!prod) throw new BadRequestException('Producto inválido.');
      const c = Number(o.cantidad);
      if (!(c > 0)) throw new BadRequestException('Ingresá una cantidad mayor a 0.');
      const sucId = o.sucursalId || (await this.distribuidoraId(tx));
      if (!sucId) throw new BadRequestException('No hay sucursal de ingreso.');

      await this.addDelta(tx, { productoId: prod.id, sucursalId: sucId, presentacionId: null, estado: 'disponible' }, c);

      let provNombre = '';
      if (o.proveedorId) {
        const [prov] = await tx.select().from(proveedores).where(eq(proveedores.id, o.proveedorId)).limit(1);
        if (prov) {
          provNombre = prov.nombre;
          const formato = await this.formatoDeProveedor(tx, prod.id, prov.id);
          await this.marcarFormatoActivo(tx, prod.id, formato.id);
        }
      }
      /* Misma trampa: un vencimiento '2026-09-01' se guardaba como el 31/8 a las
       * 21 h, y el vigía de fechas lo daba por vencido un día antes. El módulo
       * de Vencimientos ya lo parsea así; acá faltaba. */
      const venc = fechaLocal(o.fechaVencimiento);
      const m = await this.mov(tx, {
        tipo: 'compra', productoId: prod.id, sucursalId: sucId, signo: 1, cantidad: c,
        unidad: this.unidadDe(prod.tipo, null), estadoHacia: 'disponible', usuarioId: o.usuarioId ?? null,
        vencimiento: venc, proveedorNombre: provNombre, motivo: o.motivo || (provNombre ? `Prov: ${provNombre}` : ''),
        descripcion: `Compra +${this.fmtCant(prod.tipo, null, c)}${provNombre ? ' · ' + provNombre : ''}`,
      });
      return { ok: true, movimiento: m };
    });
  }

  /** Venta (granel / fraccionada / unidad). Precio computado del proveedor activo. */
  async opVenta(o: any) {
    return this.db.transaction(async (tx) => {
      const prod = await this.getProducto(tx, o.productoId);
      if (!prod) throw new BadRequestException('Producto inválido.');
      const presId = o.presId || null;
      const sucId = o.sucursalId;
      const c = Number(o.cantidad);
      if (!(c > 0)) throw new BadRequestException('Ingresá la cantidad.');
      const disp = await this.cant(tx, prod.id, sucId, presId, 'disponible');
      if (c > disp + 1e-9) throw new BadRequestException(`Stock insuficiente. Disponible: ${this.fmtCant(prod.tipo, presId, disp)}.`);
      await this.addDelta(tx, { productoId: prod.id, sucursalId: sucId, presentacionId: presId, estado: 'disponible' }, -c);
      const precioU = presId ? await this.precioPres(tx, presId) : await this.precioBase(tx, prod.id);
      const importe = c * precioU;
      const esGranelSuelto = prod.tipo === 'granel' && !presId;
      const tipo = esGranelSuelto ? 'venta_granel' : 'venta_fraccionada';
      const m = await this.mov(tx, {
        tipo, productoId: prod.id, sucursalId: sucId, presentacionId: presId, signo: -1, cantidad: c,
        unidad: this.unidadDe(prod.tipo, presId), estadoDesde: 'disponible', usuarioId: o.usuarioId ?? null,
        descripcion: `${esGranelSuelto ? 'Venta suelta ' : 'Venta '}${this.fmtCant(prod.tipo, presId, c)} · $${importe.toFixed(2)}`,
      });
      return { ok: true, importe, movimiento: m, ...(await this.fotoProducto(tx, prod.id)) };
    });
  }

  /**
   * Fraccionamiento de UN producto: descuenta granel y crea paquetes (misma
   * sucursal). Lo usan los seeds y los CRM que todavía no tienen el registro
   * con renglones (el que queda abierto durante el deploy): por dentro es un
   * registro de un solo producto.
   */
  async opFraccionar(o: any) {
    const items = (o.asignaciones || []).map((a: any) => ({ productoId: o.productoId, presId: a.presId, cant: a.cant }));
    const r = await this.opFraccionarRegistro({ ...o, items });
    const foto = r.fotos.find((f: any) => f.producto?.id === o.productoId) ?? r.fotos[0];
    return { ok: true, movimiento: r.movimientos[0], ...foto };
  }

  /**
   * REGISTRAR FRACCIONADO: la tanda de trabajo, con cabecera (sucursal,
   * operador, observaciones) y renglones de uno o varios productos.
   *
   * TODO O NADA: una sola transacción. Si a un producto no le alcanza el
   * granel, no queda registrado ninguno — la mitad de una tanda cargada es
   * peor que ninguna, porque el que la cargó cree que quedó entera.
   *
   * Un movimiento de stock por producto (el libro del almacén es por
   * producto) y UN registro en el historial con todos los renglones.
   * Los productos se recorren por id: dos registros simultáneos que tocan los
   * mismos productos toman los candados de stock en el mismo orden.
   */
  async opFraccionarRegistro(o: {
    sucursalId: number; usuarioId?: number; operadorId?: number; motivo?: string;
    dia?: string; turno?: 'manana' | 'tarde';
    items: { productoId: number; presId: number; cant: number }[];
  }) {
    // Antes de abrir la transacción: una fecha imposible no toca nada.
    const momento = this.momentoDeFraccionado(o.dia, o.turno);
    return this.db.transaction(async (tx) => {
      const sucId = o.sucursalId;
      /* Renglones agrupados por producto y tamaño: el mismo paquete cargado
       * dos veces suma, no se registra dos veces. */
      const porProducto = new Map<number, Map<number, number>>();
      for (const it of o.items || []) {
        const q = Math.round(Number(it.cant) || 0);
        if (!(q > 0)) continue;
        const pid = Number(it.productoId);
        const m = porProducto.get(pid) ?? new Map<number, number>();
        m.set(Number(it.presId), (m.get(Number(it.presId)) ?? 0) + q);
        porProducto.set(pid, m);
      }
      if (!porProducto.size) throw new BadRequestException('Agregá al menos un paquete a fraccionar.');
      const operadorId = await this.operadorDeFraccion(tx, o.operadorId, sucId, true);

      const ids = [...porProducto.keys()].sort((a, b) => a - b);
      const [prods, presList] = await Promise.all([
        this.productosDe(tx, ids),
        tx.select().from(presentaciones).where(inArray(presentaciones.productoId, ids)),
      ]);
      const presPorId = new Map<number, any>(presList.map((p: any) => [p.id, p]));

      const renglones: { productoId: number; presentacionId: number; tamKg: number; paquetes: number; movimientoId: number | null }[] = [];
      const movimientos: any[] = [];
      for (const pid of ids) {
        const prod = prods.get(pid);
        if (!prod || prod.tipo !== 'granel') throw new BadRequestException('Solo productos a granel se fraccionan.');
        const asign: { pres: any; q: number }[] = [];
        for (const [presId, q] of porProducto.get(pid)!) {
          const pres = presPorId.get(presId);
          if (!pres || pres.productoId !== pid) throw new BadRequestException(`Ese paquete no es de ${prod.nombre}.`);
          asign.push({ pres, q });
        }
        asign.sort((a, b) => b.pres.tamKg - a.pres.tamKg);
        const total = this.cant3(asign.reduce((a, x) => a + x.q * x.pres.tamKg, 0));
        // Con candado: ver `cantConCandado` (los productos van en orden de id).
        const disp = await this.cantConCandado(tx, pid, sucId, null, 'disponible');
        if (total > disp + 1e-9) {
          throw new BadRequestException(`No alcanza el granel de ${prod.nombre}: hay ${this.cant3(disp)} kg y se necesitan ${total} kg.`);
        }
        await this.addDelta(tx, { productoId: pid, sucursalId: sucId, presentacionId: null, estado: 'disponible' }, -total);
        for (const { pres, q } of asign) {
          await this.addDelta(tx, { productoId: pid, sucursalId: sucId, presentacionId: pres.id, estado: 'disponible' }, q);
        }
        const m = await this.mov(tx, {
          tipo: 'fraccionamiento', productoId: pid, sucursalId: sucId, signo: 0, cantidad: total, unidad: 'kg',
          presLabel: 'Granel → paquetes', usuarioId: o.usuarioId ?? null,
          descripcion: `Fraccionó ${total} kg en ${asign.map(({ pres, q }) => `${q}×${this.fmtTam(pres.tamKg)}`).join(', ')}`,
        });
        movimientos.push(m);
        for (const { pres, q } of asign) {
          renglones.push({ productoId: pid, presentacionId: pres.id, tamKg: pres.tamKg, paquetes: q, movimientoId: m.id });
        }
      }

      const registroId = await this.registrarFraccionamiento(tx, {
        origen: 'manual', sucursalId: sucId, operadorId, usuarioId: o.usuarioId,
        motivo: (o.motivo ?? '').trim(), items: renglones, fecha: momento.fecha, turno: momento.turno,
      });
      const fotos = await Promise.all(ids.map((pid) => this.fotoProducto(tx, pid)));
      return {
        ok: true, registroId, movimientos, fotos,
        paquetes: renglones.reduce((a, r) => a + r.paquetes, 0),
        kg: this.cant3(renglones.reduce((a, r) => a + r.paquetes * r.tamKg, 0)),
      };
    });
  }

  /**
   * CORREGIR UNA TANDA MAL CARGADA. "Puse 20 paquetes de 500 g y son 19."
   *
   * Mueve las DOS puntas: los paquetes y el granel del que salieron. Editar solo
   * los paquetes cambiaría los kilos totales del producto de la nada, y el
   * fraccionamiento no crea ni destruye mercadería: la convierte.
   *
   * AL BAJAR, SE PREGUNTA QUÉ PASÓ (25/9/2026). Antes bajar a 0 devolvía todos
   * los kilos al granel, sin preguntar: 23 paquetes que se rompieron o se
   * llevaron se convertían en 11,5 kg de granel que no existían, y la pérdida
   * no quedaba en ningún lado. Ahora hay dos respuestas, y las dos exigen motivo:
   *
   *   · `conteo`   — se cargaron de más, nunca se envasaron: los kilos SIGUEN en
   *                  el granel y vuelven ahí (lo de siempre).
   *   · `faltante` — se rompieron, se perdieron o faltan: los paquetes se dan de
   *                  baja como MERMA, con su costo congelado, y el granel no se
   *                  toca. No es un fraccionamiento: no entra al historial.
   *
   * Subir paquetes es fraccionar más: pide operador como el registro. Los dos
   * asientan día y turno como el registro (se corrige después, "lo de ayer").
   *
   * Toca solo el DISPONIBLE. Lo comprometido está apartado para un envío ya
   * confirmado: bajarlo por acá rompería esa reserva sin que el envío se enterara.
   */
  async opCorregirFraccionado(o: any) {
    // Antes de abrir la transacción: una fecha imposible no toca nada.
    const momento = this.momentoDeFraccionado(o.dia, o.turno);
    const motivo = String(o.motivo ?? '').trim();
    return this.db.transaction(async (tx) => {
      const prod = await this.getProducto(tx, o.productoId);
      if (!prod || prod.tipo !== 'granel') {
        throw new BadRequestException('Solo los productos a granel tienen fraccionados.');
      }
      const [pres] = await tx.select().from(presentaciones)
        .where(and(eq(presentaciones.id, o.presId), eq(presentaciones.productoId, prod.id))).limit(1);
      if (!pres) throw new BadRequestException('Ese paquete no es de este producto.');
      const sucId = o.sucursalId;
      const real = Math.round(Number(o.cantidadReal));
      if (!Number.isFinite(real) || real < 0) throw new BadRequestException('La cantidad real no puede ser negativa.');

      /* Con candado, primero el granel y después el paquete (el mismo orden que
       * registrar): dos correcciones a la vez calculaban el delta sobre el mismo
       * "actual" y el segundo absoluto no quedaba en lo que se escribió. */
      const granel = await this.cantConCandado(tx, prod.id, sucId, null, 'disponible');
      const actual = await this.cantConCandado(tx, prod.id, sucId, pres.id, 'disponible');
      const delta = real - actual;
      if (Math.abs(delta) < 1e-9) return { ok: true, sinCambios: true, ...(await this.fotoProducto(tx, prod.id)) };
      const tam = this.fmtTam(pres.tamKg);

      if (delta < 0) {
        const n = Math.round(-delta);
        if (o.causa !== 'conteo' && o.causa !== 'faltante') {
          throw new BadRequestException(
            `Bajás ${n} paquete(s) de ${tam}: decí qué pasó — se cargaron de más (los kilos siguen en el granel) o se rompieron o faltan (van a merma).`,
          );
        }
        if (!motivo) throw new BadRequestException('Contá en una línea qué pasó con esos paquetes: queda en el historial.');
        if (o.causa === 'faltante') {
          const r = await this.opSimpleTx(tx, {
            productoId: prod.id, sucursalId: sucId, presId: pres.id, tipo: 'merma', cantidad: n,
            usuarioId: o.usuarioId, motivo: `Faltan al corregir el fraccionado de ${tam} · ${motivo}`,
          });
          return { ok: true, merma: true, movimiento: r.movimiento, delta, kg: 0, ...(await this.fotoProducto(tx, prod.id)) };
        }
      }

      // Subir es fraccionar más: el operador se pide igual que al registrar.
      // Bajar por conteo: opcional — el que corrige días después puede no saberlo.
      const operadorId = await this.operadorDeFraccion(tx, o.operadorId, sucId, delta > 0);

      const kg = Math.round(Math.abs(delta) * pres.tamKg * 1000) / 1000;
      if (delta > 0 && kg > granel + 1e-9) {
        // Sumar paquetes es fraccionar más: tiene que haber granel para eso.
        throw new BadRequestException(
          `Para llegar a ${real} paquetes hacen falta ${kg} kg de granel y hay ${this.fmtCant(prod.tipo, null, granel)}.`,
        );
      }

      const base = { productoId: prod.id, sucursalId: sucId };
      await this.addDelta(tx, { ...base, presentacionId: pres.id, estado: 'disponible' }, delta);
      await this.addDelta(tx, { ...base, presentacionId: null, estado: 'disponible' }, delta > 0 ? -kg : kg);

      const m = await this.mov(tx, {
        tipo: 'fraccionamiento', productoId: prod.id, sucursalId: sucId, presentacionId: pres.id,
        signo: 0, cantidad: kg, unidad: 'kg', presLabel: `Corrección · ${tam}`,
        usuarioId: o.usuarioId ?? null, motivo,
        descripcion: `Corrigió ${tam}: ${actual} → ${real} paquetes (${kg} kg ${delta > 0 ? 'salen del' : 'vuelven al'} granel)`,
      });
      await this.registrarFraccionamiento(tx, {
        origen: 'correccion', sucursalId: sucId, operadorId, usuarioId: o.usuarioId, motivo,
        fecha: momento.fecha, turno: momento.turno,
        items: [{ productoId: prod.id, presentacionId: pres.id, tamKg: pres.tamKg, paquetes: Math.round(delta), movimientoId: m.id }],
      });
      return { ok: true, movimiento: m, delta, kg, ...(await this.fotoProducto(tx, prod.id)) };
    });
  }

  /** Movimiento simple: devolución (+), ajuste (±), merma/vencido/defectuoso (−). */
  async opSimple(o: any) {
    return this.db.transaction(async (tx) => {
      const r = await this.opSimpleTx(tx, o);
      // La foto va acá y no en `opSimpleTx`: el que lo llama con su propia
      // transacción (procesar un vencimiento) no la necesita.
      return { ...r, ...(await this.fotoProducto(tx, Number(o.productoId))) };
    });
  }

  /**
   * COSTO CONGELADO DE UNA PÉRDIDA.
   *
   * Toda baja por pérdida (merma, vencido, defectuoso) guarda el costo del día
   * en el movimiento: el reporte en pesos de marzo no puede cambiar en julio
   * porque subió el catálogo. Vive acá porque hay DOS puertas que dan de baja
   * mercadería —el movimiento manual y la resolución de una incidencia— y con
   * el cálculo repetido una de las dos quedaba en cero (la de incidencias
   * quedó, y su pérdida figuraba en $0 en el reporte de Vencimientos).
   */
  private async costoDePerdida(tx: any, prod: any, presId: number | null) {
    const provs = await tx.select().from(productoProveedores)
      .where(eq(productoProveedores.productoId, prod.id));
    const cnKg = costoNetoEntry(formatoActivo(provs as any[]) as any, prod.iva);
    if (!presId) return cnKg;
    const [pres] = await tx.select().from(presentaciones).where(eq(presentaciones.id, presId)).limit(1);
    return cnKg * (Number(pres?.tamKg) || 1);
  }

  /**
   * El cuerpo del movimiento simple SIN abrir transacción: un documento que
   * necesita la baja DENTRO de la suya (procesar un vencimiento genera la baja
   * real y marca el registro en el mismo acto) la llama con su tx — o todo
   * pasa, o no pasó nada.
   */
  async opSimpleTx(tx: any, o: any) {
    const prod = await this.getProducto(tx, o.productoId);
    if (!prod) throw new BadRequestException('Producto inválido.');
    const meta = TIPOS_MOV[o.tipo];
    if (!meta) throw new BadRequestException('Tipo inválido.');
    const presId = o.presId || null;
    const sucId = o.sucursalId;
    const c = Number(o.cantidad);
    if (!(c > 0)) throw new BadRequestException('Ingresá una cantidad mayor a 0.');
    let signo = meta.dir;
    if (signo === 0) signo = Number(o.signo) === 1 ? 1 : -1;
    if (signo < 0) {
      const disp = await this.cant(tx, prod.id, sucId, presId, 'disponible');
      if (c > disp + 1e-9) throw new BadRequestException(`Stock disponible insuficiente. Disponible: ${this.fmtCant(prod.tipo, presId, disp)}.`);
    }
    await this.addDelta(tx, { productoId: prod.id, sucursalId: sucId, presentacionId: presId, estado: 'disponible' }, signo * c);
    let estadoHacia: EstadoStock | null = signo > 0 ? 'disponible' : null;
    if (o.tipo === 'vencido') { await this.addDelta(tx, { productoId: prod.id, sucursalId: sucId, presentacionId: presId, estado: 'vencido' }, c); estadoHacia = 'vencido'; }
    else if (o.tipo === 'defectuoso') { await this.addDelta(tx, { productoId: prod.id, sucursalId: sucId, presentacionId: presId, estado: 'defectuoso' }, c); estadoHacia = 'defectuoso'; }

    const esPerdida = o.tipo === 'merma' || o.tipo === 'vencido' || o.tipo === 'defectuoso';
    const costoUnitario = esPerdida ? await this.costoDePerdida(tx, prod, presId) : 0;

    const m = await this.mov(tx, {
      tipo: o.tipo, productoId: prod.id, sucursalId: sucId, presentacionId: presId, signo, cantidad: c,
      unidad: this.unidadDe(prod.tipo, presId), estadoDesde: signo < 0 ? 'disponible' : null, estadoHacia,
      costoUnitario,
      usuarioId: o.usuarioId ?? null, motivo: o.motivo || '',
      descripcion: `${meta.label} ${signo > 0 ? '+' : '−'}${this.fmtCant(prod.tipo, presId, c)}${o.motivo ? ' · ' + o.motivo : ''}`,
    });
    return { ok: true, movimiento: m };
  }

  /**
   * Ingreso de stock por los ítems de un comprobante de recepción (remito o
   * factura con recepción). Corre dentro de la transacción `tx` del comprobante.
   * Marca el proveedor como activo y crea el costo si aún no existía.
   */
  async ingresarStockItems(tx: any, o: any) {
    const distinct = new Set<number>();
    for (const it of o.items || []) {
      const presId = it.presentacionId || null;
      const cantidad = Number(it.cantidad) || 0;
      if (cantidad <= 0) continue;
      await this.addDelta(tx, { productoId: it.productoId, sucursalId: o.sucursalId, presentacionId: presId, estado: 'disponible' }, cantidad);
      const prod = await this.getProducto(tx, it.productoId);
      await this.mov(tx, {
        tipo: 'compra', productoId: it.productoId, sucursalId: o.sucursalId, presentacionId: presId, signo: 1,
        cantidad, unidad: this.unidadDe(prod.tipo, presId), estadoHacia: 'disponible', usuarioId: o.usuarioId ?? null,
        proveedorNombre: o.proveedorNombre || '', descripcion: o.descripcion || 'Ingreso por comprobante',
      });
      distinct.add(it.productoId);
    }
    /**
     * Se asegura la entrada producto/proveedor (para poder cargarle costo), pero
     * NO se toca el proveedor activo.
     *
     * El proveedor activo define el costo que manda el PRECIO DE VENTA. Hacerlo
     * automático significaba que una compra ocasional a un proveedor alternativo
     * repriceaba la góndola sin que nadie lo decidiera, y los precios oscilaban
     * según quién había entregado. Ahora esa decisión se toma explícitamente en
     * la recepción (ver `activarProveedor` en comprobantes), y queda auditada.
     *
     * Excepción razonable: si el producto todavía no tiene ningún activo, el
     * primero que entrega lo pasa a ser — no hay alternativa que elegir.
     */
    if (o.proveedorId) {
      for (const productoId of distinct) {
        const it = (o.items || []).find((x: any) => x.productoId === productoId);
        const formato = await this.formatoDeProveedor(tx, productoId, o.proveedorId, Number(it?.costoUnitario) || 0);
        // Solo si el producto todavía no tiene formato que fije el precio: si
        // ya lo tiene, cambiarlo es una decisión y se toma explícitamente
        // (`PreciosService.activarProveedor`, que además lo audita).
        const [conActivo] = await tx.select({ id: productoProveedores.id })
          .from(productoProveedores)
          .where(and(eq(productoProveedores.productoId, productoId), eq(productoProveedores.usarParaPrecio, true)))
          .limit(1);
        if (!conActivo) await this.marcarFormatoActivo(tx, productoId, formato.id);
      }
    }
  }

  /**
   * El formato de compra de un proveedor para un producto; lo crea vacío si no
   * existe. Con varios formatos del mismo proveedor devuelve el primero: la
   * recepción no sabe en qué bulto vino, y elegirlo es trabajo del usuario.
   */
  private async formatoDeProveedor(tx: any, productoId: number, proveedorId: number, costo = 0) {
    const [existente] = await tx.select().from(productoProveedores)
      .where(and(eq(productoProveedores.productoId, productoId), eq(productoProveedores.proveedorId, proveedorId)))
      .orderBy(asc(productoProveedores.id))
      .limit(1);
    if (existente) return existente;
    const [creado] = await tx.insert(productoProveedores)
      .values({ productoId, proveedorId, costo })
      .returning();
    return creado;
  }

  /**
   * Deja UN solo formato marcado como el que fija el precio. Apagar todos antes
   * de encender el elegido es lo que garantiza la unicidad sin necesitar un
   * índice parcial que después haya que sortear en cada alta.
   */
  private async marcarFormatoActivo(tx: any, productoId: number, formatoId: number) {
    await tx.update(productoProveedores).set({ usarParaPrecio: false })
      .where(eq(productoProveedores.productoId, productoId));
    await tx.update(productoProveedores).set({ usarParaPrecio: true })
      .where(eq(productoProveedores.id, formatoId));
  }

  /**
   * Egreso de stock por los ítems de un documento (venta, o devolución a
   * proveedor). Es la operación inversa de `ingresarStockItems` y corre dentro
   * de la transacción del documento, así un faltante aborta el documento entero.
   *
   * `permitirNegativo` viene de la configuración: por defecto se rechaza, porque
   * un inventario en negativo no se recupera más.
   */
  async egresarStockItems(tx: any, o: any) {
    const tipoMov = o.tipoMovimiento || null;
    // Por defecto egresa lo DISPONIBLE; un documento puede egresar otro estado
    // (el envío a Cafetería cierra sacando lo que viajaba en_transito).
    const estado: EstadoStock = o.estado || 'disponible';
    // Todos los productos del documento de una vez (ver `productosDe`).
    const prodDe = await this.productosDe(tx, (o.items || []).map((it: any) => Number(it.productoId)));
    for (const it of o.items || []) {
      const presId = it.presentacionId || null;
      const cantidad = Number(it.cantidad) || 0;
      if (cantidad <= 0) continue;
      const prod = prodDe.get(Number(it.productoId));
      if (!prod) throw new BadRequestException('Producto inválido en el detalle.');
      const disp = await this.cant(tx, it.productoId, o.sucursalId, presId, estado);
      const faltante = cantidad - disp;
      if (faltante > 1e-9) {
        if (!o.permitirNegativo) {
          throw new BadRequestException(
            `Stock insuficiente de ${prod.nombre}. Disponible: ${this.fmtCant(prod.tipo, presId, disp)}.`,
          );
        }
        /*
         * SE VENDE IGUAL, PERO QUEDA EL RASTRO (0096).
         *
         * Solo por el camino de una VENTA (`ventaId`): la Cafetería y la
         * devolución a proveedor no pasan `permitirNegativo`, y aunque alguien
         * se lo pasara mañana, sin venta no hay a qué atar la incidencia — y
         * una incidencia que no dice de dónde salió no sirve para investigar,
         * que es TODO lo que esta incidencia viene a hacer.
         */
        if (o.ventaId) {
          await this.incidenciaVentaSinStock(tx, {
            prod, presentacionId: presId, sucursalId: o.sucursalId,
            disponible: disp, vendido: cantidad, faltante,
            ventaId: o.ventaId, documento: o.descripcion || 'Venta', usuarioId: o.usuarioId ?? null,
          });
        }
      }
      await this.addDelta(tx, { productoId: it.productoId, sucursalId: o.sucursalId, presentacionId: presId, estado }, -cantidad);
      const esGranelSuelto = prod.tipo === 'granel' && !presId;
      await this.mov(tx, {
        tipo: tipoMov || (esGranelSuelto ? 'venta_granel' : 'venta_fraccionada'),
        productoId: it.productoId, sucursalId: o.sucursalId, presentacionId: presId, signo: -1,
        cantidad, unidad: this.unidadDe(prod.tipo, presId), estadoDesde: estado,
        usuarioId: o.usuarioId ?? null, descripcion: o.descripcion || 'Egreso por documento',
      });
    }
  }

  /**
   * LA INCIDENCIA DE UNA VENTA SIN STOCK (0096).
   *
   * Corre DENTRO de la transacción de la venta: si la venta se cae, esto se cae
   * con ella y no queda una incidencia de algo que no pasó.
   *
   * NO escribe movimiento de stock. El egreso de la venta ya escribe el suyo
   * por la cantidad entera —eso ES el registro de que la mercadería salió— y
   * sumarle otro contaría la misma salida dos veces en el libro del almacén.
   *
   * Cuesta dos sentencias (el alta, y el `codigo` que necesita el id ya
   * asignado), igual que el faltante de una transferencia. Es el ÚNICO costo
   * que este cambio agrega, y solo se paga en el renglón que se fue a negativo:
   * la venta que tiene stock no hace ni una consulta de más, porque el
   * disponible ya estaba leído para el chequeo de siempre.
   */
  private async incidenciaVentaSinStock(tx: any, o: {
    prod: any; presentacionId: number | null; sucursalId: number;
    disponible: number; vendido: number; faltante: number;
    ventaId: number; documento: string; usuarioId: number | null;
  }) {
    const unidad = this.unidadDe(o.prod.tipo, o.presentacionId);
    const f = (n: number) => this.fmtCant(o.prod.tipo, o.presentacionId, n);
    const [inc] = await tx.insert(incidencias).values({
      codigo: '',
      tipo: InventarioService.TIPO_VENTA_SIN_STOCK,
      estado: 'pendiente',
      /* Quién la destapó: el cajero que cobró. No es "el culpable" — es por
       * dónde empezar a preguntar. */
      responsableId: o.usuarioId,
      motivo: `${o.documento}: se vendieron ${f(o.vendido)} de ${o.prod.nombre} y el sistema tenía ${f(o.disponible)}. `
        + `Faltan ${f(o.faltante)}: hay que contar la góndola.`,
      productoId: o.prod.id,
      sucursalId: o.sucursalId,
      presentacionId: o.presentacionId,
      /** La DIFERENCIA, no lo vendido: si había 3 y se vendieron 10, faltan 7. */
      cantidad: this.cant3(o.faltante),
      unidad,
      ventaId: o.ventaId,
      disponibleAntes: this.cant3(o.disponible),
      vendido: this.cant3(o.vendido),
    }).returning({ id: incidencias.id });
    await tx.update(incidencias)
      .set({ codigo: `INC${String(inc.id).padStart(4, '0')}` })
      .where(eq(incidencias.id, inc.id));
  }

  /**
   * ANULAR LA VENTA CIERRA SUS INCIDENCIAS (0096).
   *
   * La anulación devuelve el stock, así que el negativo que la incidencia
   * denunciaba dejó de existir: dejarla abierta sería un pendiente falso, y un
   * pendiente falso es lo que enseña a ignorar la lista. Una sola sentencia, y
   * solo toca las que siguen abiertas.
   */
  async cerrarIncidenciasDeVenta(tx: any, ventaId: number, motivo: string) {
    await tx.update(incidencias).set({
      estado: 'resuelta',
      resolucion: 'venta_anulada',
      fechaResolucion: new Date(),
      activa: false,
      motivo: sql`${incidencias.motivo} || ' · Cerrada al anularse la venta: ' || ${motivo}`,
    }).where(and(
      eq(incidencias.ventaId, ventaId),
      ne(incidencias.estado, 'resuelta'),
    ));
  }

  /**
   * Pone (o devuelve) mercadería EN TRÁNSITO por un documento que la despacha
   * hacia afuera del sistema (el envío a Cafetería). Mientras viaja sigue
   * siendo del origen — si el flete se pierde, la pérdida es de quien despachó
   * y el inventario total no miente. Valida TODO antes de mover.
   */
  async transitarStockItems(tx: any, o: {
    sucursalId: number;
    usuarioId?: number | null;
    descripcion: string;
    tipoMovimiento?: string;
    /** true = la vuelta: en_transito → disponible (anulación del despacho). */
    volver?: boolean;
    items: { productoId: number; presentacionId?: number | null; cantidad: number }[];
  }) {
    const desde: EstadoStock = o.volver ? 'en_transito' : 'disponible';
    const hacia: EstadoStock = o.volver ? 'disponible' : 'en_transito';

    const faltas: string[] = [];
    for (const it of o.items || []) {
      const c = Number(it.cantidad) || 0;
      if (c <= 0) continue;
      const presId = it.presentacionId || null;
      const hay = await this.cant(tx, it.productoId, o.sucursalId, presId, desde);
      if (c > hay + 1e-9) {
        const prod = await this.getProducto(tx, it.productoId);
        faltas.push(`${prod?.nombre ?? '#' + it.productoId}: hace falta ${this.fmtCant(prod?.tipo ?? 'entero', presId, c)}, hay ${this.fmtCant(prod?.tipo ?? 'entero', presId, hay)}`);
      }
    }
    if (faltas.length) throw new BadRequestException(`Stock insuficiente — ${faltas.join(' · ')}`);

    for (const it of o.items || []) {
      const c = Number(it.cantidad) || 0;
      if (c <= 0) continue;
      const presId = it.presentacionId || null;
      const prod = await this.getProducto(tx, it.productoId);
      await this.move(tx, { productoId: it.productoId, sucursalId: o.sucursalId, presentacionId: presId }, desde, hacia, c);
      await this.mov(tx, {
        tipo: o.tipoMovimiento || 'ajuste',
        productoId: it.productoId, sucursalId: o.sucursalId, presentacionId: presId, signo: 0,
        cantidad: c, unidad: this.unidadDe(prod.tipo, presId), estadoDesde: desde, estadoHacia: hacia,
        usuarioId: o.usuarioId ?? null, descripcion: o.descripcion,
      });
    }
  }

  /**
   * Reserva (o libera) stock por un documento que COMPROMETE mercadería sin
   * venderla todavía: un presupuesto confirmado aparta lo pedido
   * (disponible → comprometido) mientras el vendedor arma el pedido, y el
   * cierre en venta o la cancelación lo liberan. Reservar valida TODO antes
   * de mover: el error detalla cada renglón corto.
   */
  async reservarItems(tx: any, o: {
    sucursalId: number;
    usuarioId?: number | null;
    descripcion: string;
    liberar?: boolean;
    items: { productoId: number; presentacionId?: number | null; cantidad: number }[];
  }) {
    const desde: EstadoStock = o.liberar ? 'comprometido' : 'disponible';
    const hacia: EstadoStock = o.liberar ? 'disponible' : 'comprometido';

    if (!o.liberar) {
      const faltas: string[] = [];
      for (const it of o.items || []) {
        const c = Number(it.cantidad) || 0;
        if (c <= 0) continue;
        const presId = it.presentacionId || null;
        const disp = await this.cant(tx, it.productoId, o.sucursalId, presId, 'disponible');
        if (c > disp + 1e-9) {
          const prod = await this.getProducto(tx, it.productoId);
          faltas.push(`${prod?.nombre ?? '#' + it.productoId}: pedido ${this.fmtCant(prod?.tipo ?? 'entero', presId, c)}, disponible ${this.fmtCant(prod?.tipo ?? 'entero', presId, disp)}`);
        }
      }
      if (faltas.length) throw new BadRequestException(`Stock insuficiente para reservar — ${faltas.join(' · ')}`);
    }

    for (const it of o.items || []) {
      const c = Number(it.cantidad) || 0;
      if (c <= 0) continue;
      const presId = it.presentacionId || null;
      const prod = await this.getProducto(tx, it.productoId);
      await this.move(tx, { productoId: it.productoId, sucursalId: o.sucursalId, presentacionId: presId }, desde, hacia, c);
      await this.mov(tx, {
        tipo: 'ajuste', productoId: it.productoId, sucursalId: o.sucursalId, presentacionId: presId, signo: 0,
        cantidad: c, unidad: this.unidadDe(prod.tipo, presId), estadoDesde: desde, estadoHacia: hacia,
        usuarioId: o.usuarioId ?? null, descripcion: o.descripcion,
      });
    }
  }

  /**
   * Reingreso de stock (anulación de venta o nota de crédito con devolución).
   * Contrapartida exacta de `egresarStockItems`.
   */
  async reingresarStockItems(tx: any, o: any) {
    const prodDe = await this.productosDe(tx, (o.items || []).map((it: any) => Number(it.productoId)));
    for (const it of o.items || []) {
      const presId = it.presentacionId || null;
      const cantidad = Number(it.cantidad) || 0;
      if (cantidad <= 0) continue;
      const prod = prodDe.get(Number(it.productoId));
      if (!prod) continue;
      await this.addDelta(tx, { productoId: it.productoId, sucursalId: o.sucursalId, presentacionId: presId, estado: 'disponible' }, cantidad);
      await this.mov(tx, {
        /* El tipo por defecto es la devolución, que es para lo que nació este
         * helper. Un llamador puede pedir el suyo (0097: la mercadería que
         * LLEGA de la cafetería no es una devolución de nada) — sin esto, esos
         * ingresos apareceriían en el libro del almacén como devoluciones. */
        tipo: o.tipoMovimiento || 'devolucion',
        productoId: it.productoId, sucursalId: o.sucursalId, presentacionId: presId, signo: 1,
        cantidad, unidad: this.unidadDe(prod.tipo, presId), estadoHacia: 'disponible',
        usuarioId: o.usuarioId ?? null, descripcion: o.descripcion || 'Reingreso por anulación',
      });
    }
  }

  /* ============================ TRANSFERENCIAS ============================ *
   * Modelo PULL con el stock acompañando los estados:
   *
   *   pendiente ── tomar ──► preparada (EN PREPARACIÓN) ── despachar ──► transito ── recibir ──► recibida
   *   (demanda:     el pedido se divide en DOS listas por tipo    comprometido→        lo contado va al
   *    sin stock)   de producto: ENTEROS (preparador) y GRANEL    en_transito          destino; el resto,
   *                 (fraccionador). Cada encargado edita lo       (sigue en el         a incidencia
   *                 preparado, agrega renglones si llegó          origen)
   *                 mercadería, y CONFIRMA su lista — recién
   *                 ahí se reserva (disponible→comprometido).
   *
   * El pedido NO exige ni toca stock: lo arma el destino y el origen quizá
   * todavía no tiene la mercadería. La realidad entra al CONFIRMAR cada lista,
   * que es cuando la mercadería queda físicamente apartada. El despacho exige
   * todas las listas presentes confirmadas y viaja LO PREPARADO, no lo pedido.
   */

  /** A qué lista de preparación pertenece un producto. */
  private listaDe(prodTipo: string): 'enteros' | 'granel' {
    return prodTipo === 'granel' ? 'granel' : 'enteros';
  }

  async crearTransferencia(o: any) {
    return this.db.transaction(async (tx) => {
      const [origen] = await tx.select().from(sucursales).where(eq(sucursales.id, o.origenId)).limit(1);
      const [destino] = await tx.select().from(sucursales).where(eq(sucursales.id, o.destinoId)).limit(1);
      if (!origen || !destino || origen.id === destino.id) throw new BadRequestException('Elegí origen y destino distintos.');
      const items = (o.items || []).filter((it: any) => Number(it.cantidad) > 0);
      if (!items.length) throw new BadRequestException('Agregá al menos un ítem con cantidad.');

      const [t] = await tx.insert(transferencias).values({
        codigo: '', origenId: origen.id, destinoId: destino.id, usuarioId: o.usuarioId ?? null,
        estado: 'pendiente', observaciones: (o.observaciones ?? '').trim(),
      }).returning();
      const codigo = 'TR' + String(t.id).padStart(4, '0');
      await tx.update(transferencias).set({ codigo }).where(eq(transferencias.id, t.id));
      await tx.insert(transferenciaHist).values({ transferenciaId: t.id, estado: 'pendiente', usuarioId: o.usuarioId ?? null });
      await tx.insert(transferenciaItems).values(items.map((it: any) => ({
        transferenciaId: t.id, productoId: it.productoId,
        presentacionId: it.presId || null, cantidad: Number(it.cantidad),
        // Lo preparado arranca igual a lo pedido; el origen lo ajusta después.
        cantidadPreparada: Number(it.cantidad),
      })));
      return { ok: true, id: t.id, codigo };
    });
  }

  /* ------------------------- Novedades del pedido ------------------------- */
  /**
   * QUÉ LLEGÓ AL DEPÓSITO QUE ESTE LOCAL TODAVÍA NO SABE (0083).
   *
   * El problema es de descubrimiento, no de datos: armando el pedido, el cajero
   * solo tiene el BUSCADOR y el filtro "sin stock". O sea que **solo encuentra
   * lo que ya sabe que existe** — un producto nuevo es literalmente invisible,
   * porque no puede buscar un nombre que nunca escuchó. La mercadería llega a
   * la Distribuidora y los locales se enteran por comentario de pasillo.
   *
   * DOS CHIPS, DOS PREGUNTAS DISTINTAS, y por eso DOS VENTANAS distintas
   * (redefinidos por el dueño el 25/8/2026 — antes "nuevo" era relativo al
   * local, y a una sucursal sin historia le gritaba NUEVO el catálogo entero):
   *
   *  · **NUEVO** — el producto SE CREÓ hace poco (`productos.creadoEn` dentro
   *    de `DIAS_NUEVO`) y entró a stock. Es novedad DEL CATÁLOGO: algo que el
   *    cajero no puede buscar porque no sabe que existe. Ventana larga y con
   *    insistencia a propósito: si entró el martes y el local pidió el
   *    miércoles sin verlo, con ventana corta desaparecía para siempre. Se
   *    apaga antes solo si este local ya lo recibió (dejó de ser novedad
   *    para él — eso se mide contra `movimientos` del destino, que graba una
   *    fila en cada punta de la transferencia).
   *
   *  · **REINGRESO** — ya existía y VOLVIÓ a entrar al depósito desde el
   *    último pedido de este local. Responde "¿ya puedo pedir eso que no
   *    había?". Ventana corta a propósito: es reposición, y repetirla todos
   *    los días la vuelve ruido. Que este local nunca lo haya tenido no lo
   *    convierte en nuevo: el producto es viejo en el negocio.
   *
   * TRES COSAS QUE NO SE VEN Y SIN LAS CUALES ESTO NO SIRVE:
   *
   *  1. **Se exige stock disponible HOY en el origen.** "Llegó el lunes" no es
   *     lo mismo que "hay": pudo irse el martes. Una lista que ofrece lo que no
   *     está se deja de mirar a la segunda vez.
   *  2. **Solo productos `activo`.** Un discontinuado se sigue vendiendo hasta
   *     agotar, pero no es una novedad que haya que empujar.
   *  3. **`CORTE_HISTORICO`** — los productos importados del sistema viejo no
   *     tienen compras registradas, así que sin esto el día del estreno TODO
   *     aparecería como novedad y el cajero cerraría la pestaña para siempre.
   *     Es la trampa clásica de estas funciones: nacen gritando y se apagan.
   */

  /** Cuántos días desde su ALTA un producto sigue siendo "nuevo". */
  private static readonly DIAS_NUEVO = 30;

  /**
   * Nada anterior a esta fecha cuenta como novedad. El catálogo migrado no
   * tiene historia de compras: sin este piso, el primer día son 550 novedades.
   */
  private static readonly CORTE_HISTORICO = new Date('2026-08-01T00:00:00-03:00');

  async novedadesPedido(o: { origenId: number; destinoId: number }) {
    const origenId = Number(o.origenId);
    const destinoId = Number(o.destinoId);
    if (!Number.isInteger(origenId) || !Number.isInteger(destinoId) || origenId === destinoId) {
      throw new BadRequestException('Elegí origen y destino distintos.');
    }

    /* EL CORTE: el último pedido REAL de este local por esta ruta. El borrador
     * no cuenta —es el que se está armando ahora— y el cancelado tampoco. */
    const [ultimo] = await this.db
      .select({ fecha: transferencias.fecha })
      .from(transferencias)
      .where(and(
        eq(transferencias.origenId, origenId),
        eq(transferencias.destinoId, destinoId),
        ne(transferencias.estado, 'borrador'),
        ne(transferencias.estado, 'cancelada'),
      ))
      .orderBy(desc(transferencias.fecha))
      .limit(1);

    const piso = InventarioService.CORTE_HISTORICO;
    const masNuevo = (a: Date, b: Date) => (a > b ? a : b);
    /* Sin pedidos previos (local nuevo) la ventana corta arranca en el piso
     * histórico: mostrarle TODO no ayuda, pero no mostrarle nada tampoco. */
    const desdeLlego = masNuevo(ultimo?.fecha ?? piso, piso);
    const desdeNuevo = masNuevo(
      new Date(Date.now() - InventarioService.DIAS_NUEVO * 86400_000),
      piso,
    );
    /* Se consulta por la MÁS VIEJA de las dos y se clasifica en memoria: son
     * dos preguntas sobre la misma tabla, y hacerlas por separado sería
     * recorrer `movimientos` dos veces para el mismo rango. */
    const desde = desdeLlego < desdeNuevo ? desdeLlego : desdeNuevo;

    /* Lo que ENTRÓ al depósito por compra en la ventana, con la fecha de la
     * última entrada de cada producto. */
    const entradas = await this.db
      .select({
        productoId: movimientos.productoId,
        fecha: sql<Date>`max(${movimientos.fecha})`,
      })
      .from(movimientos)
      .where(and(
        eq(movimientos.tipo, 'compra'),
        eq(movimientos.sucursalId, origenId),
        gte(movimientos.fecha, desde),
        isNotNull(movimientos.productoId),
      ))
      .groupBy(movimientos.productoId);

    if (!entradas.length) {
      return { desde: desdeLlego, desdeNuevo, ultimoPedido: ultimo?.fecha ?? null, items: [] };
    }
    const ids = entradas.map((e) => e.productoId!).filter(Boolean);

    /* Cuáles de esos este local YA tuvo alguna vez. Una sola consulta contra
     * todo el historial del destino, sin ventana: "nunca" es nunca. */
    const vistos = await this.db
      .select({ productoId: movimientos.productoId })
      .from(movimientos)
      .where(and(eq(movimientos.sucursalId, destinoId), inArray(movimientos.productoId, ids)))
      .groupBy(movimientos.productoId);
    const yaTuvo = new Set(vistos.map((v) => v.productoId));

    /* Y cuáles hay REALMENTE para mandar hoy (ver punto 1 del encabezado). */
    const hay = await this.db
      .select({
        productoId: stock.productoId,
        total: sql<number>`sum(${stock.cantidad})`,
      })
      .from(stock)
      .where(and(
        eq(stock.sucursalId, origenId),
        eq(stock.estado, 'disponible'),
        inArray(stock.productoId, ids),
      ))
      .groupBy(stock.productoId);
    const disponible = new Map(hay.map((h) => [h.productoId, Number(h.total) || 0]));

    const activos = await this.db
      .select({ id: productos.id, creadoEn: productos.creadoEn })
      .from(productos)
      .where(and(inArray(productos.id, ids), eq(productos.estado, 'activo')));
    const altaDe = new Map(activos.map((a) => [a.id, a.creadoEn]));

    const items: { productoId: number; chip: 'nuevo' | 'reingreso'; fecha: Date; disponible: number }[] = [];
    for (const e of entradas) {
      const id = e.productoId!;
      if (!altaDe.has(id)) continue;
      const disp = disponible.get(id) ?? 0;
      if (disp <= 1e-9) continue;
      const fecha = new Date(e.fecha as any);
      /*
       * NUEVO se decide por la EDAD DEL PRODUCTO, no por el local (25/8): se
       * creó dentro de la ventana y este local todavía no lo recibió. Todo lo
       * demás que entró es REINGRESO — el producto ya existía en el negocio.
       */
      const alta = new Date(altaDe.get(id) as any);
      const nuevo = alta >= desdeNuevo && !yaTuvo.has(id);
      /* Cada chip tiene SU ventana: la novedad del catálogo aguanta más días
       * que una reposición común (ver el encabezado). */
      if (nuevo ? fecha < desdeNuevo : fecha < desdeLlego) continue;
      items.push({ productoId: id, chip: nuevo ? 'nuevo' : 'reingreso', fecha, disponible: disp });
    }
    /* LO ÚLTIMO QUE ENTRÓ VA ARRIBA, sin agrupar por chip (pedido del dueño,
     * 25/8/2026 — antes los NUEVO iban todos antes que los LLEGÓ). El chip ya
     * distingue nuevo de reingreso a la vista: agruparlos encima repetía esa
     * información, y escondía lo recién llegado detrás de novedades viejas. */
    items.sort((a, b) => b.fecha.getTime() - a.fecha.getTime());

    return { desde: desdeLlego, desdeNuevo, ultimoPedido: ultimo?.fecha ?? null, items };
  }

  /* ------------------- El pedido que se arma de a poco ------------------- */
  /*
   * EL BORRADOR (0055). El cajero atiende clientes; el pedido lo arma entre
   * uno y otro. Así que el pedido tiene que vivir en la base desde el primer
   * renglón, no en la pantalla: cerrar el modal, cambiar de máquina o irse a
   * casa no puede costar el trabajo del día.
   *
   * Es UNO POR RUTA (origen → destino), no por cajero: el pedido es del LOCAL.
   * Ver el comentario de la 0056 — dos borradores por ruta terminan en
   * mercadería duplicada en el depósito.
   *
   * Mientras es borrador NO toca stock y el origen NO lo ve. La serie TR se
   * asigna al enviarlo.
   */

  /** El borrador de esa ruta, o uno nuevo. Idempotente: llamarlo dos veces da el mismo. */
  async borradorTransferencia(o: { origenId: number; destinoId: number; usuarioId?: number }) {
    return this.db.transaction(async (tx) => {
      const [origen] = await tx.select().from(sucursales).where(eq(sucursales.id, o.origenId)).limit(1);
      const [destino] = await tx.select().from(sucursales).where(eq(sucursales.id, o.destinoId)).limit(1);
      if (!origen || !destino || origen.id === destino.id) throw new BadRequestException('Elegí origen y destino distintos.');

      const buscar = async () => {
        const [t] = await tx.select().from(transferencias).where(and(
          eq(transferencias.origenId, origen.id),
          eq(transferencias.destinoId, destino.id),
          eq(transferencias.estado, 'borrador'),
        )).limit(1);
        return t;
      };

      let t = await buscar();
      if (!t) {
        try {
          [t] = await tx.insert(transferencias).values({
            codigo: '', origenId: origen.id, destinoId: destino.id,
            usuarioId: o.usuarioId ?? null, estado: 'borrador', observaciones: '',
          }).returning();
        } catch (e: any) {
          // Dos cajeros abrieron el pedido en el mismo segundo: el índice único
          // parcial (0056) dejó pasar a uno solo. El que perdió se queda con el
          // borrador del otro, que es exactamente lo que se quiere.
          if (!/transfer_borrador_unico/.test(e?.message ?? '')) throw e;
          t = await buscar();
          if (!t) throw e;
        }
      }
      const items = await tx.select().from(transferenciaItems).where(eq(transferenciaItems.transferenciaId, t.id));
      return { ...t, items };
    });
  }

  /**
   * Guarda el borrador COMPLETO: la lista que manda el modal reemplaza la que
   * había. Un solo endpoint en vez de agregar/editar/quitar renglón por
   * renglón, porque es lo que el modal tiene en la mano y porque así el
   * guardado automático es idempotente — se puede repetir sin duplicar nada.
   *
   * Los renglones en 0 se guardan igual: recién agregado y sin tipear todavía
   * es un estado normal mientras se arma. Se limpian al enviar.
   */
  async guardarBorrador(id: number, o: { items?: any[]; observaciones?: string; usuarioId?: number }, soloSuc?: number | null) {
    return this.db.transaction(async (tx) => {
      const t = await this.borradorVigente(tx, id, soloSuc);
      const crudos = Array.isArray(o.items) ? o.items : [];
      if (crudos.length > 300) throw new BadRequestException('Demasiados renglones en un pedido (máximo 300).');

      /*
       * LOS PRODUCTOS Y LOS PAQUETES DE TODOS LOS RENGLONES, EN DOS CONSULTAS.
       *
       * Esto corre en cada guardado automático del pedido —cada vez que el
       * cajero deja de tipear un segundo— y hacía dos viajes a la base POR
       * RENGLÓN, con la transacción abierta: un pedido de 150 renglones eran
       * 300 consultas en fila por cada cantidad que se tocaba, y con dos
       * locales armando su pedido a la vez la API se quedaba sin conexiones
       * para las cajas. Las validaciones son las mismas, en el mismo orden;
       * solo cambia que la base se consulta una vez.
       */
      const prodIds = crudos.map((it) => Number(it.productoId)).filter((n) => Number.isInteger(n) && n > 0);
      const presIds = crudos.map((it) => (it.presId ? Number(it.presId) : 0)).filter((n) => Number.isInteger(n) && n > 0);
      const [prods, press] = await Promise.all([
        prodIds.length
          ? tx.select({ id: productos.id, nombre: productos.nombre, tipo: productos.tipo }).from(productos).where(inArray(productos.id, [...new Set(prodIds)]))
          : [],
        presIds.length
          ? tx.select({ id: presentaciones.id, productoId: presentaciones.productoId })
            .from(presentaciones).where(inArray(presentaciones.id, [...new Set(presIds)]))
          : [],
      ]);
      const existe = new Set(prods.map((p: any) => p.id));
      const prodDe = new Map<number, any>(prods.map((p: any): [number, any] => [p.id, p]));
      const duenoDePres = new Map<number, number>(press.map((p: any): [number, number] => [p.id, p.productoId]));

      const filas: any[] = [];
      for (const it of crudos) {
        const prodId = Number(it.productoId);
        if (!Number.isInteger(prodId) || prodId <= 0) continue;
        if (!existe.has(prodId)) throw new BadRequestException('Hay un renglón con un producto que ya no existe.');
        const cant = Number(it.cantidad);
        if (!Number.isFinite(cant) || cant < 0) throw new BadRequestException('Cantidad inválida en un renglón.');
        let presId: number | null = it.presId ? Number(it.presId) : null;
        if (presId) {
          // La presentación tiene que ser DE ESE producto: un id ajeno pediría
          // "5 paquetes de 250 g" de algo que no los tiene.
          if (duenoDePres.get(presId) !== prodId) throw new BadRequestException('Una presentación elegida no es de su producto.');
        }
        this.exigirEntero(prodDe.get(prodId), presId, cant);
        filas.push({
          transferenciaId: t.id, productoId: prodId, presentacionId: presId,
          cantidad: cant, cantidadPreparada: cant,
        });
      }

      await tx.delete(transferenciaItems).where(eq(transferenciaItems.transferenciaId, t.id));
      if (filas.length) await tx.insert(transferenciaItems).values(filas);
      const patch: any = {};
      if (o.observaciones != null) patch.observaciones = String(o.observaciones).trim();
      // Queda quién lo tocó ÚLTIMO: el borrador pasa de mano en mano entre turnos.
      if (o.usuarioId != null) patch.usuarioId = o.usuarioId;
      if (Object.keys(patch).length) await tx.update(transferencias).set(patch).where(eq(transferencias.id, t.id));
      return { ok: true, renglones: filas.length };
    });
  }

  /**
   * Manda el pedido: borrador → pendiente. Recién acá se asigna el código y el
   * origen lo ve en su bandeja. Los renglones en 0 se van (son los que se
   * agregaron y nunca se completaron).
   */
  async enviarBorrador(id: number, o: { usuarioId?: number } = {}, soloSuc?: number | null) {
    return this.db.transaction(async (tx) => {
      const t = await this.borradorVigente(tx, id, soloSuc);
      const items = await tx.select().from(transferenciaItems).where(eq(transferenciaItems.transferenciaId, t.id));
      const vacios = items.filter((it: any) => !(it.cantidad > 1e-9));
      if (items.length - vacios.length === 0) {
        throw new BadRequestException('El pedido no tiene ningún renglón con cantidad.');
      }
      for (const it of vacios) await tx.delete(transferenciaItems).where(eq(transferenciaItems.id, it.id));

      const codigo = 'TR' + String(t.id).padStart(4, '0');
      // Reclamo atómico: dos "Enviar" simultáneos mandarían el pedido dos veces.
      const gano = await tx.update(transferencias)
        .set({ estado: 'pendiente', codigo, fecha: new Date(), usuarioId: o.usuarioId ?? t.usuarioId })
        .where(and(eq(transferencias.id, t.id), eq(transferencias.estado, 'borrador')))
        .returning({ id: transferencias.id });
      if (!gano.length) throw new BadRequestException('El pedido ya se había enviado — actualizá la pantalla.');
      await tx.insert(transferenciaHist).values({ transferenciaId: t.id, estado: 'pendiente', usuarioId: o.usuarioId ?? null });
      return { ok: true, id: t.id, codigo, renglones: items.length - vacios.length };
    });
  }

  /**
   * Descarta el borrador. Se BORRA, no se cancela: nunca fue un documento —
   * no tuvo código, no tocó stock y nadie lo vio. Dejarlo como "cancelada"
   * llenaría el historial de pedidos que jamás existieron.
   */
  async descartarBorrador(id: number, soloSuc?: number | null) {
    return this.db.transaction(async (tx) => {
      const t = await this.borradorVigente(tx, id, soloSuc);
      await tx.delete(transferenciaItems).where(eq(transferenciaItems.transferenciaId, t.id));
      await tx.delete(transferenciaHist).where(eq(transferenciaHist.transferenciaId, t.id));
      await tx.delete(transferencias).where(eq(transferencias.id, t.id));
      return { ok: true };
    });
  }

  /** Guarda común de los tres de arriba: existe y TODAVÍA es borrador. */
  /**
   * EL DUEÑO DE CADA LADO DEL REMITO (decisión del dueño, 13/8/2026).
   *
   * La red es pull: cada sucursal **pide** y **recibe** lo que llega a ella
   * (`destinoId`) y **prepara** lo que sale de ella (`origenId`). El único
   * pedido que prepara alguien que no es su dueño es el de la Cafetería, y ese
   * va por otro circuito.
   *
   * `soloSuc` es `null` para el jefe, que atraviesa las tres puntas.
   */
  private exigirLado(t: any, soloSuc: number | null | undefined, lado: 'origenId' | 'destinoId') {
    if (soloSuc == null) return;
    if (t[lado] !== soloSuc) {
      throw new ForbiddenException(
        lado === 'destinoId'
          ? 'Ese pedido es de otra sucursal: lo pide y lo recibe ella.'
          : 'Esa transferencia sale de otra sucursal: la prepara ella.',
      );
    }
  }

  private async borradorVigente(tx: any, id: number, soloSuc?: number | null) {
    const [t] = await tx.select().from(transferencias).where(eq(transferencias.id, id)).limit(1);
    if (!t) throw new NotFoundException('Pedido inexistente.');
    /* Contra el DESTINO: el borrador es el pedido del día de una ruta, y se
     * guarda solo. Un `PUT` con `items: []` sobre el id de otra ruta le borraba
     * a esa sucursal el trabajo de toda la jornada, y el borrador no tiene
     * historial: desaparecía sin dejar rastro. */
    this.exigirLado(t, soloSuc, 'destinoId');
    if (t.estado !== 'borrador') {
      throw new BadRequestException('Este pedido ya se envió: no se edita como borrador.');
    }
    return t;
  }

  /* ------------------- Preparación en dos listas ------------------- */

  /**
   * Foto de una transferencia en preparación, con guardas comunes: existe,
   * está en la fase correcta, y la LISTA del renglón que se quiere tocar no
   * fue confirmada todavía (confirmada = mercadería apartada y reservada; para
   * tocarla hay que desconfirmar primero).
   */
  private async transferEnPreparacion(tx: any, id: number, soloSuc?: number | null) {
    /* Con candado (25/9/2026): editar un renglón leía "lista sin confirmar" de
     * una foto, y una confirmación en paralelo reservaba stock con el número
     * viejo — lo reservado y lo preparado quedaban distintos. Así se ponen en
     * fila con `confirmarLista`, que toma la misma fila. */
    const [t] = await tx.select().from(transferencias).where(eq(transferencias.id, id)).limit(1).for('update');
    if (!t) throw new NotFoundException('Transferencia inexistente.');
    // Contra el ORIGEN: preparar es sacar mercadería del propio depósito.
    this.exigirLado(t, soloSuc, 'origenId');
    if (t.estado !== 'preparada') throw new BadRequestException('Solo se edita durante la preparación.');
    return t;
  }

  private listaBloqueada(t: any, lista: 'enteros' | 'granel') {
    return lista === 'enteros' ? t.enterosListo : t.granelListo;
  }

  /** Edita cantidad preparada y/o motivo de un renglón, con su lista sin confirmar. */
  async editarItemTransferencia(id: number, itemId: number, o: { cantidadPreparada?: number; motivo?: string }, soloSuc?: number | null) {
    return this.db.transaction(async (tx) => {
      const t = await this.transferEnPreparacion(tx, id, soloSuc);
      const [it] = await tx.select().from(transferenciaItems)
        .where(and(eq(transferenciaItems.id, itemId), eq(transferenciaItems.transferenciaId, id))).limit(1);
      if (!it) throw new NotFoundException('Renglón inexistente.');
      const prod = await this.getProducto(tx, it.productoId);
      if (this.listaBloqueada(t, this.listaDe(prod.tipo))) {
        throw new BadRequestException('Esa lista ya está confirmada — desconfirmala para editar.');
      }
      const patch: any = {};
      if (o.cantidadPreparada != null) {
        const c = Number(o.cantidadPreparada);
        if (!Number.isFinite(c) || c < 0) throw new BadRequestException('Cantidad preparada inválida.');
        this.exigirEntero(prod, it.presentacionId, c);
        /*
         * PREPARAR MÁS DE LO PEDIDO (25/9/2026). Se puede —una caja cerrada de
         * 12 cuando pidieron 10— pero no en silencio: sin tope ni aviso se
         * podían preparar 999 de un renglón que pidió 4 y reservarlos. Pide el
         * motivo, que queda en el remito. Los renglones AGREGADOS no tienen
         * "pedido" (es 0): ya nacen con su motivo.
         */
        const motivo = String(o.motivo ?? it.motivo ?? '').trim();
        if (!it.agregado && c > Number(it.cantidad) + 1e-9 && !motivo) {
          throw new BadRequestException(
            `Pidieron ${this.fmtCant(prod.tipo, it.presentacionId, Number(it.cantidad))} y estás preparando ${this.fmtCant(prod.tipo, it.presentacionId, c)}: poné el motivo de mandar de más.`,
          );
        }
        patch.cantidadPreparada = c;
      }
      if (o.motivo != null) patch.motivo = String(o.motivo).trim();
      if (!Object.keys(patch).length) return { ok: true };
      await tx.update(transferenciaItems).set(patch).where(eq(transferenciaItems.id, itemId));
      return { ok: true };
    });
  }

  /**
   * Agrega un renglón DURANTE la preparación (llegó mercadería a último
   * momento y viaja en este mismo envío, sin que el destino re-pida).
   * `cantidad` (lo pedido) queda en 0: nadie lo pidió — el remito lo muestra
   * como "Agregado".
   */
  async agregarItemTransferencia(id: number, o: { productoId: number; presId?: number | null; cantidad: number; motivo?: string }, soloSuc?: number | null) {
    return this.db.transaction(async (tx) => {
      const t = await this.transferEnPreparacion(tx, id, soloSuc);
      const prod = await this.getProducto(tx, o.productoId);
      if (!prod) throw new BadRequestException('Producto inválido.');
      /* El paquete tiene que ser DE ESTE producto (25/9/2026), igual que al armar
       * el pedido y al registrar un fraccionado. Sin esto se podía agregar
       * "Lentejas" con el paquete de 1 kg de Arroz, y al confirmar la lista se
       * fraccionaban Lentejas en un paquete que es de otro producto. */
      if (o.presId) {
        const [pres] = await tx.select({ id: presentaciones.id }).from(presentaciones)
          .where(and(eq(presentaciones.id, o.presId), eq(presentaciones.productoId, prod.id))).limit(1);
        if (!pres) throw new BadRequestException(`Ese paquete no es de ${prod.nombre}.`);
      }
      if (this.listaBloqueada(t, this.listaDe(prod.tipo))) {
        throw new BadRequestException('Esa lista ya está confirmada — desconfirmala para agregar.');
      }
      const c = Number(o.cantidad);
      if (!Number.isFinite(c) || c <= 0) throw new BadRequestException('Ingresá la cantidad que se agrega.');
      this.exigirEntero(prod, o.presId || null, c);
      const [row] = await tx.insert(transferenciaItems).values({
        transferenciaId: id, productoId: prod.id, presentacionId: o.presId || null,
        cantidad: 0, cantidadPreparada: c, agregado: true,
        motivo: (o.motivo ?? '').trim() || 'Agregado en preparación',
      }).returning();
      return { ok: true, itemId: row.id };
    });
  }

  /** Quita un renglón agregado (los pedidos por el destino no se borran: se ponen en 0). */
  async quitarItemTransferencia(id: number, itemId: number, soloSuc?: number | null) {
    return this.db.transaction(async (tx) => {
      const t = await this.transferEnPreparacion(tx, id, soloSuc);
      const [it] = await tx.select().from(transferenciaItems)
        .where(and(eq(transferenciaItems.id, itemId), eq(transferenciaItems.transferenciaId, id))).limit(1);
      if (!it) throw new NotFoundException('Renglón inexistente.');
      if (!it.agregado) throw new BadRequestException('Los renglones pedidos por el destino no se borran: poné la cantidad preparada en 0.');
      const prod = await this.getProducto(tx, it.productoId);
      if (this.listaBloqueada(t, this.listaDe(prod.tipo))) {
        throw new BadRequestException('Esa lista ya está confirmada — desconfirmala para quitar renglones.');
      }
      await tx.delete(transferenciaItems).where(eq(transferenciaItems.id, itemId));
      return { ok: true };
    });
  }

  /**
   * Confirma (o desconfirma) UNA lista de preparación. Confirmar es el momento
   * de verdad: la mercadería quedó apartada físicamente, así que acá se valida
   * y RESERVA el stock de esa lista (disponible → comprometido) por lo
   * PREPARADO. Desconfirmar libera la reserva para poder seguir editando.
   *
   * El reclamo del flag es atómico (`WHERE flag = <contrario>`): dos clics
   * simultáneos en Confirmar reservarían dos veces — solo uno gana el UPDATE.
   */
  async confirmarListaTransferencia(id: number, o: { tipo: 'enteros' | 'granel'; listo: boolean; usuarioId?: number; operadorId?: number }, soloSuc?: number | null) {
    if (o.tipo !== 'enteros' && o.tipo !== 'granel') throw new BadRequestException('Lista inválida.');
    return this.db.transaction(async (tx) => {
      const t = await this.transferEnPreparacion(tx, id, soloSuc);
      const col = o.tipo === 'enteros' ? transferencias.enterosListo : transferencias.granelListo;
      const gano = await tx.update(transferencias)
        .set(o.tipo === 'enteros' ? { enterosListo: o.listo } : { granelListo: o.listo })
        .where(and(eq(transferencias.id, id), eq(transferencias.estado, 'preparada'), eq(col, !o.listo)))
        .returning({ id: transferencias.id });
      if (!gano.length) throw new BadRequestException('La lista cambió de estado — actualizá la pantalla.');

      const items = await tx.select().from(transferenciaItems).where(eq(transferenciaItems.transferenciaId, id));
      const mios: { it: any; prod: any }[] = [];
      for (const it of items) {
        const prod = await this.getProducto(tx, it.productoId);
        if (this.listaDe(prod.tipo) === o.tipo && it.cantidadPreparada > 1e-9) mios.push({ it, prod });
      }

      /*
       * ANTES DE RESERVAR, SE COMPLETA LO QUE FALTA (17/9/2026, pedido del dueño).
       *
       * Acá había un `throw`: cualquier renglón corto abortaba la confirmación
       * entera con "Stock insuficiente para confirmar". Y el caso que lo
       * disparaba casi siempre no era escasez — era la FORMA de la mercadería.
       * El pedido pide 2 paquetes de 150 g, el depósito tiene 50 kg a granel y
       * CERO paquetes: para el stock son dos cosas distintas, y el paquete no
       * existe hasta que alguien lo arma. El sistema sabía los kilos que hay y
       * los paquetes que faltan, y aun así mandaba al fraccionador a entrar
       * producto por producto a hacer la cuenta a mano — cinco renglones, cinco
       * viajes, y en cada uno tipeando un número que el pedido ya dice.
       *
       * Ahora confirmar hace el trabajo: fracciona lo justo para cubrir cada
       * renglón y recién entonces reserva. Y si ni el granel alcanza, no traba:
       * baja lo preparado a lo que realmente hay, lo deja anotado con su motivo
       * y sigue. El pedido viaja con lo que existe, que es lo que iba a viajar
       * igual — la diferencia es que ya no hay que pelearlo a mano.
       *
       * Todo dentro de la MISMA transacción que la reserva: si algo falla más
       * abajo, el fraccionado tampoco ocurrió.
       */
      let armados: string[] = [];
      let recortes: string[] = [];
      if (o.listo) ({ armados, recortes } = await this.completarPreparado(tx, t, mios, o.usuarioId, o.operadorId));

      const etiqueta = o.tipo === 'enteros' ? 'Enteros' : 'Fraccionados';
      for (const { it, prod } of mios) {
        // Recortado a 0 por falta de stock: no queda nada que apartar.
        if (!(it.cantidadPreparada > 1e-9)) continue;
        if (o.listo) {
          await this.move(tx, { productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId }, 'disponible', 'comprometido', it.cantidadPreparada);
        } else {
          await this.move(tx, { productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId }, 'comprometido', 'disponible', it.cantidadPreparada);
        }
        await this.mov(tx, {
          tipo: 'transferencia', productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId, signo: 0,
          cantidad: it.cantidadPreparada, unidad: this.unidadDe(prod.tipo, it.presentacionId),
          estadoDesde: o.listo ? 'disponible' : 'comprometido', estadoHacia: o.listo ? 'comprometido' : 'disponible',
          sucursalDestinoId: t.destinoId, refTransferenciaId: t.id, usuarioId: o.usuarioId ?? null,
          descripcion: o.listo
            ? `${t.codigo}: lista ${etiqueta} confirmada, stock reservado`
            : `${t.codigo}: lista ${etiqueta} desconfirmada, stock liberado`,
        });
      }
      return { ok: true, tipo: o.tipo, listo: o.listo, armados, recortes };
    });
  }

  /**
   * COMPLETA LOS RENGLONES CORTOS DE UNA LISTA, JUSTO ANTES DE RESERVARLA.
   *
   * Dos herramientas, en este orden:
   *
   *   1. FRACCIONAR. Sirve solo para el paquete de un granel, que es el único
   *      caso en que la mercadería YA ESTÁ en el depósito, nada más que en
   *      otra forma. Se arma lo JUSTO para cubrir el renglón: ni un paquete de
   *      más, porque armar de más deja kilos encerrados en un envase que quizá
   *      nadie pidió, y el granel envasado no se desarma solo.
   *
   *   2. RECORTAR. Si ni así alcanza, lo preparado baja a lo que hay y queda
   *      el motivo escrito. Un motivo que el encargado haya puesto a mano NO
   *      se pisa: él sabe POR QUÉ falta, el sistema solo sabe que falta.
   *
   * Los renglones se recorren EN ORDEN y cada uno vuelve a leer el granel: dos
   * presentaciones del mismo producto comen del mismo pozo, y si no da para
   * las dos, la primera de la lista se lleva lo que hay. Es arbitrario, pero
   * es estable y explicable — repartir a medias no completaría ninguna.
   */
  private async completarPreparado(
    tx: any,
    t: any,
    mios: { it: any; prod: any }[],
    usuarioId?: number,
    operadorPedido?: number,
  ): Promise<{ armados: string[]; recortes: string[] }> {
    const armados: string[] = [];
    const recortes: string[] = [];
    /* El operador se resuelve la PRIMERA vez que hace falta armar: una lista
     * que ya tenía los paquetes hechos no fracciona nada y no tiene por qué
     * pedirlo. `undefined` = todavía no se preguntó. */
    let operadorId: number | null | undefined;
    /* Todo lo que esta confirmación arme va a UN registro del historial. */
    const renglonesArmados: { productoId: number; presentacionId: number; tamKg: number; paquetes: number; movimientoId: number }[] = [];

    const presIds = Array.from(
      new Set(mios.map(({ it }) => it.presentacionId).filter((x: any) => x != null)),
    ) as number[];
    const press = presIds.length
      ? await tx.select().from(presentaciones).where(inArray(presentaciones.id, presIds))
      : [];
    const porId = new Map<number, any>(press.map((pr: any): [number, any] => [pr.id, pr]));

    for (const { it, prod } of mios) {
      let disp = await this.cant(tx, it.productoId, t.origenId, it.presentacionId, 'disponible');
      if (it.cantidadPreparada <= disp + 1e-9) continue;

      const pres = it.presentacionId != null ? porId.get(it.presentacionId) : null;
      if (prod.tipo === 'granel' && pres && pres.tamKg > 0) {
        // Va a fraccionar: granel y paquete con candado, y el paquete se relee.
        const granel = await this.cantConCandado(tx, it.productoId, t.origenId, null, 'disponible');
        disp = await this.cantConCandado(tx, it.productoId, t.origenId, it.presentacionId, 'disponible');
        if (it.cantidadPreparada <= disp + 1e-9) continue;
        const faltan = Math.ceil(it.cantidadPreparada - disp - 1e-9);
        const armar = Math.min(faltan, Math.floor(granel / pres.tamKg + 1e-9));
        if (armar > 0) {
          if (operadorId === undefined) {
            operadorId = await this.operadorDeFraccion(tx, operadorPedido, t.origenId, true);
          }
          const kg = Math.round(armar * pres.tamKg * 1000) / 1000;
          const base = { productoId: it.productoId, sucursalId: t.origenId, estado: 'disponible' as const };
          await this.addDelta(tx, { ...base, presentacionId: null }, -kg);
          await this.addDelta(tx, { ...base, presentacionId: it.presentacionId }, armar);
          const m = await this.mov(tx, {
            tipo: 'fraccionamiento', productoId: it.productoId, sucursalId: t.origenId,
            presentacionId: it.presentacionId, signo: 0, cantidad: kg, unidad: 'kg',
            presLabel: `Granel → ${this.fmtTam(pres.tamKg)}`,
            refTransferenciaId: t.id, usuarioId: usuarioId ?? null,
            descripcion: `${t.codigo}: fraccionó ${kg} kg en ${armar}×${this.fmtTam(pres.tamKg)} para completar el pedido`,
          });
          renglonesArmados.push({
            productoId: it.productoId, presentacionId: it.presentacionId, tamKg: pres.tamKg, paquetes: armar, movimientoId: m.id,
          });
          armados.push(`${prod.nombre}: ${armar}×${this.fmtTam(pres.tamKg)} (${kg} kg de granel)`);
          disp += armar;
        }
      }

      if (it.cantidadPreparada <= disp + 1e-9) continue;

      /* Lo que queda va como viaja: paquetes y unidades ENTEROS —medio paquete
       * no sube al camión—, el granel suelto con sus tres decimales. */
      const antes = it.cantidadPreparada;
      const hay = this.unidadDe(prod.tipo, it.presentacionId) === 'kg'
        ? Math.max(0, Math.round(disp * 1000) / 1000)
        : Math.max(0, Math.floor(disp + 1e-9));
      const patch: any = { cantidadPreparada: hay };
      if (!String(it.motivo ?? '').trim()) patch.motivo = 'Sin stock: se preparó lo que había';
      await tx.update(transferenciaItems).set(patch).where(eq(transferenciaItems.id, it.id));
      // La fila EN MEMORIA es la que usa la reserva de abajo: se actualiza igual.
      it.cantidadPreparada = hay;
      if (patch.motivo) it.motivo = patch.motivo;
      recortes.push(
        `${prod.nombre}: quedó en ${this.fmtCant(prod.tipo, it.presentacionId, hay)} (faltó para ${this.fmtCant(prod.tipo, it.presentacionId, antes)})`,
      );
    }
    if (renglonesArmados.length) {
      await this.registrarFraccionamiento(tx, {
        origen: 'pedido', sucursalId: t.origenId, operadorId: operadorId ?? null, usuarioId,
        transferenciaId: t.id, items: renglonesArmados,
      });
    }
    return { armados, recortes };
  }

  /**
   * preparada → transito. La mercadería sale pero SIGUE SIENDO DEL ORIGEN
   * (comprometido → en_transito): si el camión se pierde, la pérdida es del
   * que despachó y el inventario total no miente. Acá se congela el costo
   * unitario de cada renglón — el remito valuado a costo tiene que decir lo
   * mismo dentro de seis meses.
   */
  private async despacharTransferencia(tx: any, t: any, items: any[], usuarioId?: number | null) {
    const provs = await tx.select().from(productoProveedores)
      .where(inArray(productoProveedores.productoId, items.map((i: any) => i.productoId)));
    for (const it of items) {
      // Viaja LO PREPARADO. Un renglón en 0 ("no había") no viaja ni se valúa.
      if (!(it.cantidadPreparada > 1e-9)) continue;
      const prod = await this.getProducto(tx, it.productoId);
      const cnKg = costoNetoEntry(formatoActivo(provs.filter((p: any) => p.productoId === it.productoId)) as any, prod.iva);
      let costo = cnKg;
      if (it.presentacionId) {
        const [pres] = await tx.select().from(presentaciones).where(eq(presentaciones.id, it.presentacionId)).limit(1);
        costo = cnKg * (pres?.tamKg ?? 1);
      }
      await tx.update(transferenciaItems).set({ costoUnitario: costo }).where(eq(transferenciaItems.id, it.id));

      await this.move(tx, { productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId }, 'comprometido', 'en_transito', it.cantidadPreparada);
      await this.mov(tx, {
        tipo: 'transferencia', productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId, signo: 0,
        cantidad: it.cantidadPreparada, unidad: this.unidadDe(prod.tipo, it.presentacionId), estadoDesde: 'comprometido', estadoHacia: 'en_transito',
        sucursalDestinoId: t.destinoId, refTransferenciaId: t.id, usuarioId: usuarioId ?? null,
        descripcion: `${t.codigo}: despacho hacia destino`,
      });
    }
  }

  /**
   * Avanza pendiente→preparada→transito. Recibir tiene su método: se cuenta.
   *
   * `desde` es la intención del botón: "preparar" significa avanzar DESDE
   * pendiente. Sin eso, el doble clic en Preparar ejecutaba dos pasos — el
   * segundo request encontraba la transferencia ya preparada y la despachaba.
   */
  /**
   * `esJefe`: DESPACHAR es de administración (25/9/2026). La pantalla ya le
   * escondía el botón al que prepara, pero el servidor lo aceptaba: el mismo
   * fraccionador preparaba, despachaba y —entrando como la otra sucursal—
   * recibía su propio pedido. Separar quién arma de quién despacha es lo que
   * hace que un faltante tenga dos firmas y no una.
   */
  async avanzarTransferencia(id: number, usuarioId?: number, desde?: string, soloSuc?: number | null, esJefe = false) {
    return this.db.transaction(async (tx) => {
      const [t] = await tx.select().from(transferencias).where(eq(transferencias.id, id)).limit(1);
      if (!t) throw new NotFoundException('Transferencia inexistente.');
      // Avanzar es preparar y despachar: sale del depósito del ORIGEN.
      this.exigirLado(t, soloSuc, 'origenId');
      if (t.estado === 'preparada' && !esJefe) {
        throw new ForbiddenException('Despachar es de administración: avisá que el pedido está listo para salir.');
      }
      if (desde && t.estado !== desde) {
        throw new BadRequestException('La transferencia cambió de estado — actualizá la pantalla.');
      }

      let siguiente: 'preparada' | 'transito';
      // Un borrador no es demanda todavía: el origen ni lo ve. Tiene que
      // enviarlo el que lo está armando.
      if (t.estado === 'borrador') throw new BadRequestException('Este pedido todavía se está armando: el que lo pide tiene que enviarlo.');
      else if (t.estado === 'pendiente') siguiente = 'preparada';
      else if (t.estado === 'preparada') siguiente = 'transito';
      else if (t.estado === 'transito') throw new BadRequestException('Está en tránsito: se cierra desde "Recibir", contando lo que llegó.');
      else throw new BadRequestException('La transferencia ya está en su estado final.');

      // Despachar exige cada lista PRESENTE confirmada: confirmar es reservar,
      // y sin reserva no hay nada que subir al camión.
      if (siguiente === 'transito') {
        const its = await tx.select().from(transferenciaItems).where(eq(transferenciaItems.transferenciaId, t.id));
        let hayEnteros = false; let hayGranel = false; let viaja = false;
        for (const it of its) {
          const prod = await this.getProducto(tx, it.productoId);
          if (this.listaDe(prod.tipo) === 'granel') hayGranel = true; else hayEnteros = true;
          if (it.cantidadPreparada > 1e-9) viaja = true;
        }
        if (!viaja) throw new BadRequestException('No hay nada preparado para despachar: todos los renglones están en 0.');
        const faltan: string[] = [];
        if (hayEnteros && !t.enterosListo) faltan.push('Enteros');
        if (hayGranel && !t.granelListo) faltan.push('Fraccionados');
        if (faltan.length) throw new BadRequestException(`Falta confirmar: ${faltan.join(' y ')}. Cada encargado confirma su lista cuando la mercadería está apartada.`);
      }

      /*
       * El RECLAMO del estado va PRIMERO y es atómico (`WHERE estado = el que
       * leí`): dos clics simultáneos leen los dos "pendiente", pero solo uno
       * gana este UPDATE — el otro afecta cero filas y corta acá, sin haber
       * tocado stock. Sin esto, la reserva corría dos veces.
       */
      const gano = await tx.update(transferencias)
        .set({ estado: siguiente })
        .where(and(eq(transferencias.id, t.id), eq(transferencias.estado, t.estado)))
        .returning({ id: transferencias.id });
      if (!gano.length) throw new BadRequestException('La transferencia cambió de estado — actualizá la pantalla.');

      // pendiente → preparada ya no toca stock: abre la fase de preparación y
      // la reserva llega recién cuando cada encargado CONFIRMA su lista.
      if (siguiente === 'transito') {
        const items = await tx.select().from(transferenciaItems).where(eq(transferenciaItems.transferenciaId, t.id));
        await this.despacharTransferencia(tx, t, items, usuarioId);
      }

      await tx.insert(transferenciaHist).values({ transferenciaId: t.id, estado: siguiente, usuarioId: usuarioId ?? null });
      return { ok: true, estado: siguiente };
    });
  }

  /**
   * transito → recibida, CONTANDO. Se acepta lo que llegó — esa es la verdad —
   * y la diferencia no desaparece: vuelve a `comprometido` en el origen atada
   * a una incidencia automática. Comprometido es adrede: es el estado sobre el
   * que ya trabaja la resolución de incidencias (aparece → liberar; si no →
   * merma/vencido/defectuoso), así que el faltante se cierra con el circuito
   * que ya existe, sin uno nuevo.
   */
  async recibirTransferencia(id: number, o: { items?: { itemId: number; cantidadRecibida: number }[]; usuarioId?: number; observaciones?: string } = {}, soloSuc?: number | null, esJefe = false) {
    return this.db.transaction(async (tx) => {
      const [t] = await tx.select().from(transferencias).where(eq(transferencias.id, id)).limit(1);
      if (!t) throw new NotFoundException('Transferencia inexistente.');
      /* Contra el DESTINO: cualquiera cerraba el remito ajeno declarando 0
       * recibido, y los kilos quedaban comprometidos en el origen atados a
       * incidencias que alguien tenía que investigar. */
      this.exigirLado(t, soloSuc, 'destinoId');
      if (t.estado !== 'transito') throw new BadRequestException('Solo se recibe lo que está en tránsito.');
      /*
       * QUIEN LO PREPARÓ NO LO RECIBE (25/9/2026). El que armó el pedido y el
       * que lo cuenta al llegar son los dos controles del envío: si son la misma
       * persona, un faltante queda firmado por el mismo que lo produjo (la
       * incidencia salía con él de responsable). "Preparó" es cualquier huella
       * suya en el ORIGEN de este pedido: pasarlo a preparación, reservar una
       * lista, fraccionar para completarlo. La administración queda afuera: es
       * la que despacha, y en un negocio chico a veces también recibe.
       */
      if (!esJefe && o.usuarioId) {
        const r: any = await tx.execute(sql`
          SELECT 1 FROM transferencia_hist
           WHERE transferencia_id = ${t.id} AND usuario_id = ${o.usuarioId} AND estado IN ('preparada', 'transito')
          UNION ALL
          SELECT 1 FROM movimientos
           WHERE ref_transferencia_id = ${t.id} AND usuario_id = ${o.usuarioId} AND sucursal_id = ${t.origenId}
          LIMIT 1`);
        if ((r.rows ?? r).length) {
          throw new ForbiddenException('Este pedido lo preparaste vos: lo tiene que recibir y contar otra persona.');
        }
      }
      // Mismo reclamo atómico que en avanzar: dos recepciones simultáneas del
      // mismo remito duplicarían el ingreso al destino.
      const gano = await tx.update(transferencias)
        .set({ estado: 'recibida' })
        .where(and(eq(transferencias.id, t.id), eq(transferencias.estado, 'transito')))
        .returning({ id: transferencias.id });
      if (!gano.length) throw new BadRequestException('La transferencia cambió de estado — actualizá la pantalla.');
      const items = await tx.select().from(transferenciaItems).where(eq(transferenciaItems.transferenciaId, t.id));
      const [origen] = await tx.select().from(sucursales).where(eq(sucursales.id, t.origenId)).limit(1);
      const [destino] = await tx.select().from(sucursales).where(eq(sucursales.id, t.destinoId)).limit(1);
      const contado = new Map((o.items ?? []).map((x) => [Number(x.itemId), Number(x.cantidadRecibida)]));
      /*
       * SE CUENTA TODO LO QUE VIAJÓ (25/9/2026). Un renglón que no venía en el
       * conteo se tomaba como recibido COMPLETO: alcanzaba con no mandarlo para
       * dar por llegado algo que nadie contó. Ahora cada renglón que subió al
       * camión tiene que traer su número. La administración puede cerrar sin
       * conteo ("llegó todo", `items` ausente): es la que despacha.
       */
      if (!(esJefe && o.items == null)) {
        const sinContar = items.filter((it: any) => it.cantidadPreparada > 1e-9 && !contado.has(it.id));
        if (sinContar.length) {
          const nombres = await this.productosDe(tx, [...new Set(sinContar.map((it: any) => it.productoId as number))]);
          throw new BadRequestException(
            `Falta contar ${sinContar.length === 1 ? 'un renglón' : `${sinContar.length} renglones`}: ${sinContar.slice(0, 3).map((it: any) => nombres.get(it.productoId)?.nombre ?? `#${it.productoId}`).join(', ')}${sinContar.length > 3 ? '…' : ''}.`,
          );
        }
      }

      const incidenciasCreadas: string[] = [];
      for (const it of items) {
        // Se recibe contra LO PREPARADO (lo que de verdad viajó). Un renglón
        // en 0 no subió al camión: se cierra en 0 sin tocar stock.
        const enviado = it.cantidadPreparada;
        if (!(enviado > 1e-9)) {
          await tx.update(transferenciaItems).set({ cantidadRecibida: 0 }).where(eq(transferenciaItems.id, it.id));
          continue;
        }
        const prod = await this.getProducto(tx, it.productoId);
        const unidad = this.unidadDe(prod.tipo, it.presentacionId);
        if (contado.has(it.id)) this.exigirEntero(prod, it.presentacionId, contado.get(it.id)!);
        // Sin conteo explícito (solo la administración) se asume completo; jamás más de lo enviado.
        const rec = Math.min(Math.max(contado.get(it.id) ?? enviado, 0), enviado);
        const faltante = enviado - rec;
        await tx.update(transferenciaItems).set({ cantidadRecibida: rec }).where(eq(transferenciaItems.id, it.id));

        if (rec > 1e-9) {
          /*
           * Lo recibido: sale del origen (en_transito) y entra al destino.
           *
           * EL EGRESO SE VERIFICA ANTES. `addDelta` resta sin piso, así que si
           * el tránsito no tenía esas unidades —porque la reserva o el despacho
           * fallaron antes en silencio— el origen quedaba en NEGATIVO y el
           * destino sumaba igual: un agujero de un lado y stock inventado del
           * otro, con los movimientos diciendo que todo salió bien. Estamos
           * dentro de la transacción, así que el throw revierte la recepción
           * entera: nadie firma un remito que no ocurrió.
           */
          const enTransito = await this.cant(tx, it.productoId, t.origenId, it.presentacionId, 'en_transito');
          if (enTransito + 1e-9 < rec) {
            throw new BadRequestException(
              `${t.codigo}: ${prod.nombre} figura con ${this.fmtCant(prod.tipo, it.presentacionId, enTransito)} en tránsito `
              + `y se están recibiendo ${this.fmtCant(prod.tipo, it.presentacionId, rec)}. `
              + 'El remito quedó inconsistente: revisalo antes de recibirlo.',
            );
          }
          await this.addDelta(tx, { productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId, estado: 'en_transito' }, -rec);
          await this.mov(tx, {
            tipo: 'transferencia', productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId, signo: -1,
            cantidad: rec, unidad, estadoDesde: 'en_transito', sucursalDestinoId: t.destinoId, refTransferenciaId: t.id,
            usuarioId: o.usuarioId ?? null, descripcion: `${t.codigo}: entregado a ${destino?.nombre}`,
          });
          await this.addDelta(tx, { productoId: it.productoId, sucursalId: t.destinoId, presentacionId: it.presentacionId, estado: 'disponible' }, rec);
          await this.mov(tx, {
            tipo: 'transferencia', productoId: it.productoId, sucursalId: t.destinoId, presentacionId: it.presentacionId, signo: 1,
            cantidad: rec, unidad, estadoHacia: 'disponible', refTransferenciaId: t.id,
            usuarioId: o.usuarioId ?? null, descripcion: `${t.codigo}: recepción desde ${origen?.nombre}`,
          });
        }

        if (faltante > 1e-9) {
          // La diferencia no se pierde: queda retenida en el origen con una
          // incidencia que ALGUIEN tiene que cerrar.
          await this.move(tx, { productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId }, 'en_transito', 'comprometido', faltante);
          const [inc] = await tx.insert(incidencias).values({
            codigo: '', tipo: 'faltante', estado: 'pendiente', responsableId: o.usuarioId ?? null,
            motivo: `${t.codigo} ${origen?.nombre} → ${destino?.nombre}: se enviaron ${this.fmtCant(prod.tipo, it.presentacionId, enviado)} de ${prod.nombre} y llegaron ${this.fmtCant(prod.tipo, it.presentacionId, rec)}.`,
            productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId,
            cantidad: faltante, unidad,
          }).returning();
          const codigoInc = 'INC' + String(inc.id).padStart(4, '0');
          await tx.update(incidencias).set({ codigo: codigoInc }).where(eq(incidencias.id, inc.id));
          incidenciasCreadas.push(codigoInc);
          await this.mov(tx, {
            tipo: 'ajuste', productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId, signo: 0,
            cantidad: faltante, unidad, estadoDesde: 'en_transito', estadoHacia: 'comprometido',
            refTransferenciaId: t.id, refIncidenciaId: inc.id, usuarioId: o.usuarioId ?? null,
            descripcion: `${t.codigo}: faltante en recepción → ${codigoInc}`,
          });
        }
      }

      // El estado ya se reclamó arriba; acá solo se suman las notas del receptor.
      const obs = (o.observaciones ?? '').trim();
      if (obs) {
        await tx.update(transferencias)
          .set({ observaciones: t.observaciones ? `${t.observaciones} · ${obs}` : obs })
          .where(eq(transferencias.id, t.id));
      }
      await tx.insert(transferenciaHist).values({ transferenciaId: t.id, estado: 'recibida', usuarioId: o.usuarioId ?? null });
      return { ok: true, estado: 'recibida', incidencias: incidenciasCreadas };
    });
  }

  /** `esJefe`: cancelar es de administración, como en la pantalla (ver `avanzarTransferencia`). */
  async cancelarTransferencia(id: number, usuarioId?: number, soloSuc?: number | null, esJefe = false) {
    if (!esJefe) throw new ForbiddenException('Cancelar un pedido es de administración.');
    return this.db.transaction(async (tx) => {
      const [t] = await tx.select().from(transferencias).where(eq(transferencias.id, id)).limit(1);
      if (!t) throw new NotFoundException('Transferencia inexistente.');
      // Cancelar libera la reserva del ORIGEN: es de quien la preparó.
      this.exigirLado(t, soloSuc, 'origenId');
      // El borrador no se cancela: se descarta y se borra (nunca fue documento).
      if (t.estado === 'borrador') throw new BadRequestException('Este pedido todavía se está armando: se descarta, no se cancela.');
      if (t.estado !== 'pendiente' && t.estado !== 'preparada') throw new BadRequestException('Solo se cancelan transferencias pendientes o preparadas.');
      // Reclamo atómico: si en el medio la prepararon o despacharon, no se
      // puede cancelar con la foto vieja.
      const gano = await tx.update(transferencias)
        .set({ estado: 'cancelada' })
        .where(and(eq(transferencias.id, t.id), eq(transferencias.estado, t.estado)))
        .returning({ id: transferencias.id });
      if (!gano.length) throw new BadRequestException('La transferencia cambió de estado — actualizá la pantalla.');
      const items = await tx.select().from(transferenciaItems).where(eq(transferenciaItems.transferenciaId, t.id));
      // El pedido (pendiente) nunca tocó stock. En preparación, la reserva
      // existe SOLO en las listas confirmadas: se libera exactamente eso.
      if (t.estado === 'preparada') {
        for (const it of items) {
          if (!(it.cantidadPreparada > 1e-9)) continue;
          const prod = await this.getProducto(tx, it.productoId);
          const confirmada = this.listaDe(prod.tipo) === 'granel' ? t.granelListo : t.enterosListo;
          if (!confirmada) continue;
          await this.move(tx, { productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId }, 'comprometido', 'disponible', it.cantidadPreparada);
          await this.mov(tx, {
            tipo: 'transferencia', productoId: it.productoId, sucursalId: t.origenId, presentacionId: it.presentacionId, signo: 0,
            cantidad: it.cantidadPreparada, unidad: this.unidadDe(prod.tipo, it.presentacionId), estadoDesde: 'comprometido', estadoHacia: 'disponible',
            // Quién canceló. Liberar una reserva le devuelve a la góndola algo
            // que otro había apartado: sin autor, el movimiento era anónimo.
            usuarioId: usuarioId ?? null,
            refTransferenciaId: t.id, descripcion: `${t.codigo}: cancelada, stock liberado`,
          });
        }
      }
      // Con quién: la cancelación no decía quién la hizo.
      await tx.insert(transferenciaHist).values({ transferenciaId: t.id, estado: 'cancelada', usuarioId: usuarioId ?? null });
      return { ok: true };
    });
  }

  /* ============================ INCIDENCIAS ============================ */
  async crearIncidencia(o: any, autorId?: number) {
    return this.db.transaction(async (tx) => {
      const prod = await this.getProducto(tx, o.productoId);
      if (!prod) throw new BadRequestException('Producto inválido.');
      const presId = o.presId || null;
      const sucId = o.sucursalId;
      const c = Number(o.cantidad);
      if (!(c > 0)) throw new BadRequestException('Ingresá la cantidad comprometida.');
      const disp = await this.cant(tx, prod.id, sucId, presId, 'disponible');
      if (c > disp + 1e-9) throw new BadRequestException(`No hay tanto stock disponible. Disponible: ${this.fmtCant(prod.tipo, presId, disp)}.`);
      await this.move(tx, { productoId: prod.id, sucursalId: sucId, presentacionId: presId }, 'disponible', 'comprometido', c);
      const [inc] = await tx.insert(incidencias).values({
        codigo: '', tipo: o.tipo, estado: 'pendiente', responsableId: o.responsableId ?? null, motivo: o.motivo || '',
        productoId: prod.id, sucursalId: sucId, presentacionId: presId, cantidad: c, unidad: this.unidadDe(prod.tipo, presId),
      }).returning();
      const codigo = 'INC' + String(inc.id).padStart(4, '0');
      await tx.update(incidencias).set({ codigo }).where(eq(incidencias.id, inc.id));
      await this.mov(tx, {
        tipo: 'ajuste', productoId: prod.id, sucursalId: sucId, presentacionId: presId, signo: 0, cantidad: c,
        unidad: this.unidadDe(prod.tipo, presId), estadoDesde: 'disponible', estadoHacia: 'comprometido',
        /*
         * EL AUTOR DEL MOVIMIENTO ES QUIEN LO HIZO, no el "responsable".
         *
         * Acá decía `o.responsableId`, que lo elige el cliente de un desplegable
         * con todos los usuarios: se cargaba una incidencia por 40 kg "a nombre
         * de Marta" y, cuando alguien la resolviera como merma, la pérdida
         * figuraba contra ella. El login promete en pantalla que lo que hacés
         * queda registrado a tu nombre.
         *
         * `responsableId` sigue existiendo en la incidencia porque es OTRO dato
         * —a quién se le atribuye el faltante— y son cosas distintas: uno cargó
         * el papel, al otro se lo están imputando.
         */
        refIncidenciaId: inc.id, usuarioId: autorId ?? null, descripcion: `${codigo} (${o.tipo}): ${this.fmtCant(prod.tipo, presId, c)} a comprometido`,
      });
      return { ok: true, id: inc.id, codigo };
    });
  }

  async avanzarIncidencia(id: number, soloSuc?: number | null) {
    const [inc] = await this.db.select().from(incidencias).where(eq(incidencias.id, id)).limit(1);
    if (!inc) throw new NotFoundException('Incidencia inexistente.');
    if (soloSuc != null && inc.sucursalId !== soloSuc) {
      throw new ForbiddenException('Esa incidencia es de otra sucursal.');
    }
    // Reclamo condicional, igual que el resto del módulo: sin él, dos clics
    // pisaban el estado y el `if` de arriba miraba una foto vieja.
    const gano = await this.db.update(incidencias).set({ estado: 'revision' })
      .where(and(eq(incidencias.id, id), eq(incidencias.estado, 'pendiente')))
      .returning({ id: incidencias.id });
    if (!gano.length) throw new BadRequestException("Usá 'Resolver' para cerrar la incidencia.");
    return { ok: true };
  }

  async resolverIncidencia(id: number, resolucion: string, autorId?: number, soloSuc?: number | null, contado?: number) {
    return this.db.transaction(async (tx) => {
      /*
       * LA ÚNICA TRANSICIÓN DEL MÓDULO QUE NO RECLAMABA SU ESTADO, y con eso
       * INVENTABA UNIDADES.
       *
       * Todo el resto de Almacén usa `FOR UPDATE` o un `WHERE estado = <el que
       * leí>`; acá se leía la fila suelta, se movía el stock y recién después se
       * marcaba 'resuelta'. Un doble clic con la base cargada: las dos
       * ejecuciones leen `comprometido = 10`, las dos pasan el chequeo, y las dos
       * aplican el delta RELATIVO — `comprometido = 10 − 10 − 10 = −10` y
       * `disponible = +20`. Diez unidades de la nada. Con `merma`, la pérdida se
       * asienta dos veces en el reporte.
       *
       * El candado va en dos capas y las dos hacen falta: `FOR UPDATE` serializa
       * a la segunda hasta que la primera termina, y el reclamo condicional de
       * abajo hace que esa segunda encuentre el estado ya cambiado.
       */
      const [inc] = await tx.select().from(incidencias)
        .where(eq(incidencias.id, id)).limit(1).for('update');
      if (!inc) throw new NotFoundException('Incidencia inexistente.');
      if (soloSuc != null && inc.sucursalId !== soloSuc) {
        throw new ForbiddenException('Esa incidencia es de otra sucursal.');
      }
      if (inc.estado === 'resuelta') throw new BadRequestException('La incidencia ya está resuelta.');
      const reclamada = await tx.update(incidencias)
        .set({ estado: 'resuelta' })
        .where(and(eq(incidencias.id, id), ne(incidencias.estado, 'resuelta')))
        .returning({ id: incidencias.id });
      if (!reclamada.length) throw new BadRequestException('La incidencia ya está resuelta.');
      const prod = await this.getProducto(tx, inc.productoId);
      /*
       * LA VENTA SIN STOCK SE CIERRA DISTINTO (0096), y esto no es un detalle.
       *
       * Todo lo de abajo está construido sobre mercadería RETENIDA en
       * `comprometido`: descuenta de ahí y la libera o la da de baja. Una venta
       * sin stock no retuvo nada —la mercadería ya salió por la puerta—, así
       * que por ese camino o rebota con "el stock comprometido cambió", o peor,
       * inventa unidades que no existen. Va por el suyo.
       */
      if (inc.tipo === InventarioService.TIPO_VENTA_SIN_STOCK) {
        return this.cerrarVentaSinStock(tx, inc, prod, resolucion, contado, autorId);
      }
      const c = inc.cantidad;
      const comprom = await this.cant(tx, prod.id, inc.sucursalId, inc.presentacionId, 'comprometido');
      if (c > comprom + 1e-9) throw new BadRequestException('El stock comprometido cambió; revisá manualmente.');
      await this.addDelta(tx, { productoId: prod.id, sucursalId: inc.sucursalId, presentacionId: inc.presentacionId, estado: 'comprometido' }, -c);
      let tipoMov = 'ajuste';
      let estadoHacia: EstadoStock | null = null;
      if (resolucion === 'liberar') { await this.addDelta(tx, { productoId: prod.id, sucursalId: inc.sucursalId, presentacionId: inc.presentacionId, estado: 'disponible' }, c); estadoHacia = 'disponible'; }
      else if (resolucion === 'merma') { tipoMov = 'merma'; }
      else if (resolucion === 'vencido') { tipoMov = 'vencido'; await this.addDelta(tx, { productoId: prod.id, sucursalId: inc.sucursalId, presentacionId: inc.presentacionId, estado: 'vencido' }, c); estadoHacia = 'vencido'; }
      else if (resolucion === 'defectuoso') { tipoMov = 'defectuoso'; await this.addDelta(tx, { productoId: prod.id, sucursalId: inc.sucursalId, presentacionId: inc.presentacionId, estado: 'defectuoso' }, c); estadoHacia = 'defectuoso'; }
      else throw new BadRequestException('Resolución inválida.');
      // El estado ya se reclamó al entrar; acá van los datos de la resolución.
      await tx.update(incidencias).set({ resolucion, fechaResolucion: new Date(), activa: false }).where(eq(incidencias.id, id));
      /*
       * La baja por incidencia es una pérdida como cualquier otra: congela su
       * costo (si no, figuraba en $0 en el reporte de pérdidas de Vencimientos,
       * que lista los movimientos de estos tres tipos) y dice DE DÓNDE vino en
       * el `motivo` — la pantalla de Mermas muestra ese campo, y sin él la fila
       * aparecía como una merma anónima aunque el vínculo estuviera guardado.
       */
      const esPerdida = resolucion !== 'liberar';
      await this.mov(tx, {
        tipo: tipoMov, productoId: prod.id, sucursalId: inc.sucursalId, presentacionId: inc.presentacionId,
        signo: resolucion === 'liberar' ? 0 : -1, cantidad: c, unidad: inc.unidad, estadoDesde: 'comprometido', estadoHacia,
        costoUnitario: esPerdida ? await this.costoDePerdida(tx, prod, inc.presentacionId) : 0,
        motivo: `Incidencia ${inc.codigo} · ${inc.tipo}`,
        /* QUIÉN LA RESOLVIÓ. Es el movimiento que convierte mercadería en
         * pérdida —figura en el reporte de Vencimientos con su costo— y era el
         * único de esa familia sin firma. */
        usuarioId: autorId ?? null,
        refIncidenciaId: inc.id, descripcion: `${inc.codigo} resuelta: ${resolucion === 'liberar' ? 'liberado a disponible' : 'baja por ' + resolucion}`,
      });
      return { ok: true };
    });
  }

  /**
   * CERRAR UNA VENTA SIN STOCK (0096). Dos salidas, y ninguna toca
   * `comprometido` porque acá nunca hubo nada retenido:
   *
   *   · `ajustado` — se contó la góndola. Se pone el stock EN LO CONTADO, no
   *     se le suma lo que faltaba: entre la venta y este momento pudo entrar
   *     mercadería, y sumar a ciegas dejaría el número peor que antes. El
   *     delta sale contra lo que hay AHORA, leído adentro de la transacción.
   *   · `error_carga` — el negativo era de otra cosa (el producto estaba
   *     cargado dos veces, la compra no se había asentado). Cierra sin tocar
   *     un solo peso de stock, con el motivo escrito.
   */
  private async cerrarVentaSinStock(
    tx: any, inc: any, prod: any, resolucion: string, contado?: number, autorId?: number,
  ) {
    if (resolucion !== 'ajustado' && resolucion !== 'error_carga') {
      throw new BadRequestException('Resolución inválida para una venta sin stock.');
    }
    const cerrar = (extra: string) => tx.update(incidencias).set({
      resolucion, fechaResolucion: new Date(), activa: false,
      motivo: `${inc.motivo} · ${extra}`,
    }).where(eq(incidencias.id, inc.id));

    if (resolucion === 'error_carga') {
      await cerrar('Cerrada sin tocar stock: el negativo no era de la góndola.');
      return { ok: true, ajuste: 0 };
    }

    const n = Number(contado);
    if (!Number.isFinite(n) || n < 0) {
      throw new BadRequestException('Poné cuántas unidades contaste en la góndola (0 o más).');
    }
    const objetivo = this.cant3(n);
    const actual = await this.cant(tx, prod.id, inc.sucursalId, inc.presentacionId, 'disponible');
    const delta = this.cant3(objetivo - actual);
    if (Math.abs(delta) > 1e-9) {
      await this.addDelta(tx, {
        productoId: prod.id, sucursalId: inc.sucursalId, presentacionId: inc.presentacionId, estado: 'disponible',
      }, delta);
      /* UN movimiento de ajuste, con su firma y el vínculo a la incidencia: es
       * lo que hace que el número corregido se pueda explicar dentro de un mes. */
      await this.mov(tx, {
        tipo: 'ajuste', productoId: prod.id, sucursalId: inc.sucursalId, presentacionId: inc.presentacionId,
        signo: delta > 0 ? 1 : -1, cantidad: Math.abs(delta), unidad: inc.unidad,
        estadoDesde: 'disponible', estadoHacia: 'disponible',
        motivo: `Incidencia ${inc.codigo} · venta sin stock`,
        usuarioId: autorId ?? null, refIncidenciaId: inc.id,
        descripcion: `${inc.codigo} resuelta: contado ${this.fmtCant(prod.tipo, inc.presentacionId, objetivo)} `
          + `(el sistema tenía ${this.fmtCant(prod.tipo, inc.presentacionId, actual)})`,
      });
    }
    await cerrar(
      `Contado ${this.fmtCant(prod.tipo, inc.presentacionId, objetivo)} contra `
      + `${this.fmtCant(prod.tipo, inc.presentacionId, actual)} del sistema: ajuste de ${this.cant3(delta)}.`,
    );
    return { ok: true, ajuste: delta };
  }

  /**
   * LAS INCIDENCIAS QUE VIAJAN A LA PANTALLA (0096).
   *
   * TODAS las abiertas —son las que hay que cerrar, y las que cuenta el badge
   * del menú— más las últimas `TOPE_INCIDENCIAS_RESUELTAS` cerradas, como
   * historia reciente. Antes iban todas, sin techo, y esta lista viaja en la
   * foto del inventario que abre Almacén y Compras: con las ventas sin stock
   * pasando a ser cosa de todos los días, eso se volvía más lento cada mes.
   *
   * Dos consultas cortas y las dos por índice (`ix_incidencias_estado`), en
   * paralelo. La historia completa sigue en la base y en los reportes.
   */
  private async incidenciasVigentes(soloSuc?: number | null) {
    const deSucursal = soloSuc != null ? eq(incidencias.sucursalId, soloSuc) : undefined;
    /*
     * El COMPROBANTE viaja resuelto, no el id pelado: la pantalla de Almacén no
     * tiene las ventas en memoria (crecen sin techo y por eso no están en la
     * foto), así que sin esto el "¿de qué venta salió?" obligaría a una consulta
     * por fila. Es un LEFT JOIN por clave foránea indexada sobre un conjunto que
     * ya está acotado — y `null` cuando la incidencia no es de una venta.
     */
    const columnas = {
      ...getTableColumns(incidencias),
      comprobante: sql<string>`case when ${ventas.id} is null then ''
        else ${ventas.puntoVenta} || '-' || lpad(${ventas.numero}::text, 8, '0') end`,
      ventaTipo: sql<string>`coalesce(${ventas.tipo}::text, '')`,
      ventaEstado: sql<string>`coalesce(${ventas.estado}::text, '')`,
      clienteNombre: sql<string>`coalesce(${clientes.nombre}, '')`,
    };
    const base = () => this.db.select(columnas).from(incidencias)
      .leftJoin(ventas, eq(ventas.id, incidencias.ventaId))
      .leftJoin(clientes, eq(clientes.id, ventas.clienteId));
    const [abiertas, resueltas] = await Promise.all([
      base().where(and(ne(incidencias.estado, 'resuelta'), deSucursal)).orderBy(desc(incidencias.id)),
      base().where(and(eq(incidencias.estado, 'resuelta'), deSucursal))
        .orderBy(desc(incidencias.id))
        .limit(InventarioService.TOPE_INCIDENCIAS_RESUELTAS),
    ]);
    return [...abiertas, ...resueltas].sort((a, b) => b.id - a.id);
  }

  /**
   * OPERACIONES DE UN ALMACÉN — el "libro" del legacy: una fila por DOCUMENTO
   * (no por renglón), valuada a costo, en un rango de fechas.
   *
   * Tres fuentes, un solo formato de fila:
   *   · transferencias: una fila por LADO — el mismo remito es "enviado" para
   *     el origen y "recibido" para el destino, con la fecha de SU evento
   *     (despacho o recepción). Valuadas al costo CONGELADO al despachar.
   *   · comprobantes de compra con recepción en esa sucursal (costo real).
   *   · movimientos sueltos (ajuste, merma, vencido, defectuoso): cada uno es
   *     una operación de por sí. Sin valuar: no congelan costo, y valuarlos a
   *     costo de HOY sería inventar un número histórico.
   *
   * El rango de fechas acota el volumen; los filtros finos (tipo, con
   * observación) los aplica la pantalla en memoria.
   */
  async operacionesAlmacen(q: { sucursalId: number; desde?: string; hasta?: string; limit?: number }) {
    const sucId = Number(q.sucursalId);
    if (!sucId) throw new BadRequestException('Indicá la sucursal.');
    /* `fechaLocal` y no `new Date(q.desde)`: '2026-08-13' pelado es medianoche
     * UTC, o sea las 21 h del 12 en Formosa, así que el libro del almacén
     * arrancaba TRES HORAS ANTES del día pedido y se comía los movimientos de
     * la noche anterior. El `hasta` de al lado ya lo hacía bien — eran dos
     * criterios en dos líneas consecutivas. */
    const desde = fechaLocal(q.desde) ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const hasta = q.hasta ? new Date(`${q.hasta}T23:59:59`) : new Date();
    const limit = Math.min(Math.max(Number(q.limit) || 300, 1), 1000);

    /*
     * Los remitos de ESTA sucursal salen primero, y sus hijos se piden POR ESOS
     * IDS. Antes las dos consultas de abajo eran `select().from(...)` PELADO:
     * el libro de un mes de un local se traía la tabla ENTERA de renglones y la
     * tabla ENTERA de historial de todas las sucursales, para después tirar el
     * 90% con un `filter` en memoria. Es la misma trampa que `listTransferencias`
     * ya documenta y resuelve así; acá había quedado sin arreglar, y encima el
     * `filter` corre DENTRO del bucle: una pasada por la tabla completa por cada
     * remito, y tres por cada uno que tenga historial.
     */
    const ts = await this.db.select().from(transferencias)
      .where(or(eq(transferencias.origenId, sucId), eq(transferencias.destinoId, sucId)));
    const tIds = ts.map((t) => t.id);

    const [tItems, tHist, comps, movs, sucs, usrs, prods] = await Promise.all([
      tIds.length
        ? this.db.select().from(transferenciaItems).where(inArray(transferenciaItems.transferenciaId, tIds))
        : Promise.resolve([] as any[]),
      tIds.length
        ? this.db.select().from(transferenciaHist).where(inArray(transferenciaHist.transferenciaId, tIds))
        : Promise.resolve([] as any[]),
      this.db.select().from(comprobantes)
        .where(and(eq(comprobantes.sucursalId, sucId), eq(comprobantes.recepcion, true),
          gte(comprobantes.fechaCarga, desde), lte(comprobantes.fechaCarga, hasta))),
      this.db.select().from(movimientos)
        .where(and(eq(movimientos.sucursalId, sucId),
          inArray(movimientos.tipo, ['ajuste', 'merma', 'vencido', 'defectuoso'] as any),
          gte(movimientos.fecha, desde), lte(movimientos.fecha, hasta))),
      this.db.select().from(sucursales),
      this.db.select({ id: usuarios.id, nombre: usuarios.nombre, activo: usuarios.activo, rolId: usuarios.rolId }).from(usuarios),
      this.db.select({ id: productos.id, nombre: productos.nombre }).from(productos),
    ]);
    const nomSuc = new Map(sucs.map((s) => [s.id, s.nombre]));
    const nomUsr = new Map(usrs.map((u) => [u.id, u.nombre]));
    const nomProd = new Map(prods.map((p) => [p.id, p.nombre]));

    const filas: any[] = [];

    /** Fecha en la que la transferencia entró a un estado (del historial). */
    const fechaEstado = (tId: number, estado: string) =>
      tHist.filter((h) => h.transferenciaId === tId && h.estado === estado).map((h) => h.fecha).pop() ?? null;
    const usuarioEstado = (tId: number, estado: string) =>
      tHist.filter((h) => h.transferenciaId === tId && h.estado === estado).map((h) => h.usuarioId).pop() ?? null;

    for (const t of ts) {
      const items = tItems.filter((i) => i.transferenciaId === t.id);
      // Lado ORIGEN: la operación es el despacho, valuada a lo ENVIADO.
      if (t.origenId === sucId && (t.estado === 'transito' || t.estado === 'recibida')) {
        const f = fechaEstado(t.id, 'transito');
        if (f && f >= desde && f <= hasta) {
          filas.push({
            id: `t${t.id}-env`, tipo: 'transferencia_enviada', codigo: t.codigo, fecha: f, fechaCarga: t.fecha,
            concepto: `Envío a ${nomSuc.get(t.destinoId) ?? '—'}`,
            /*
             * Se valúa LO PREPARADO, que es lo que subió al camión y lo único
             * que tiene costo congelado (`despacharTransferencia` saltea los
             * renglones en 0). Acá decía `i.cantidad` —lo PEDIDO— y el libro no
             * coincidía ni con el detalle del remito (que ya usaba lo preparado)
             * ni con su propio comentario, en las dos direcciones: un renglón
             * agregado durante la preparación tiene `cantidad = 0`, así que
             * mercadería que salió del depósito figuraba en $0; y un renglón
             * corto (pidieron 20, había 14) se valuaba por 20.
             */
            monto: items.reduce((a, i) => a + i.cantidadPreparada * i.costoUnitario, 0),
            observaciones: t.observaciones, usuario: nomUsr.get(usuarioEstado(t.id, 'transito') as number) ?? nomUsr.get(t.usuarioId as number) ?? '',
            refTransferenciaId: t.id,
          });
        }
      }
      // Lado DESTINO: la operación es la recepción, valuada a lo RECIBIDO.
      if (t.destinoId === sucId && t.estado === 'recibida') {
        const f = fechaEstado(t.id, 'recibida');
        if (f && f >= desde && f <= hasta) {
          filas.push({
            id: `t${t.id}-rec`, tipo: 'transferencia_recibida', codigo: t.codigo, fecha: f, fechaCarga: t.fecha,
            concepto: `Recepción desde ${nomSuc.get(t.origenId) ?? '—'}`,
            // Lo CONTADO al recibir; si no se contó, lo que viajó (nunca lo pedido).
            monto: items.reduce((a, i) => a + (i.cantidadRecibida ?? i.cantidadPreparada) * i.costoUnitario, 0),
            observaciones: t.observaciones, usuario: nomUsr.get(usuarioEstado(t.id, 'recibida') as number) ?? '',
            refTransferenciaId: t.id,
          });
        }
      }
    }

    for (const c of comps) {
      filas.push({
        /* LISTA DE TIPOS · la etiqueta del libro de Operaciones. Antes era
         * `remito ? 'REM' : 'FC'`, así que una LIQUIDACIÓN aparecía como "FC",
         * idéntica a una factura de compra — y todo el diseño del tipo no fiscal
         * se apoya en que se distinga en cualquier pantalla donde aparezca. */
        id: `c${c.id}`, tipo: 'compra_recibida', codigo: `${ABREV_LIBRO[c.tipo] ?? 'FC'} ${c.puntoVenta}-${String(c.numero ?? 0).padStart(8, '0')}`,
        fecha: c.fecha, fechaCarga: c.fechaCarga, concepto: 'Recepción de compra',
        monto: c.subtotalNeto, observaciones: c.observaciones,
        usuario: nomUsr.get(c.usuarioId as number) ?? '', refComprobanteId: c.id,
      });
    }

    for (const m of movs) {
      filas.push({
        id: `m${m.id}`, tipo: m.tipo, codigo: `MOV${m.id}`, fecha: m.fecha, fechaCarga: m.fecha,
        concepto: `${nomProd.get(m.productoId as number) ?? '—'}: ${m.descripcion || m.tipo}`,
        monto: null, observaciones: m.motivo ?? '', usuario: nomUsr.get(m.usuarioId as number) ?? '',
        cantidad: m.cantidad, unidad: m.unidad,
      });
    }

    filas.sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime());
    return filas.slice(0, limit);
  }

  /* ============================ LECTURAS ============================ */
  /**
   * Las existencias. `soloSuc` = null para el jefe; para el resto, SU sucursal.
   * Sin el filtro, cualquier sesion se llevaba el stock completo de los cinco
   * locales, que es la foto del negocio entero.
   */
  async existencias(soloSuc?: number | null) {
    const rows = await this.db.select().from(stock)
      .where(soloSuc != null ? eq(stock.sucursalId, soloSuc) : undefined);
    return rows.filter((r) => r.cantidad > 1e-9);
  }

  /**
   * Historial paginado. Ya no viaja en el bootstrap, así que el panel lo pide
   * con sus filtros y un techo duro: la tabla crece para siempre.
   */
  async listMovimientos(q: {
    productoId?: number; sucursalId?: number; tipo?: string;
    desde?: string; hasta?: string; limit?: number;
  } = {}) {
    const conds: any[] = [];
    if (q.productoId) conds.push(eq(movimientos.productoId, Number(q.productoId)));
    if (q.sucursalId) conds.push(eq(movimientos.sucursalId, Number(q.sucursalId)));
    if (q.tipo) conds.push(eq(movimientos.tipo, q.tipo as any));
    /* Mismo criterio que el libro del almacén: `fechaLocal` para el desde (un
     * '2026-08-13' pelado es las 21 h del 12 en Formosa) y fin de día para el
     * hasta — un rango de UN día tiene que traer ese día completo. */
    const desde = fechaLocal(q.desde);
    if (desde) conds.push(gte(movimientos.fecha, desde));
    if (q.hasta) conds.push(lte(movimientos.fecha, new Date(`${q.hasta}T23:59:59`)));
    const limit = Math.min(Math.max(Number(q.limit) || 300, 1), 1000);
    return this.db.select().from(movimientos)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(movimientos.id))
      .limit(limit);
  }

  /**
   * Los remitos. El que no es jefe ve los que SALEN o LLEGAN a su sucursal: en
   * una red pull las dos puntas le interesan, pero los de terceros no. De paso
   * deja de exponer los ids de los borradores ajenos, que era como se llegaba a
   * ellos para vaciarlos.
   */
  async listTransferencias(soloSuc?: number | null) {
    const ts = await this.db.select().from(transferencias)
      .where(soloSuc != null
        ? or(eq(transferencias.origenId, soloSuc), eq(transferencias.destinoId, soloSuc))
        : undefined)
      .orderBy(desc(transferencias.id))
      /*
       * TECHO. Un remito viejo no se opera: se mira en el historial, que tiene
       * su propia pantalla con filtros. Sin límite, esto se traía TODAS las
       * transferencias con TODOS sus renglones y TODO su historial —tres
       * consultas sin `where`— en cada bootstrap y después de cada mutación. Hoy
       * son decenas de filas; en dos años son decenas de miles, y la pantalla se
       * cae sola sin que nadie haya hecho nada raro.
       */
      .limit(300);
    if (!ts.length) return [];
    // Y los hijos SOLO de los que se devuelven, no las tablas enteras.
    const ids = ts.map((t) => t.id);
    const [items, hist] = await Promise.all([
      this.db.select().from(transferenciaItems).where(inArray(transferenciaItems.transferenciaId, ids)),
      this.db.select().from(transferenciaHist).where(inArray(transferenciaHist.transferenciaId, ids)),
    ]);
    return ts.map((t) => ({
      ...t,
      items: items.filter((i) => i.transferenciaId === t.id),
      hist: hist.filter((h) => h.transferenciaId === t.id),
    }));
  }

  async listIncidencias(soloSuc?: number | null) {
    return this.incidenciasVigentes(soloSuc);
  }

  /**
   * Snapshot del inventario: **solo lo que tiene techo**.
   *
   * Catálogo (productos, proveedores, sucursales, usuarios), existencias,
   * transferencias e incidencias crecen con la operación pero acotadas.
   * `movimientos` y `comprobantes` NO están: crecen sin techo y esta llamada
   * corre al abrir Compras/Almacén y después de cada mutación — meterlos acá
   * hacía que el sistema se pusiera más lento cada mes que pasa. Se piden
   * paginados desde el panel que los muestra (`/movimientos`, `/comprobantes`).
   */
  /**
   * Usuarios como los ve el frontend: SIN hash de contraseña y con el rol
   * dinámico resuelto (clave, nombre y permisos) — de acá sale can().
   */
  private usuariosPublicos(usr: any[], rs: any[]) {
    const rolDe = new Map(rs.map((r: any) => [r.id, r]));
    return usr.map((u) => {
      const r = rolDe.get(u.rolId);
      return {
        id: u.id, nombre: u.nombre, activo: u.activo, rolId: u.rolId,
        rolClave: r?.clave ?? '', rolNombre: r?.nombre ?? '',
        permisos: conPermisosBase(r?.permisos, r?.clave ?? ''),
      };
    });
  }

  /* ==================================================================== *
   * El snapshot del inventario, EN TRES PARTES
   * ==================================================================== *
   * Compras y Almacén arrancan bajando el inventario entero, y hasta el 17/9
   * lo volvían a bajar entero después de casi cada cambio. Con 2.700
   * productos eso son 10 MB por viaje —8 de productos con sus precios, 3 de
   * stock— y era lo que se cortaba a mitad de camino en el mostrador.
   *
   * Se parte por VELOCIDAD DE CAMBIO, que es lo que decide qué vale la pena
   * volver a bajar:
   *
   *   · `base`     — sucursales, usuarios, listas, catálogos, remitos, avisos.
   *                  Chico. Cambia cada tanto.
   *   · `catalogo` — los productos con sus precios ya resueltos. 8 MB.
   *                  Cambia cuando alguien edita un producto o un precio: pocas
   *                  veces por día.
   *   · `stock`    — las existencias. 3 MB. Cambia con CADA venta.
   *
   * Cada parte lleva una VERSIÓN (secuencia de Postgres que avanza un trigger
   * en cada escritura: migración 0094). El controlador la lee ANTES de armar
   * nada: si el CRM ya tiene esa versión, contesta 304 y no toca una tabla
   * pesada. Así, después de una venta se vuelve a bajar el stock y nada más;
   * después de editar un producto, el catálogo y nada más. Y el 304 nunca
   * puede mentir, porque la versión la lleva la base y no el código.
   *
   * `bootstrap()` a secas sigue existiendo y devuelve las tres juntas con la
   * forma de siempre: un CRM abierto con la versión anterior lo sigue llamando
   * hasta que recargue.
   */

  /**
   * Las versiones de las tres partes, en una consulta a tres secuencias. Es
   * lo único que se lee para decidir un 304, por eso tiene que ser barato:
   * `last_value` no toma candado ni espera a nadie.
   *
   * SE LEE ANTES DE LOS DATOS, a propósito (ver el controlador): si se leyera
   * después, una escritura entre medio podría dejar una versión más nueva que
   * el contenido, y el CRM se quedaría con datos viejos creyendo que están al
   * día. Al revés —versión vieja, contenido nuevo— solo cuesta un 200 de más.
   *
   * `is_called` NO ES DECORATIVO. Una secuencia recién creada tiene
   * `last_value = 1` con `is_called = false`, y el PRIMER `nextval()` devuelve
   * ese 1 sin mover `last_value`: mirando solo `last_value`, el primer cambio
   * después de la migración sería invisible y el 304 mentiría una vez. Con
   * `is_called` la cuenta es 0 antes de cualquier escritura y 1 después de la
   * primera, y no hay hueco.
   */
  async versiones(): Promise<{ base: number; catalogo: number; stock: number }> {
    const r: any = await this.db.execute(sql`
      SELECT (SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM ver_base)     AS base,
             (SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM ver_catalogo) AS catalogo,
             (SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM ver_stock)    AS stock`);
    const f = r.rows?.[0] ?? {};
    return { base: Number(f.base) || 0, catalogo: Number(f.catalogo) || 0, stock: Number(f.stock) || 0 };
  }

  /** Las existencias, tal cual: la parte que cambia con cada venta. */
  async bootstrapStock() {
    return { stock: await this.db.select().from(stock) };
  }

  /**
   * Lo chico y estable: sucursales, usuarios, listas, catálogos, remitos, avisos.
   *
   * `soloSuc` (25/9/2026): los pedidos y las incidencias, solo los de esa
   * sucursal — `null` = todos (el jefe). El listado de pedidos ya estaba
   * acotado, pero esta carga los traía todos con sus renglones: el
   * fraccionador del Depósito leía el pedido que Centro le hizo a Norte.
   */
  async bootstrapBase(soloSuc: number | null = null) {
    const [suc, prov, usr, listasCat, transfs, incs, ms, cs, ss, es, rolesCat,
      pendientesLectura, urgentesVenc] = await Promise.all([
      this.db.select().from(sucursales),
      this.db.select().from(proveedores),
      this.db.select({ id: usuarios.id, nombre: usuarios.nombre, activo: usuarios.activo, rolId: usuarios.rolId }).from(usuarios),
      this.listas.catalogo(),
      this.listTransferencias(soloSuc),
      this.incidenciasVigentes(soloSuc),
      this.db.select().from(marcas),
      this.db.select().from(categorias),
      this.db.select().from(subcategorias),
      this.db.select().from(etiquetas),
      this.db.select().from(roles),
      this.db.select({ n: sql<number>`count(*)` }).from(facturaLecturas)
        .where(eq(facturaLecturas.estado, 'pendiente')),
      // Lo que apura del vigía de fechas: vencido sin procesar + vence en ≤7
      // días. El día se compara contra ARGENTINA, no contra el reloj UTC del
      // server (a la noche UTC ya es mañana y adelantaría los vencidos).
      this.db.select({ n: sql<number>`count(*)` }).from(vencimientos)
        .where(sql`(${vencimientos.procesado} = false AND ${vencimientos.fechaVencimiento} - (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date <= 7)`),
    ]);
    const cfgVentas = await this.cfg.get('ventas');
    return {
      listasCatalogo: listasCat,
      // Los catálogos del producto: chicos y estables, viajan enteros para que
      // los desplegables del modal no cuesten una llamada cada uno.
      catalogos: { marcas: ms, categorias: cs, subcategorias: ss, etiquetas: es },
      sucursales: suc, proveedores: prov, usuarios: this.usuariosPublicos(usr, rolesCat),
      transferencias: transfs, incidencias: incs,
      /*
       * Cuántas facturas de papel están esperando que alguien las cargue. Viaja
       * solo el NÚMERO —para el globito del menú—: la bandeja en sí la pide su
       * panel, con sus filtros. Sin este aviso nadie se entera de que hay
       * facturas subidas, y el papel se queda en la bandeja como se quedaba en
       * el cajón.
       */
      lecturasPendientes: Number(pendientesLectura?.[0]?.n) || 0,
      /*
       * ACÁ VIAJABA EL CONTADOR DE PEDIDOS DEL CAFÉ, y se fue en el 0098.
       *
       * Este snapshot es COMPARTIDO: la misma respuesta con el mismo ETag para
       * todos. Desde que cada sucursal ve solo los pedidos que le hicieron a
       * ella, un número acá sería el total de todas — y a Norte le habría
       * sonado la campana por un pedido del Depósito.
       *
       * El globito ahora lee el mismo poller que el aviso del encabezado
       * (`/cafeteria/pedidos-pendientes`), que sí mira la sesión. Un solo
       * número y una sola fuente, en vez de dos que no coincidían.
       */
      vencimientosUrgentes: Number(urgentesVenc?.[0]?.n) || 0,
      // El frontend replica el cálculo de precios: necesita el mismo redondeo
      // para no mostrar un número distinto al de la API.
      configVentas: cfgVentas,
    };
  }

  /**
   * Los productos con sus precios ya resueltos: la parte pesada y estable.
   *
   * `verCostos` (25/9/2026): el DETALLE DE COMPRA —lista del proveedor,
   * descuentos, flete— es de quien compra o fija precios (`/productos` ya se lo
   * ocultaba a los demás; esta carga no). Sin la llave viaja solo quién provee
   * cada producto (los filtros por proveedor lo usan) y el costo UNITARIO ya
   * resuelto, que sí hace falta afuera de Compras: el envío a la cafetería es
   * "a costo". `costosOcultos` le avisa a la pantalla que no lo recalcule.
   */
  async bootstrapCatalogo(verCostos = true) {
    const [prods, pres, provCostos, formatos, listasCat, ms, cs, ss, es, pes] = await Promise.all([
      this.db.select().from(productos),
      this.db.select().from(presentaciones),
      this.db.select().from(productoProveedores),
      this.db.select().from(productoListas),
      this.listas.catalogo(),
      this.db.select().from(marcas),
      this.db.select().from(categorias),
      this.db.select().from(subcategorias),
      this.db.select().from(etiquetas),
      this.db.select().from(productoEtiquetas),
    ]);
    const cfgVentas = await this.cfg.get('ventas');
    const redondeo = cfgVentas.redondeoPrecio;
    const activas = listasCat.listas.filter((l: any) => l.activa);
    const listaBase = activas.find((l: any) => l.id === cfgVentas.listaBaseId) || activas[0] || null;

    // Catálogos resueltos a nombre: la pantalla muestra "Cachafaz", no un id, y
    // así no tiene que cruzar cuatro tablas por fila.
    const nombreDe = (rows: any[]) => new Map<number, string>(rows.map((r) => [r.id, r.nombre]));
    const nMarca = nombreDe(ms);
    const nCategoria = nombreDe(cs);
    const nSubcategoria = nombreDe(ss);
    const nEtiqueta = nombreDe(es);
    const etiquetasDe = new Map<number, number[]>();
    for (const pe of pes) {
      const arr = etiquetasDe.get(pe.productoId);
      if (arr) arr.push(pe.etiquetaId); else etiquetasDe.set(pe.productoId, [pe.etiquetaId]);
    }

    /*
     * LOS ÍNDICES DEL ARMADO DE PRODUCTOS.
     *
     * Abajo se recorre producto por producto y, para cada uno, se buscaban sus
     * costos, sus formatos y sus presentaciones con un `filter` sobre la lista
     * COMPLETA. Con 2.700 productos eso vuelve a recorrer todo 2.700 veces por
     * cada lista: decenas de millones de comparaciones en el único hilo de
     * Node, que mientras tanto no atiende ninguna otra pantalla.
     *
     * Y esta carga no es ocasional: el sistema la vuelve a pedir DESPUÉS DE
     * CADA cambio de stock, de cada factura cargada y de cada corrección.
     *
     * `agruparPor` conserva el orden original dentro de cada grupo — de eso
     * depende `formatoActivo`, que define el costo cuando ninguno está marcado.
     */
    const costosDe = agruparPor(provCostos, (x) => x.productoId);
    const formatosDe = agruparPor(formatos, (x: any) => x.productoId);
    const presDe = agruparPor(pres, (x) => x.productoId);

    const productosFull = prods.map((p) => {
      const pp = grupo(costosDe, p.id);
      const active = formatoActivo(pp);
      /* Dos costos, dos preguntas (0072): `cn` es el REAL (valúa el stock que
       * muestra la pantalla), `cnPrecio` la base que multiplica el markup. Con
       * todo facturado son el mismo número. */
      const cn = costoNetoEntry(active, p.iva);
      const cnPrecio = costoPrecioEntry(active, p.iva);
      const mias = grupo(formatosDe, p.id);
      // El redondeo propio del producto pisa al de configuración; null = heredar.
      const opts = { iva: p.iva, redondeo: p.redondeo ?? redondeo };

      /*
       * FORMATO DE VENTA hecho precio. `presId` dice de quién son las filas: null
       * = el producto suelto, un id = uno de sus paquetes, que desde la 0053 se
       * cotiza solo. El armado es UNO para los dos: un paquete es la misma cosa
       * con otro costo (el del kilo × su tamaño).
       */
      const armarFormato = (presId: number | null, costo: number) => mias
        .filter((f) => ((f as any).presentacionId ?? null) === presId)
        .map((f) => {
          const l: any = activas.find((x: any) => x.id === f.listaId);
          if (!l) return null;
          // El MISMO helper que la ficha y el POS: markup o precio definido,
          // unidades por formato — una sola derivación en todo el sistema.
          const pv = precioVentaFila(costo, f as any, opts);
          return {
            id: f.id,          // fila de producto_listas: la llave de la masiva de márgenes
            listaId: f.listaId,
            modalidadId: l.modalidadId,
            modalidad: l.modalidad,
            numero: l.numero,
            nombre: l.nombre,
            etiqueta: l.etiqueta,
            orden: l.orden,
            modoPrecio: (f as any).modoPrecio,
            markup: f.markup,
            precioFijo: (f as any).precioFijo,
            unidades: (f as any).unidades,
            codigoBarras: (f as any).codigoBarras,
            unidadesMinimas: f.unidadesMinimas,
            precio: pv.netoUnitario,
            precioFinalUnitario: pv.finalUnitario,
            precioFinalFormato: pv.finalFormato,
          };
        })
        .filter(Boolean)
        .sort((a: any, b: any) => a.orden - b.orden) as any[];

      const listasProd = armarFormato(null, cnPrecio);
      /** El piso: lo que se paga sin que el ticket habilite nada. */
      const piso = (ls: any[]) => ls.find((l) => l.listaId === listaBase?.id) ?? ls[ls.length - 1] ?? null;
      const misEtq = etiquetasDe.get(p.id) ?? [];
      return {
        ...p,
        marca: nMarca.get(p.marcaId as number) ?? '',
        categoria: nCategoria.get(p.categoriaId as number) ?? '',
        subcategoria: nSubcategoria.get(p.subcategoriaId as number) ?? '',
        etiquetas: misEtq,
        etiquetasNombres: misEtq.map((id) => nEtiqueta.get(id)).filter(Boolean),
        costoNeto: cn,
        /* Cada paquete con SU formato de venta. `precio` null = todavía no tiene
         * ninguna lista cargada, que no es lo mismo que valer cero. */
        presentaciones: grupo(presDe, p.id).map((pr) => {
          // El paquete hereda los DOS costos de la madre, escalados a su tamaño.
          const costoPaquete = costoNetoPresentacion(cn, pr.tamKg);
          const suyas = armarFormato(pr.id, costoNetoPresentacion(cnPrecio, pr.tamKg));
          const pisoPres = piso(suyas);
          return {
            ...pr,
            costoNeto: costoPaquete,
            listas: suyas,
            sinFormato: suyas.length === 0,
            precio: pisoPres ? pisoPres.precio : null,
            precioFinal: pisoPres ? pisoPres.precioFinalUnitario : null,
          };
        }),
        // Cada formato con su cadena derivada. Mismo nombre que en
        // `/productos`: un producto tiene una sola forma, venga de donde venga.
        formatosCompra: verCostos
          ? pp.map((e) => ({ ...e, ...costosFormato(e, p.iva), costoNeto: costoNetoEntry(e, p.iva) }))
          : pp.map((e) => ({ proveedorId: e.proveedorId, usarParaPrecio: (e as any).usarParaPrecio })),
        ...(verCostos ? {} : { costosOcultos: true, costoPrecioNeto: cnPrecio }),
        listas: listasProd,
      };
    });
    return { productos: productosFull };
  }

  /**
   * El snapshot entero, con la forma de siempre: las tres partes juntas. Lo
   * usa el CRM que todavía no recargó después del deploy; el nuevo pide las
   * partes por separado (`/bootstrap/base`, `/catalogo`, `/stock`).
   */
  async bootstrap(soloSuc: number | null = null, verCostos = true) {
    const [base, catalogo, stk] = await Promise.all([
      this.bootstrapBase(soloSuc), this.bootstrapCatalogo(verCostos), this.bootstrapStock(),
    ]);
    return { ...base, ...catalogo, ...stk };
  }

  /* ==================================================================== *
   * Control de stock (0066): el físico contra el virtual
   * ==================================================================== */

  /**
   * El stock POR FORMA de todas las líneas de un conteo, en UNA query.
   * Devuelve mapas `clave → cantidad` con clave `productoId:presentacionId`.
   * Leer disponible y comprometido fila por fila sería una query por renglón
   * en la pantalla que más renglones tiene del sistema.
   */
  private async stockDeConteo(tx: any, sucursalId: number, prodIds: number[]) {
    if (!prodIds.length) return { disponible: new Map<string, number>(), comprometido: new Map<string, number>() };
    const filas = await tx.select().from(stock).where(and(
      eq(stock.sucursalId, sucursalId),
      inArray(stock.productoId, prodIds),
      inArray(stock.estado, ['disponible', 'comprometido'] as any),
    ));
    const disponible = new Map<string, number>();
    const comprometido = new Map<string, number>();
    for (const f of filas) {
      const k = `${f.productoId}:${f.presentacionId ?? ''}`;
      const m = f.estado === 'disponible' ? disponible : comprometido;
      m.set(k, (m.get(k) ?? 0) + Number(f.cantidad));
    }
    return { disponible, comprometido };
  }

  async listarConteos(sucursalId?: number | null) {
    const filas = await this.db.select().from(conteos)
      .where(sucursalId ? eq(conteos.sucursalId, sucursalId) : undefined)
      .orderBy(desc(conteos.id));
    if (!filas.length) return [];
    // Progreso por sesión en una sola pasada, no un COUNT por fila.
    const items = await this.db.select({
      conteoId: conteoItems.conteoId,
      total: sql<number>`count(*)::int`,
      contados: sql<number>`count(*) filter (where ${conteoItems.contado} is not null)::int`,
      aRecontar: sql<number>`count(*) filter (where ${conteoItems.recontar})::int`,
    }).from(conteoItems)
      .where(inArray(conteoItems.conteoId, filas.map((f) => f.id)))
      .groupBy(conteoItems.conteoId);
    const porId = new Map(items.map((i) => [i.conteoId, i]));
    return filas.map((f) => ({
      ...f,
      total: porId.get(f.id)?.total ?? 0,
      contados: porId.get(f.id)?.contados ?? 0,
      aRecontar: porId.get(f.id)?.aRecontar ?? 0,
    }));
  }

  /**
   * ABRE LA SESIÓN Y CONGELA SU LISTA. Los filtros se resuelven UNA vez, acá:
   * la sesión nace con sus renglones en pendiente y se cuenta la góndola de
   * esa noche, no el catálogo vivo — un alta a mitad del conteo no se cuela.
   *
   * EL CANDADO DE SOLAPAMIENTO es de forma física, no de sesión: un producto
   * no puede estar en dos sesiones abiertas de la misma sucursal, porque dos
   * conteos del mismo producto se aplicarían dos veces. El mensaje dice en
   * cuál está, porque "no se puede" sin el porqué manda a buscar al que sabe.
   */
  async crearConteo(o: {
    sucursalId: number; usuarioId?: number | null; nombre?: string; ciego?: boolean;
    marcaId?: number | null; categoriaId?: number | null; proveedorId?: number | null;
    tipo?: 'entero' | 'granel' | null; soloConStock?: boolean; incluirArchivados?: boolean;
  }) {
    return this.db.transaction(async (tx) => {
      const conds: any[] = [];
      if (!o.incluirArchivados) conds.push(ne(productos.estado, 'archivado' as any));
      if (o.marcaId) conds.push(eq(productos.marcaId, o.marcaId));
      if (o.categoriaId) conds.push(eq(productos.categoriaId, o.categoriaId));
      if (o.tipo) conds.push(eq(productos.tipo, o.tipo));
      let prods = await tx.select().from(productos).where(conds.length ? and(...conds) : undefined)
        .orderBy(asc(productos.nombre));
      if (o.proveedorId) {
        const pp = await tx.select({ productoId: productoProveedores.productoId }).from(productoProveedores)
          .where(eq(productoProveedores.proveedorId, o.proveedorId));
        const del = new Set(pp.map((x: any) => x.productoId));
        prods = prods.filter((p: any) => del.has(p.id));
      }
      if (!prods.length) throw new BadRequestException('Ningún producto entra en ese alcance. Aflojá los filtros.');

      const press = await tx.select().from(presentaciones)
        .where(inArray(presentaciones.productoId, prods.map((p: any) => p.id)));
      const presDe = new Map<number, any[]>();
      for (const pr of press) {
        if (!presDe.has(pr.productoId)) presDe.set(pr.productoId, []);
        presDe.get(pr.productoId)!.push(pr);
      }

      const { disponible } = await this.stockDeConteo(tx, o.sucursalId, prods.map((p: any) => p.id));

      /* Una fila por FORMA física: la madre (kg para granel, unidades para
       * entero) y cada tamaño de paquete aparte. Es como se cuenta de verdad:
       * el 500 g en la góndola no es "medio kilo de la madre". */
      const filas: any[] = [];
      for (const p of prods) {
        const conStock = (presId: number | null) =>
          Math.abs(disponible.get(`${p.id}:${presId ?? ''}`) ?? 0) > 1e-9;
        if (!o.soloConStock || conStock(null)) {
          filas.push({
            productoId: p.id, presentacionId: null, nombre: p.nombre,
            presLabel: '', unidad: this.unidadDe(p.tipo, null),
          });
        }
        for (const pr of presDe.get(p.id) ?? []) {
          if (o.soloConStock && !conStock(pr.id)) continue;
          filas.push({
            productoId: p.id, presentacionId: pr.id, nombre: p.nombre,
            presLabel: this.fmtTam(Number(pr.tamKg)), unidad: 'u',
          });
        }
      }
      if (!filas.length) throw new BadRequestException('Con "solo con stock" no queda nada para contar en ese alcance.');
      if (filas.length > 5000) throw new BadRequestException('El alcance es demasiado grande: partilo con los filtros.');

      /* El solapamiento se chequea contra TODO lo no terminado (en_curso y
       * cerrado sin aplicar): un cerrado esperando aplicación también va a
       * ajustar esas formas. */
      const abiertos = await tx.select().from(conteos).where(and(
        eq(conteos.sucursalId, o.sucursalId),
        inArray(conteos.estado, ['en_curso', 'cerrado'] as any),
      ));
      if (abiertos.length) {
        const ocupadas = await tx.select().from(conteoItems)
          .where(inArray(conteoItems.conteoId, abiertos.map((a: any) => a.id)));
        const enUso = new Map(ocupadas.map((x: any) => [`${x.productoId}:${x.presentacionId ?? ''}`, x.conteoId]));
        const choque = filas.find((f) => enUso.has(`${f.productoId}:${f.presentacionId ?? ''}`));
        if (choque) {
          const s = abiertos.find((a: any) => a.id === enUso.get(`${choque.productoId}:${choque.presentacionId ?? ''}`));
          throw new BadRequestException(
            `"${choque.nombre}" ya está en el control "${s?.nombre || `#${s?.id}`}" (${s?.estado === 'cerrado' ? 'cerrado sin aplicar' : 'en curso'}). `
            + 'Aplicalo o descartalo antes de abrir otro que lo incluya.',
          );
        }
      }

      const partes: string[] = [];
      if (o.marcaId) partes.push(`Marca ${(await tx.select().from(marcas).where(eq(marcas.id, o.marcaId)).limit(1))[0]?.nombre ?? o.marcaId}`);
      if (o.categoriaId) partes.push(`Categoría ${(await tx.select().from(categorias).where(eq(categorias.id, o.categoriaId)).limit(1))[0]?.nombre ?? o.categoriaId}`);
      if (o.proveedorId) partes.push(`Proveedor ${(await tx.select().from(proveedores).where(eq(proveedores.id, o.proveedorId)).limit(1))[0]?.nombre ?? o.proveedorId}`);
      if (o.tipo) partes.push(o.tipo === 'granel' ? 'Solo granel' : 'Solo enteros');
      if (o.soloConStock) partes.push('solo con stock');
      const alcance = partes.join(' · ') || 'Todo el catálogo';

      const [c] = await tx.insert(conteos).values({
        sucursalId: o.sucursalId,
        nombre: (o.nombre || '').trim() || alcance,
        alcance,
        ciego: o.ciego ?? true,
        usuarioId: o.usuarioId ?? null,
      }).returning();
      await tx.insert(conteoItems).values(filas.map((f) => ({ ...f, conteoId: c.id })));
      return { ...c, total: filas.length, contados: 0 };
    });
  }

  private async conteoVivo(tx: any, id: number, soloSuc?: number | null) {
    const [c] = await tx.select().from(conteos).where(eq(conteos.id, id)).limit(1);
    if (!c) throw new BadRequestException('Ese control de stock no existe.');
    if (soloSuc && c.sucursalId !== soloSuc) throw new ForbiddenException('Ese control es de otra sucursal.');
    return c;
  }

  /**
   * LA SESIÓN CON SUS RENGLONES — y acá vive el CIEGO, del lado que manda.
   *
   * Mientras el conteo está ciego y el que mira no tiene `conteos_aplicar`,
   * el payload NO trae el virtual: ni el vivo, ni el congelado, ni la
   * diferencia. Ocultarlo en la pantalla y mandarlo igual sería un ciego de
   * mentira — se lee con F12. El que cuenta ve qué contar y qué contó, nada
   * más; las diferencias las ve el que revisa, en el reporte.
   *
   * Lo único del virtual que viaja siempre es `apartados` (comprometido > 0):
   * sin ese aviso el contador suma al conteo la mercadería separada para
   * envíos y la diferencia da sobrante fantasma. Dice cuánto apartar de la
   * cuenta, no cuánto "debería haber" — no rompe el ciego.
   */
  async getConteo(id: number, opciones: { puedeVerVirtual?: boolean; soloSuc?: number | null } = {}) {
    const c = await this.conteoVivo(this.db, id, opciones.soloSuc);
    const items = await this.db.select().from(conteoItems)
      .where(eq(conteoItems.conteoId, id)).orderBy(asc(conteoItems.nombre), asc(conteoItems.id));
    const { disponible, comprometido } = await this.stockDeConteo(
      this.db, c.sucursalId, [...new Set(items.map((i) => i.productoId))],
    );

    const oculto = c.ciego && c.estado === 'en_curso' && !opciones.puedeVerVirtual;
    const conDiferencias = !oculto && (opciones.puedeVerVirtual || !c.ciego);

    const filas = await Promise.all(items.map(async (i) => {
      const k = `${i.productoId}:${i.presentacionId ?? ''}`;
      const base: any = {
        id: i.id, productoId: i.productoId, presentacionId: i.presentacionId,
        nombre: i.nombre, presLabel: i.presLabel, unidad: i.unidad,
        contado: i.contado, contadoPor: i.contadoPor, contadoEn: i.contadoEn, recontar: i.recontar,
        apartados: comprometido.get(k) ?? 0,
      };
      if (!conDiferencias) return base;
      const virtual = disponible.get(k) ?? 0;
      const diferencia = i.contado == null ? null : Number((i.contado - (i.virtualAlContar ?? 0)).toFixed(3));
      /* `seMovio` es LA ALARMA del local cerrado: si el disponible de ahora no
       * es el del momento del conteo, alguien vendió o movió mercadería con el
       * local supuestamente cerrado. No bloquea — señala. */
      const seMovio = i.contado != null && Math.abs(virtual - (i.virtualAlContar ?? 0)) > 1e-9;
      let costoUnitario = 0;
      if (diferencia != null && Math.abs(diferencia) > 1e-9) {
        const [prod] = await this.db.select().from(productos).where(eq(productos.id, i.productoId)).limit(1);
        costoUnitario = prod ? await this.costoDePerdida(this.db, prod, i.presentacionId) : 0;
      }
      return {
        ...base, virtual, virtualAlContar: i.virtualAlContar, diferencia, seMovio,
        costoUnitario, diferenciaPlata: diferencia != null ? Number((diferencia * costoUnitario).toFixed(2)) : null,
      };
    }));

    return {
      ...c,
      total: items.length,
      contados: items.filter((i) => i.contado != null).length,
      puedeVerVirtual: !!opciones.puedeVerVirtual,
      items: filas,
    };
  }

  /**
   * REGISTRA UN CONTEO — y el snapshot lo toma el SERVIDOR, acá.
   *
   * `virtual_al_contar` es el disponible de ESTE instante, leído dentro de la
   * misma operación. Con eso la diferencia queda clavada como hecho ("a las
   * 22:14 había 8 y el sistema decía 10") y aplicar más tarde no la corrompe.
   * `contado: null` devuelve la línea a pendiente — es el "me equivoqué de
   * renglón", y borra el snapshot porque un pendiente no tiene instante.
   */
  async contarItem(conteoId: number, itemId: number, o: { contado: number | null; usuarioId?: number | null }, soloSuc?: number | null) {
    return this.db.transaction(async (tx) => {
      const c = await this.conteoVivo(tx, conteoId, soloSuc);
      if (c.estado !== 'en_curso') {
        throw new BadRequestException(c.estado === 'cerrado'
          ? 'El control está cerrado: reabrilo para seguir contando.'
          : 'Ese control ya no se puede contar.');
      }
      const [it] = await tx.select().from(conteoItems)
        .where(and(eq(conteoItems.id, itemId), eq(conteoItems.conteoId, conteoId))).limit(1);
      if (!it) throw new BadRequestException('Ese renglón no es de este control.');

      /*
       * LA RESPUESTA NO LLEVA EL SNAPSHOT, a propósito. `returning()` entero
       * devolvería `virtual_al_contar` — y el ciego se impone acá, en la API:
       * el que cuenta recibiría el virtual como premio por contar, en la
       * respuesta del propio PUT. Se devuelve lo que la pantalla necesita
       * para pintar la fila: nada más.
       */
      if (o.contado == null) {
        await tx.update(conteoItems).set({
          contado: null, virtualAlContar: null, contadoPor: null, contadoEn: null, recontar: false,
        }).where(eq(conteoItems.id, itemId));
        return { id: itemId, contado: null, contadoEn: null, recontar: false };
      }

      const virtual = await this.cant(tx, it.productoId, c.sucursalId, it.presentacionId, 'disponible');
      const ahora = new Date();
      await tx.update(conteoItems).set({
        contado: o.contado,
        virtualAlContar: virtual,
        contadoPor: o.usuarioId ?? null,
        contadoEn: ahora,
        recontar: false,        // recontada: la marca ya cumplió su trabajo
      }).where(eq(conteoItems.id, itemId));
      return { id: itemId, contado: o.contado, contadoEn: ahora, recontar: false };
    });
  }

  async cerrarConteo(id: number, soloSuc?: number | null) {
    const c = await this.conteoVivo(this.db, id, soloSuc);
    if (c.estado !== 'en_curso') throw new BadRequestException('Solo se cierra un control en curso.');
    const [r] = await this.db.update(conteos).set({ estado: 'cerrado', cerradoEn: new Date() })
      .where(eq(conteos.id, id)).returning();
    return r;
  }

  async reabrirConteo(id: number, soloSuc?: number | null) {
    const c = await this.conteoVivo(this.db, id, soloSuc);
    if (c.estado !== 'cerrado') throw new BadRequestException('Solo se reabre un control cerrado sin aplicar.');
    const [r] = await this.db.update(conteos).set({ estado: 'en_curso', cerradoEn: null })
      .where(eq(conteos.id, id)).returning();
    return r;
  }

  /** La marca del revisor: "esta diferencia es grande, volvé a la góndola". */
  async marcarRecontar(conteoId: number, itemId: number, valor: boolean, soloSuc?: number | null) {
    const c = await this.conteoVivo(this.db, conteoId, soloSuc);
    if (c.estado === 'aplicado' || c.estado === 'descartado') {
      throw new BadRequestException('Ese control ya está terminado.');
    }
    const [r] = await this.db.update(conteoItems).set({ recontar: valor })
      .where(and(eq(conteoItems.id, itemId), eq(conteoItems.conteoId, conteoId))).returning();
    if (!r) throw new BadRequestException('Ese renglón no es de este control.');
    return r;
  }

  /**
   * APLICA EL CONTEO: un lote atómico de ajustes POR DIFERENCIA.
   *
   * Cada renglón contado ajusta por `contado − virtual_al_contar`, sobre el
   * stock ACTUAL. Nunca se pisa el stock con el contado: eso resucitaría lo
   * legítimamente movido después del conteo. Y LO NO CONTADO NO SE TOCA — un
   * pendiente no es un cero, es una pregunta sin responder.
   *
   * El costo viaja CONGELADO en cada movimiento (mismo criterio que las
   * pérdidas): el reporte en pesos de este conteo no puede cambiar el mes que
   * viene porque subió el catálogo.
   *
   * Devuelve los avisos de `seMovio` — con el local cerrado tendrían que ser
   * cero, y cada uno es una pregunta para hacerle a alguien.
   */
  async aplicarConteo(id: number, usuarioId?: number | null, soloSuc?: number | null) {
    return this.db.transaction(async (tx) => {
      const c = await this.conteoVivo(tx, id, soloSuc);
      if (c.estado === 'aplicado') throw new BadRequestException('Ese control ya se aplicó.');
      if (c.estado === 'descartado') throw new BadRequestException('Ese control está descartado.');
      if (c.estado !== 'cerrado') throw new BadRequestException('Cerrá el control antes de aplicarlo: el cierre es la foto final.');

      const items = await tx.select().from(conteoItems)
        .where(and(eq(conteoItems.conteoId, id), isNotNull(conteoItems.contado)));
      const avisos: string[] = [];
      let ajustes = 0;

      for (const it of items) {
        const delta = Number(((it.contado ?? 0) - (it.virtualAlContar ?? 0)).toFixed(3));
        const virtualAhora = await this.cant(tx, it.productoId, c.sucursalId, it.presentacionId, 'disponible');
        const etiqueta = it.presLabel ? `${it.nombre} · ${it.presLabel}` : it.nombre;
        if (Math.abs(virtualAhora - (it.virtualAlContar ?? 0)) > 1e-9) {
          avisos.push(`${etiqueta}: el stock se movió después de contarlo (era ${it.virtualAlContar}, ahora ${virtualAhora}). ¿Se vendió algo con el local cerrado?`);
        }
        if (Math.abs(delta) < 1e-9) continue;

        const [prod] = await tx.select().from(productos).where(eq(productos.id, it.productoId)).limit(1);
        if (!prod) continue;
        await this.addDelta(tx, {
          productoId: it.productoId, sucursalId: c.sucursalId,
          presentacionId: it.presentacionId, estado: 'disponible',
        }, delta);
        await this.mov(tx, {
          tipo: 'ajuste', productoId: it.productoId, sucursalId: c.sucursalId,
          presentacionId: it.presentacionId, signo: delta > 0 ? 1 : -1, cantidad: Math.abs(delta),
          unidad: it.unidad, estadoDesde: delta < 0 ? 'disponible' : null, estadoHacia: delta > 0 ? 'disponible' : null,
          costoUnitario: await this.costoDePerdida(tx, prod, it.presentacionId),
          usuarioId: usuarioId ?? null, refConteoId: id,
          motivo: `Control de stock ${c.nombre || `#${id}`}`,
          descripcion: `Conteo: había ${it.contado}, el sistema decía ${it.virtualAlContar} (${delta > 0 ? '+' : '−'}${Math.abs(delta)})`,
        });
        ajustes += 1;
      }

      const [r] = await tx.update(conteos).set({
        estado: 'aplicado', aplicadoEn: new Date(), aplicadoPor: usuarioId ?? null,
      }).where(eq(conteos.id, id)).returning();
      return { ...r, ajustes, sinDiferencia: items.length - ajustes, avisos };
    });
  }

  async descartarConteo(id: number, opciones: { puedeAplicar?: boolean; soloSuc?: number | null } = {}) {
    const c = await this.conteoVivo(this.db, id, opciones.soloSuc);
    if (c.estado === 'aplicado') throw new BadRequestException('Un control aplicado no se descarta: ya movió stock.');
    if (c.estado === 'descartado') return c;
    /* La cajera puede descartar SU sesión mal abierta mientras esté virgen;
     * con renglones ya contados adentro, tirar ese trabajo lo decide quien
     * puede aplicar. */
    if (!opciones.puedeAplicar) {
      const [con] = await this.db.select({ n: sql<number>`count(*)::int` }).from(conteoItems)
        .where(and(eq(conteoItems.conteoId, id), isNotNull(conteoItems.contado)));
      if (Number(con?.n) > 0) {
        throw new ForbiddenException('Este control ya tiene renglones contados: descartarlo es tirar ese trabajo, y lo decide quien puede aplicar.');
      }
    }
    const [r] = await this.db.update(conteos).set({ estado: 'descartado' }).where(eq(conteos.id, id)).returning();
    return r;
  }
}

