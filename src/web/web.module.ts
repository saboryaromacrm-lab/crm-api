/**
 * WEB — administración del sitio desde el CRM
 * ============================================================================
 * El módulo Web NO define qué se vende ni a cuánto (eso es de Compras y del
 * formato de venta): administra la CARA del sitio. Sus mutaciones son pocas a
 * propósito:
 *
 *   - `destacado` del producto → el carrusel "Destacados" de la portada.
 *   - Imágenes: foto de producto, imagen de categoría, logo de marca y banner
 *     (tabla `web_imagenes`; el sitio las recibe como URL versionada).
 *   - Los TEXTOS del sitio (hero) van por la configuración general
 *     (`GET/PUT /configuracion/web`) — no necesitan endpoints propios.
 *
 * Qué productos están en el sitio no se decide acá: es la regla de la lista
 * Mayorista que aplica `TiendaService.catalogo()`.
 */
import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, Injectable,
  Logger, Module, NotFoundException, OnModuleDestroy, OnModuleInit, Param, ParseIntPipe, Patch,
  Post, Query,
} from '@nestjs/common';
import { and, eq, gte, inArray, isNull, lt, ne } from 'drizzle-orm';
import { Auth, Permiso, Sesion } from '../auth/auth.decoradores';
import { tienePermiso } from '../auth/auth.guard';
import { MIMES_IMAGEN, mimeReal } from '../common/archivos';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  categorias, configuracion, marcas, presupuestoItems, presupuestos, productos, stock,
  sucursales, webEventos, webImagenes,
} from '../db/schema';

/**
 * QUÉ PERMISO PIDE CADA IMAGEN — y de acá sale todo lo demás.
 *
 * No todas las imágenes del sitio son la misma responsabilidad: la foto de un
 * producto la carga quien administra el catálogo web, el banner y las
 * categorías quien arma el contenido, y el logo del sitio es configuración.
 * Son las mismas tres secciones que ya divide el panel (`web.config.js`).
 *
 * El tipo de imagen es un dato del cuerpo, así que el decorador del endpoint no
 * puede saber cuál corresponde: pide CUALQUIERA de los tres (el piso) y el
 * servicio exige el exacto. Para que esas dos puertas no puedan discrepar, las
 * dos se derivan de este mapa — agregar un tipo nuevo acá las actualiza juntas.
 */
const PERMISO_DE_IMAGEN: Record<string, string> = {
  producto: 'web.productos',
  categoria: 'web.contenido',
  marca: 'web.contenido',
  banner: 'web.contenido',
  // 'logo' y 'favicon' usan refId 1: hay uno solo de cada uno.
  logo: 'web.configuracion',
  favicon: 'web.configuracion',
};
/** El piso del decorador: las claves del mapa, sin repetir. */
const PERMISOS_IMAGEN = [...new Set(Object.values(PERMISO_DE_IMAGEN))];
/** Tope generoso para fotos de catálogo; el banner es la imagen más grande. */
const MAX_IMG_KB = 800;

/**
 * La telemetría cruda se guarda 13 MESES y después se purga: un año completo
 * más el mes en curso, para poder comparar una temporada contra la anterior.
 * Más viejo que eso nadie lo mira, y dejarlo crecer para siempre solo engorda
 * los backups.
 */
