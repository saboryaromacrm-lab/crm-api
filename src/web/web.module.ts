/**
 * WEB — administración del sitio desde el ERP
 * ============================================================================
 * El módulo Web NO define qué se vende ni a cuánto (eso es de Compras y del
 * formato de venta): administra la CARA del sitio. Sus mutaciones son pocas a
 * propósito:
 *
 *   - Imágenes: foto de producto, imagen de categoría, logo de marca y banner
 *     (tabla `web_imagenes`; el sitio las recibe como URL versionada).
 *   - Los TEXTOS del sitio (hero) van por la configuración general
 *     (`GET/PUT /configuracion/web`) — no necesitan endpoints propios.
 *
 * Qué productos están en el sitio no se decide acá: es la regla de la lista
 * Mayorista que aplica `TiendaService.catalogo()`.
 *
 * LO DE CADA PRODUCTO PARA LA TIENDA VIVE EN COMPRAS › PRODUCTOS (19/10/2026,
 * pedido del dueño): la foto (con la llave de esa sección), el destacado y el
 * mínimo web (`PATCH /productos/:id/tienda`) y cómo se ve en cada tienda
 * (`GET /web/productos/:id`). Ya no hay «Productos del sitio».
 */
import { rutaImagen } from './ruta-imagen';
import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, Injectable,
  Logger, Module, NotFoundException, OnModuleDestroy, OnModuleInit, Param, ParseIntPipe,
  Patch, Post, Query,
} from '@nestjs/common';
import { and, eq, lt } from 'drizzle-orm';
import { Auth, Permiso, Sesion } from '../auth/auth.decoradores';
import { TiendaModule, TiendaService } from '../tienda/tienda.module';
import { tienePermiso } from '../auth/auth.guard';
import { MetricasTiendaService, filtroTienda } from './metricas-tienda';
import { EditarLinkDto, LinkDto, LinksTiendaService } from './links';
import { MIMES_IMAGEN, mimeReal } from '../common/archivos';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  categorias, configuracion, marcas, productos, webEventos, webImagenes,
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
  /* La foto del producto se carga en Compras › Productos (19/10/2026). */
  producto: 'compras.productos',
  categoria: 'web.contenido',
  marca: 'web.contenido',
  banner: 'web.contenido',
  // Los únicos (IMAGENES_UNICAS) usan refId 1: hay uno solo de cada uno.
  logo: 'web.configuracion',
  favicon: 'web.configuracion',
  /* La que se ve al compartir el link del sitio (WhatsApp, Facebook) — 0186. */
  compartir: 'web.configuracion',
};
/** Imágenes de las que hay una sola en todo el sitio: cuelgan siempre del refId 1. */
const IMAGENES_UNICAS = new Set(['logo', 'favicon', 'compartir']);
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
   * correría con la sesión del ERP de quien lo abra. Por eso se contrasta la
   * firma y se guarda lo que los bytes dicen ser, no lo declarado.
   *
   * No le quita nada al uso real: el panel pasa toda imagen por el canvas y
   * exporta WebP (o PNG en Safari) — nunca sube un SVG.
   */
  /**
   * El `refId` al que se cuelga la imagen tiene que EXISTIR. Sin esto, un
   * `POST /web/imagenes/producto/$i` en un `for` de 1 a 5000 dejaba miles de
   * filas de 800 KB colgadas de productos inexistentes, que engordan cada
   * backup para siempre. Las únicas (logo, favicon, compartir): hay una sola
   * de cada una, así que su `refId` es SIEMPRE 1 (y no `logo/2`, `logo/3`… basura).
   * Devuelve el `refId` ya resuelto.
   */
  private async resolverRefId(tipo: string, refId: number): Promise<number> {
    if (IMAGENES_UNICAS.has(tipo)) return 1;
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
    return { ok: true, url: rutaImagen(img.tipo, img.refId, img.actualizadoEn) };
  }

  async borrarImagen(tipo: string, refId: number, sesion: Sesion) {
    this.exigirPermisoDeImagen(tipo, sesion);
    await this.db.delete(webImagenes)
      .where(and(eq(webImagenes.tipo, tipo as any), eq(webImagenes.refId, refId)));
    return { ok: true };
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
  constructor(
    private readonly svc: WebService, private readonly tienda: TiendaService,
    private readonly metricasTienda: MetricasTiendaService, private readonly links: LinksTiendaService,
  ) {}

  /**
   * Lo que ve un cliente habilitado, CON precios (0155): el público
   * `/tienda/catalogo` sale sin plata a quien no ingresó a la tienda, y el ERP no
   * ingresa a la tienda. Lo pide la página entera, así que alcanza cualquier sección.
   */
  @Get('catalogo')
  @Permiso('web.ofertas', 'web.contenido', 'web.estadisticas', 'web.configuracion')
  catalogo() { return this.tienda.catalogoCompleto(); }

  /** Tienda online › Métricas (0179): por modo y período, con el período anterior para comparar. */
  @Get('metricas')
  @Permiso('web.estadisticas')
  metricas(@Query() q: Record<string, any>) { return this.metricasTienda.metricas(filtroTienda(q)); }

  /**
   * «Empezar de 0» las métricas de una tienda (0194): borra su telemetría y
   * las métricas cuentan desde ahora. Solo el superadmin, y confirmado dos veces.
   */
  @Post('metricas/reiniciar')
  @Permiso('web.estadisticas')
  reiniciarMetricas(@Body() body: any, @Auth() sesion: Sesion) {
    if (!sesion?.permisos?.includes('*')) throw new ForbiddenException('Empezar de 0 las métricas es exclusivo del superadmin.');
    if (body?.confirmado !== true) throw new BadRequestException('Falta confirmar.');
    const { modo } = filtroTienda({ modo: body?.modo });
    return this.metricasTienda.reiniciar(modo, sesion?.usuarioId ?? null);
  }

  /* Links medibles (0195): los del modo con su alcance, crear, renombrar y desactivar, y el día a día de uno. */
  @Get('links')
  @Permiso('web.estadisticas')
  listarLinks(@Query('modo') modo?: string) { return this.links.listar(filtroTienda({ modo }).modo); }

  @Get('links/:id')
  @Permiso('web.estadisticas')
  detalleLink(@Param('id', ParseIntPipe) id: number) { return this.links.detalle(id); }

  @Post('links')
  @Permiso('web.estadisticas')
  crearLink(@Body() dto: LinkDto, @Auth() sesion: Sesion) { return this.links.crear(dto, sesion?.usuarioId ?? null); }

  @Patch('links/:id')
  @Permiso('web.estadisticas')
  editarLink(@Param('id', ParseIntPipe) id: number, @Body() dto: EditarLinkDto) { return this.links.editar(id, dto); }

  /** Cómo se ve un producto en cada tienda (Compras › Productos › pestaña Tienda online). */
  @Get('productos/:id')
  @Permiso('compras.productos')
  vistaProducto(@Param('id', ParseIntPipe) id: number) { return this.tienda.vistaProducto(id); }

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
  imports: [TiendaModule],
  controllers: [WebController],
  providers: [WebService, MetricasTiendaService],
  /* El Asesor comercial (0193) lee las métricas de la tienda. */
  exports: [MetricasTiendaService],
})
export class WebModule {}

