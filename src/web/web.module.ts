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
  BadRequestException, Body, Controller, Delete, Get, Inject, Injectable, Logger, Module,
  NotFoundException, OnModuleDestroy, OnModuleInit, Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import { and, eq, gte, isNull, lt, ne } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  presupuestoItems, presupuestos, productos, stock, sucursales, webEventos, webImagenes,
} from '../db/schema';

// 'logo' y 'favicon' usan refId 1: hay uno solo de cada uno.
const TIPOS_IMAGEN = new Set(['producto', 'categoria', 'marca', 'banner', 'logo', 'favicon']);
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

  /** Sube (o reemplaza) una imagen. `data` viene como data-URL del navegador. */
  async subirImagen(tipo: string, refId: number, data: string) {
    if (!TIPOS_IMAGEN.has(tipo)) throw new BadRequestException('Tipo de imagen inválido.');
    const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(data ?? ''));
    if (!m) throw new BadRequestException('Mandá la imagen como data-URL (PNG/JPG/WebP).');
    const [, mime, base64] = m;
    const kb = (base64.length * 3) / 4 / 1024;
    if (kb > MAX_IMG_KB) {
      throw new BadRequestException(`La imagen pesa ${Math.round(kb)} KB: usá una de hasta ${MAX_IMG_KB} KB.`);
    }

    const [img] = await this.db.insert(webImagenes)
      .values({ tipo: tipo as any, refId, mime, data: base64, actualizadoEn: new Date() })
      .onConflictDoUpdate({
        target: [webImagenes.tipo, webImagenes.refId],
        set: { mime, data: base64, actualizadoEn: new Date() },
      })
      .returning({ tipo: webImagenes.tipo, refId: webImagenes.refId, actualizadoEn: webImagenes.actualizadoEn });
    return { ok: true, url: `tienda/imagenes/${img.tipo}/${img.refId}?v=${new Date(img.actualizadoEn).getTime()}` };
  }

  async borrarImagen(tipo: string, refId: number) {
    if (!TIPOS_IMAGEN.has(tipo)) throw new BadRequestException('Tipo de imagen inválido.');
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

    const [evs, prods, pedidosWeb, items] = await Promise.all([
      this.db.select().from(webEventos).where(gte(webEventos.fecha, desde)),
      this.db.select({ id: productos.id, nombre: productos.nombre }).from(productos),
      this.db.select().from(presupuestos)
        .where(and(eq(presupuestos.origen, 'web'), gte(presupuestos.fecha, desde), ne(presupuestos.estado, 'cancelado'))),
      this.db.select().from(presupuestoItems),
    ]);

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

@Controller('web')
export class WebController {
  constructor(private readonly svc: WebService) {}

  @Get('estadisticas')
  estadisticas(@Query('dias') dias?: string) {
    return this.svc.estadisticas(dias ? Number(dias) : 30);
  }

  @Get('productos')
  productos() { return this.svc.productosAdmin(); }

  @Patch('productos/:id')
  producto(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.editarProducto(id, body ?? {});
  }

  @Post('imagenes/:tipo/:refId')
  subir(@Param('tipo') tipo: string, @Param('refId', ParseIntPipe) refId: number, @Body() body: any) {
    return this.svc.subirImagen(tipo, refId, body?.data);
  }

  @Delete('imagenes/:tipo/:refId')
  borrar(@Param('tipo') tipo: string, @Param('refId', ParseIntPipe) refId: number) {
    return this.svc.borrarImagen(tipo, refId);
  }
}

@Module({
  controllers: [WebController],
  providers: [WebService],
})
export class WebModule {}