const PURGA_MESES = 13;
const PURGA_CADA_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class WebService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('WebEventos');
  private purgaTimer: ReturnType<typeof setInterval> | null = null;

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * La purga corre AL ARRANCAR y cada 24 hs mientras la API esté prendida —
   * no a una hora fija, porque este servidor es una PC que se apaga y un cron
   * de madrugada no correría nunca. Es idempotente: correrla de más no borra
   * nada que no esté ya vencido.
   */
  onModuleInit() {
    this.purgarEventosViejos();
    this.purgaTimer = setInterval(() => this.purgarEventosViejos(), PURGA_CADA_MS);
  }

  onModuleDestroy() {
    if (this.purgaTimer) clearInterval(this.purgaTimer);
  }

  private async purgarEventosViejos() {
    try {
      const limite = new Date();
      limite.setMonth(limite.getMonth() - PURGA_MESES);
      const res: any = await this.db.delete(webEventos).where(lt(webEventos.fecha, limite));
      const n = Number(res?.rowCount) || 0;
      if (n > 0) this.log.log(`Purga: ${n} evento(s) de más de ${PURGA_MESES} meses eliminados.`);
    } catch (e: any) {
      // La purga jamás voltea la API: si falla, se reintenta en la próxima vuelta.
      this.log.warn(`No se pudo purgar la telemetría: ${e?.message ?? e}`);
    }
  }

  /** Lo editable del producto desde el módulo Web: `destacado` y el piso de stock online. */
  async editarProducto(id: number, o: { destacado?: boolean; webStockMin?: number }) {
    const patch: any = {};
    if (o.destacado != null) patch.destacado = !!o.destacado;
    if (o.webStockMin != null) {
      const n = Number(o.webStockMin);
      if (!Number.isFinite(n) || n < 0) throw new BadRequestException('El mínimo web no puede ser negativo.');
      patch.webStockMin = n;
    }
    if (!Object.keys(patch).length) throw new BadRequestException('Nada para cambiar.');
    const [p] = await this.db.update(productos).set(patch)
      .where(eq(productos.id, id)).returning();
    if (!p) throw new NotFoundException('Producto inexistente.');
    return { ok: true, destacado: p.destacado, webStockMin: p.webStockMin };
  }

  /**
   * Vista ADMIN de los productos del sitio: el stock real de la Distribuidora
   * y el piso configurado. Va por acá y no por el catálogo público a
   * propósito — la cantidad exacta de stock no es dato para el visitante.
   */
  async productosAdmin() {
    const [dist] = await this.db.select().from(sucursales).where(eq(sucursales.tipo, 'distribuidora')).limit(1);
    const [prods, existencias] = await Promise.all([
      this.db.select({ id: productos.id, webStockMin: productos.webStockMin }).from(productos),
      dist
        ? this.db.select().from(stock)
          .where(and(eq(stock.sucursalId, dist.id), eq(stock.estado, 'disponible'), isNull(stock.presentacionId)))
        : Promise.resolve([] as any[]),
    ]);
    const disp = new Map<number, number>();
    for (const s of existencias) disp.set(s.productoId, (disp.get(s.productoId) ?? 0) + s.cantidad);
    return prods.map((p) => ({
      id: p.id,
      webStockMin: p.webStockMin,
      stockDisp: Math.round((disp.get(p.id) ?? 0) * 100) / 100,
    }));
  }

  /**
   * El permiso EXACTO que pide este tipo de imagen. Usa el mismo `tienePermiso`
   * que el guard —el `*` del superadmin incluido— para que la regla no exista
   * escrita de dos maneras distintas.
   */
  private exigirPermisoDeImagen(tipo: string, sesion: Sesion) {
    const clave = PERMISO_DE_IMAGEN[tipo];
    if (!clave) throw new BadRequestException('Tipo de imagen inválido.');
    if (!tienePermiso(sesion?.permisos ?? [], [clave])) {
      throw new ForbiddenException('Tu rol no tiene permiso para esto.');
    }
  }

  /**
   * Sube (o reemplaza) una imagen. `data` viene como data-URL del navegador.
   *
   * EL FORMATO SALE DE LOS BYTES, no del rótulo que mandó el cliente. Esta
   * imagen vuelve a salir por `GET /tienda/imagenes/...`, que es público y
   * vive en el MISMO ORIGEN que el dashboard: un archivo que se hace pasar
   * por imagen y en realidad ejecuta JavaScript (el caso clásico es el SVG)
   * correría con la sesión del CRM de quien lo abra. Por eso se contrasta la
   * firma y se guarda lo que los bytes dicen ser, no lo declarado.
   *
   * No le quita nada al uso real: el panel pasa toda imagen por el canvas y
   * exporta WebP (o PNG en Safari) — nunca sube un SVG.
   */
  /**
   * El `refId` al que se cuelga la imagen tiene que EXISTIR. Sin esto, un
   * `POST /web/imagenes/producto/$i` en un `for` de 1 a 5000 dejaba miles de
   * filas de 800 KB colgadas de productos inexistentes, que engordan cada
   * backup para siempre. `logo` y `favicon` son únicos: hay uno solo de cada
   * uno, así que su `refId` es SIEMPRE 1 (y no `logo/2`, `logo/3`… basura).
   * Devuelve el `refId` ya resuelto.
   */
  private async resolverRefId(tipo: string, refId: number): Promise<number> {
    if (tipo === 'logo' || tipo === 'favicon') return 1;
    const existe = async (tabla: any) =>
      (await this.db.select({ id: tabla.id }).from(tabla).where(eq(tabla.id, refId)).limit(1)).length > 0;
    if (tipo === 'producto' && await existe(productos)) return refId;
    if (tipo === 'categoria' && await existe(categorias)) return refId;
    if (tipo === 'marca' && await existe(marcas)) return refId;
    if (tipo === 'banner') {
      // El banner cuelga de un slide de la portada, que vive en la config web.
      const [row] = await this.db.select({ valor: configuracion.valor })
        .from(configuracion).where(eq(configuracion.clave, 'web')).limit(1);
      const slides = (row?.valor as any)?.slides;
      if (Array.isArray(slides) && slides.some((s: any) => Number(s?.id) === refId)) return refId;
    }
    throw new NotFoundException('No existe eso a lo que le querés poner imagen.');
  }

  async subirImagen(tipo: string, refId: number, data: string, sesion: Sesion) {
    this.exigirPermisoDeImagen(tipo, sesion);
    const ref = await this.resolverRefId(tipo, refId);
    const m = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/i.exec(String(data ?? ''));
    if (!m) throw new BadRequestException('Mandá la imagen como data-URL (PNG/JPG/WebP).');
    const [, declarado, base64] = m;

    const buf = Buffer.from(base64, 'base64');
    const kb = buf.length / 1024;
    if (kb > MAX_IMG_KB) {
      throw new BadRequestException(`La imagen pesa ${Math.round(kb)} KB: usá una de hasta ${MAX_IMG_KB} KB.`);
    }
    const real = mimeReal(buf);
    if (!real || !MIMES_IMAGEN.has(real)) {
      throw new BadRequestException('Ese archivo no es una imagen PNG, JPG ni WebP.');
    }
    if (real !== declarado.toLowerCase()) {
      throw new BadRequestException(`El archivo dice ser ${declarado} pero su contenido es ${real}.`);
    }

    // Se re-codifica desde el buffer ya validado: lo que se guarda es
    // exactamente lo que se contrastó, sin restos del texto original.
    const limpio = buf.toString('base64');
    const [img] = await this.db.insert(webImagenes)
      .values({ tipo: tipo as any, refId: ref, mime: real, data: limpio, actualizadoEn: new Date() })
      .onConflictDoUpdate({
        target: [webImagenes.tipo, webImagenes.refId],
        set: { mime: real, data: limpio, actualizadoEn: new Date() },
      })
      .returning({ tipo: webImagenes.tipo, refId: webImagenes.refId, actualizadoEn: webImagenes.actualizadoEn });
    return { ok: true, url: `tienda/imagenes/${img.tipo}/${img.refId}?v=${new Date(img.actualizadoEn).getTime()}` };
  }

  async borrarImagen(tipo: string, refId: number, sesion: Sesion) {
    this.exigirPermisoDeImagen(tipo, sesion);
    await this.db.delete(webImagenes)
      .where(and(eq(webImagenes.tipo, tipo as any), eq(webImagenes.refId, refId)));
    return { ok: true };
  }

  /**
   * Estadísticas del sitio, agregadas para el panel: visitas y sesiones por
   * día, y el ranking de productos (vistas, SEGUNDOS promedio en pantalla,
   * agregados al carrito y unidades pedidas). "Lo pedido" sale de los
   * presupuestos con origen web no cancelados — el interés que terminó en
   * plata, no un contador aparte que pueda discrepar.
   */
  async estadisticas(dias: number) {
    const n = Math.min(Math.max(Number(dias) || 30, 1), 365);
    const desde = new Date(Date.now() - n * 86400000);
    desde.setHours(0, 0, 0, 0);

    const [evs, prods, pedidosWeb] = await Promise.all([
      this.db.select().from(webEventos).where(gte(webEventos.fecha, desde)),
      this.db.select({ id: productos.id, nombre: productos.nombre }).from(productos),
      this.db.select().from(presupuestos)
        .where(and(eq(presupuestos.origen, 'web'), gte(presupuestos.fecha, desde), ne(presupuestos.estado, 'cancelado'))),
    ]);

    /*
     * Los renglones SOLO de los pedidos del período, no toda la tabla hija
     * histórica: a los dos años de operación, bajar `presupuesto_items` entera
     * para cruzarla contra un puñado de pedidos web tira la pantalla sola.
     */
    const idsPeriodo = pedidosWeb.map((p) => p.id);
    const items = idsPeriodo.length
      ? await this.db.select().from(presupuestoItems).where(inArray(presupuestoItems.presupuestoId, idsPeriodo))
      : [];

    /* Serie por día (con los días sin tráfico en cero: el gráfico no miente saltándolos). */
    const claveDia = (d: Date) => d.toISOString().slice(0, 10);
    const porDia = new Map<string, { fecha: string; vistas: number; sesiones: Set<string> }>();
    for (let i = 0; i <= n; i++) {
      const d = new Date(desde.getTime() + i * 86400000);
      if (d.getTime() > Date.now()) break;
      porDia.set(claveDia(d), { fecha: claveDia(d), vistas: 0, sesiones: new Set() });
    }

    const sesiones = new Set<string>();
    const porProducto = new Map<number, { vistas: number; segundos: number; carrito: number }>();
    /* Términos de búsqueda: agrupados sin mayúsculas ni acentos, mostrando el
     * primer texto tal como se tipeó. Lo que se busca y no se encuentra es la
     * lista de compras del catálogo. */
    const busquedas = new Map<string, { termino: string; veces: number }>();
    const normBusqueda = (v: string) => v.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').trim();
    for (const e of evs) {
      if (e.sesion) sesiones.add(e.sesion);
      const dia = porDia.get(claveDia(new Date(e.fecha)));
      if (e.tipo === 'vista_pagina') {
        if (dia) { dia.vistas += 1; if (e.sesion) dia.sesiones.add(e.sesion); }
        continue;
      }
      if (e.tipo === 'busqueda') {
        const termino = String(e.ruta ?? '').trim().slice(0, 60);
        if (!termino) continue;
        const clave = normBusqueda(termino);
        const acc = busquedas.get(clave) ?? { termino, veces: 0 };
        acc.veces += 1;
        busquedas.set(clave, acc);
        continue;
      }
      if (!e.productoId) continue;
      const p = porProducto.get(e.productoId) ?? { vistas: 0, segundos: 0, carrito: 0 };
      if (e.tipo === 'vista_producto') { p.vistas += 1; p.segundos += e.segundos; }
      if (e.tipo === 'agregar_carrito') p.carrito += 1;
      porProducto.set(e.productoId, p);
    }

    /* Lo efectivamente pedido por la web en el período. */
    const idsPedidos = new Set(pedidosWeb.map((p) => p.id));
    const pedidoPorProducto = new Map<number, { unidades: number; pedidos: number }>();
    for (const it of items) {
      if (!idsPedidos.has(it.presupuestoId)) continue;
      const acc = pedidoPorProducto.get(it.productoId) ?? { unidades: 0, pedidos: 0 };
      acc.unidades += it.cantidad;
      acc.pedidos += 1;
      pedidoPorProducto.set(it.productoId, acc);
    }

    const nombreDe = new Map(prods.map((p) => [p.id, p.nombre]));
    const idsTodos = new Set([...porProducto.keys(), ...pedidoPorProducto.keys()]);
    const ranking = [...idsTodos].map((id) => {
      const ev = porProducto.get(id) ?? { vistas: 0, segundos: 0, carrito: 0 };
      const pe = pedidoPorProducto.get(id) ?? { unidades: 0, pedidos: 0 };
      return {
        id,
        nombre: nombreDe.get(id) ?? `Producto #${id}`,
        vistas: ev.vistas,
        segundosProm: ev.vistas ? Math.round((ev.segundos / ev.vistas) * 10) / 10 : 0,
        carrito: ev.carrito,
        pedidos: pe.pedidos,
        unidades: Math.round(pe.unidades * 100) / 100,
      };
    }).sort((a, b) => b.vistas - a.vistas || b.unidades - a.unidades);

    const totalVistas = [...porDia.values()].reduce((a, d) => a + d.vistas, 0);
    return {
      dias: n,
      vistas: totalVistas,
      sesiones: sesiones.size,
      pedidos: pedidosWeb.length,
      /** Pedidos / sesiones: cuántas visitas terminan en un pedido. */
      conversion: sesiones.size ? Math.round((pedidosWeb.length / sesiones.size) * 1000) / 10 : 0,
      porDia: [...porDia.values()].map((d) => ({ fecha: d.fecha, vistas: d.vistas, sesiones: d.sesiones.size })),
      productos: ranking,
      busquedas: [...busquedas.values()].sort((a, b) => b.veces - a.veces).slice(0, 20),
    };
  }
}

/**
 * Cada endpoint pide SU permiso, no uno solo para todo el módulo: las cuatro
 * claves de Web ya existían en el catálogo de permisos y se chequeaban nada más
 * que en el navegador (`WebPage.jsx`, `secciones.filter`), o sea que escondían
 * el botón pero no la llamada. Sin esto, cualquiera con una sesión válida podía
 * poner el sitio entero en "Sin stock" o cambiarle el logo.
 */
@Controller('web')
export class WebController {
  constructor(private readonly svc: WebService) {}

  @Get('estadisticas')
  @Permiso('web.estadisticas')
  estadisticas(@Query('dias') dias?: string) {
    return this.svc.estadisticas(dias ? Number(dias) : 30);
  }

  @Get('productos')
  @Permiso('web.productos')
  productos() { return this.svc.productosAdmin(); }

  @Patch('productos/:id')
  @Permiso('web.productos')
  producto(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.editarProducto(id, body ?? {});
  }

  /* El piso: alguna de las tres. Cuál corresponde depende del `tipo`, y eso lo
   * exige el servicio con el mismo mapa del que sale esta lista. */
  @Post('imagenes/:tipo/:refId')
  @Permiso(...PERMISOS_IMAGEN)
  subir(
    @Param('tipo') tipo: string,
    @Param('refId', ParseIntPipe) refId: number,
    @Body() body: any,
    @Auth() sesion: Sesion,
  ) {
    return this.svc.subirImagen(tipo, refId, body?.data, sesion);
  }

  @Delete('imagenes/:tipo/:refId')
  @Permiso(...PERMISOS_IMAGEN)
  borrar(
    @Param('tipo') tipo: string,
    @Param('refId', ParseIntPipe) refId: number,
    @Auth() sesion: Sesion,
  ) {
    return this.svc.borrarImagen(tipo, refId, sesion);
  }
}

@Module({
  controllers: [WebController],
  providers: [WebService],
})
export class WebModule {}

