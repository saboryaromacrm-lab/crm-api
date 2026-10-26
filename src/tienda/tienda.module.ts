/**
 * TIENDA — la cara pública del catálogo (sitio web)
 * ============================================================================
 * Todo lo que el sitio Next.js necesita, en un shape chico y sin datos
 * internos (nada de costos, nada de stock por sucursal, nada de otras
 * listas). El entero lleva un solo precio: el de la lista "tienda" (la que
 * apunta la modalidad configurada como mayorista). El granel se vende por
 * opciones, que pueden salir de cualquier lista de esa misma modalidad (la
 * caja de 5 de Mayorista 2, por ejemplo).
 *
 * MÍNIMO DE COMPRA — como en el sitio real: NO cambia el precio, HABILITA el
 * checkout. Se cumple con CUALQUIERA de los dos caminos:
 *   1. Monto total del carrito ≥ `montoMinimoMayorista`.
 *   2. Cada marca/producto con mínimo propio lo cumple en el carrito.
 *
 * El pedido nace como PRESUPUESTO en estado `enviado` (no hay nadie
 * cotizando en el medio): alguien del local lo confirma y lo arma, tal como
 * ya funciona para los pedidos que llegan por WhatsApp.
 *
 * PRECIOS SOLO PARA LOS HABILITADOS (0155, 10/10/2026): sin una sesión válida
 * (`X-Tienda-Sesion`, ver accesos.ts) el catálogo sale SIN NADA DE PLATA y el
 * pedido se rechaza. Se quita acá, en el servidor: ocultarlo en la pantalla y
 * mandarlo igual sería un precio oculto que se lee con F12.
 *
 * DOS MODOS, UNA TIENDA (0173, 16/10/2026, pedido del dueño). Lo de arriba es
 * el modo MAYORISTA. El modo MINORISTA es la misma tienda a precio de mostrador
 * (la lista base de la caja): sin compra mínima, el comprador es su WhatsApp
 * —desde 0178 ingresa con él para ver precios (`X-Tienda-Sesion-Min`, ver
 * accesos.ts)— y el envío puede ser gratis desde un monto. Cada modo arma su catálogo y lo guarda unos segundos (`CacheCorto`):
 * cien visitantes son una sola armada.
 */
import {
  BadRequestException, Body, Controller, Get, Headers, Inject, Injectable, Module,
  NotFoundException, Param, ParseIntPipe, Post, Query, Res, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { RateLimit, TiendaRateLimitGuard } from './rate-limit.guard';
import { CacheCorto } from './cache';
import { MULTI_UNIDAD, totalConOferta } from './oferta-linea';
import { Publico } from '../auth/auth.decoradores';
import { MIMES_IMAGEN } from '../common/archivos';
import { telefonoArgentino } from '../common/telefono';
import { fechaQr as fechaArgentina } from '../arca/fecha';
import type { Response } from 'express';
import { and, eq, gte, lte, ne, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  categorias, subcategorias, etiquetas, marcas, movimientos, presentaciones, productoEtiquetas, productoListas,
  productoProveedores, productos, stock, sucursales, tiendaCompradores, tipoImagenWebEnum, webEventos, webImagenes,
  feriados, feriadoSucursales,
} from '../db/schema';
import { costoNetoPresentacion, costoPrecioEntry, formatoActivo, formatoDeCosto, precioVentaFila } from '../inventario/pricing';
import { ofertaAlcanza, valeElDia } from '../ventas/ventas.module';
import { ListasModule } from '../listas/listas.module';
import { ListasService } from '../listas/listas.module';
import { ConfiguracionModule, ConfiguracionService } from '../configuracion/configuracion.module';
import { PresupuestosModule } from '../presupuestos/presupuestos.module';
import { ClientesModule } from '../clientes/clientes.module';
import { AccesosTiendaService, type Comprador } from './accesos';
import { AccesosTiendaController } from './accesos.controller';
import { PresupuestosService } from '../presupuestos/presupuestos.module';
import { OfertasModule, OfertasService } from '../ofertas/ofertas.module';
import { stockSinControl } from '../inventario/inventario.service';
import { rutaImagen } from '../web/ruta-imagen';
import { BarriosModule, BarriosService } from './barrios/barrios.module';
import { CuponesModule, CuponesService } from '../cupones/cupones.module';
import { finalDe, MEDIOS_TIENDA, mejorPorMedio } from '../cupones/reglas';
import { VistaPreviaController, VistaPreviaService } from './vista-previa';
import { describirPromo, puntoValido } from './barrios/reglas';
import { clasificarLlegada } from '../web/origen-llegada';
import { LinksTiendaService } from '../web/links';
import { DIAS_BUSQUEDA, agendaEnvios, cuandoDe, excepcionesDe, localDeEnvios } from './horario-envio';

const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
/** Kilos y paquetes a 3 decimales: 0.1 + 0.2 no da 0.3. */
const r3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;
/** «500 g», «1 kg», «2,5 kg»: como se lee en la etiqueta. */
/** La llegada de una sesión (0194): canal y detalle, clasificados acá con lo que mandó el sitio. */
const origenDe = (e: any) => {
  const { origen, detalle } = clasificarLlegada({
    referente: e.referente, utmSource: e.utmSource, utmMedium: e.utmMedium, utmCampaign: e.utmCampaign, clic: e.clic, meta: e.meta === true, propio: e.propio,
  });
  return { origen, origenDetalle: detalle || null };
};
const textoKg = (kg: number) => (kg < 1 ? `${Math.round(kg * 1000)} g` : `${String(r3(kg)).replace('.', ',')} kg`);

/** Últimos N días para considerar un producto "recién reingresado" (stock de nuevo > 0). */
const DIAS_REINGRESO = 14;

/** Renglones máximos de un pedido del sitio. Es el único endpoint público que ESCRIBE. */
const MAX_RENGLONES_PEDIDO = 100;

/** Cabecera con el token del aparato que ingresó a la tienda (0155). */
const SESION = 'x-tienda-sesion';
/** La del comprador minorista (0178): otra cookie, otra cabecera — una sesión no abre el otro modo. */
const SESION_MIN = 'x-tienda-sesion-min';
/** La de la vista previa (20/10/2026): con ella se ven las tiendas en preparación. */
const VISTA_PREVIA = 'x-tienda-vista-previa';

/** Los dos modos de la tienda (0173). */
type Modo = 'mayorista' | 'minorista';
/** Cuánto vive el catálogo armado: un precio nuevo tarda a lo sumo esto en verse. */
const CATALOGO_TTL_MS = 15_000;

/**
 * EL CATÁLOGO DEL QUE NO INGRESÓ (0155): el mismo, sin nada de plata —precios,
 * ofertas, ahorros, montos mínimos ni la lista—. Las cantidades (stock, mínimos
 * en unidades) quedan: no son precio. La COMPRA MÍNIMA también queda (pedido del
 * dueño: el cartel de bienvenida la anuncia a todos); del piso del envío sin
 * costo queda solo SI hay uno.
 */
export function sinPrecios(cat: any) {
  const limpiar = ({ precio, oferta, precioKg, precioPaquete, ahorroPct, ahorroMinorista, ...resto }: any) => resto;
  return {
    ...cat, conPrecios: false, cliente: null, listaId: null, listaNombre: '', montoMinimoCamioneta: 0,
    hayMinimoEnvio: Number(cat.montoMinimoCamioneta) > 0,
    items: cat.items.map((it: any) => ({ ...limpiar(it), ...(it.variantes ? { variantes: it.variantes.map(limpiar) } : {}) })),
  };
}

/**
 * ¿La oferta está vigente ahora, en esta sucursal? Misma regla que el motor
 * del POS (`crm-dashboard/src/modules/ventas/domain/ofertas.js`, `ofertaVigente`):
 * duplicada acá porque son proyectos separados, no porque la regla cambie.
 */
function ofertaVigente(o: any, sucursalId: number | null) {
  if (!o.activa) return false;
  const t = new Date();
  if (o.desde && t < new Date(o.desde)) return false;
  if (o.hasta && t > new Date(o.hasta)) return false;
  if (!valeElDia(o.dias, t)) return false;
  if (o.sucursales && sucursalId != null) {
    const ids = String(o.sucursales).split(',').map((x: string) => x.trim()).filter(Boolean);
    if (ids.length && !ids.includes(String(sucursalId))) return false;
  }
  return true;
}

/** Cartel de la promo — mismo texto que `describirOferta` del panel de Ofertas. */
function describirOferta(o: any) {
  switch (o.tipo) {
    case 'porcentaje': return `${o.porcentaje}% OFF`;
    case 'precio_fijo': return 'Precio especial';
    case 'nxm': return `${o.lleva}×${o.paga}`;
    case 'segunda_unidad': return `2ª unidad ${o.porcentaje}% OFF`;
    case 'pack': return `${o.lleva} x $${o.precio}`;
    default: return o.nombre;
  }
}

/** Precio final con la promo aplicada, cuando la mecánica define un único precio por unidad. */
function precioConOferta(o: any, precioFinal: number): number | null {
  if (o.tipo === 'porcentaje') return money(precioFinal * (1 - o.porcentaje / 100));
  if (o.tipo === 'precio_fijo') return money(o.precio);
  return null; // nxm / segunda_unidad / pack: el cartel avisa, el precio unitario no cambia.
}

/** Formas de entrega que el sitio ofrece; cualquier otra cosa cae a retiro. */
const ENTREGAS_TIENDA = ['retiro', 'cadete', 'camioneta'] as const;
type EntregaTienda = (typeof ENTREGAS_TIENDA)[number];
/** En el modo minorista: retiro en el local o envío a domicilio (por dentro, el cadete). */
const ENTREGAS_MINORISTA: Record<string, EntregaTienda> = { retiro: 'retiro', envio: 'cadete' };

/** El descuento del barrio (0185) va en los renglones SIN oferta: uno en oferta ya tiene su beneficio y no se suman, como en la caja. */
const conDescuentoBarrio = (items: any[], pct: number) => (pct > 0 ? items.map((it) => (it.ofertaId ? it : { ...it, descuento: pct })) : items);
/** Cuánto descuenta ese %, en pesos finales. */
const montoDescuento = (items: any[], pct: number) => money(
  items.filter((it) => !it.ofertaId).reduce((s, it) => s + it.cantidad * it.precioLista * (1 + it.iva / 100), 0) * pct / 100,
);

/** El medio de pago que eligió el cliente (0190): solo los que la tienda coordina; cualquier otra cosa, ninguno. */
const medioDeTienda = (m: unknown) => ((MEDIOS_TIENDA as readonly string[]).includes(String(m)) ? String(m) as (typeof MEDIOS_TIENDA)[number] : null);

/** Un descuento automático (0199) como lo muestra el checkout. */
const resumenAutomatico = (e: { cupon: { codigo: string; descripcion: string; tipo: string; valor: number }; resultado: { descuento: number; envioGratis: boolean } }) => ({
  codigo: e.cupon.codigo, descripcion: e.cupon.descripcion, porcentaje: e.cupon.tipo === 'porcentaje' ? e.cupon.valor : null,
  descuento: e.resultado.descuento, envioGratis: e.resultado.envioGratis,
});

/** Topes de largo de la dirección: el `maxLength` del checkout no protege al POST directo. */
const MAX_CALLE = 120;
const MAX_LOCALIDAD = 80;
const MAX_REFERENCIA = 200;

/**
 * La DIRECCIÓN DE ENTREGA del pedido, saneada, o `null` si es retiro.
 *
 * Es obligatoria con envío (`cadete` / `camioneta`): antes el pedido llegaba
 * sin domicilio y dependía de que el cliente lo escribiera en las notas o de
 * pedírselo después por WhatsApp — el cadete salía sin saber a dónde.
 */
export function direccionDeEntrega(entrega: EntregaTienda, cruda: any): {
  direccion: string; localidad: string; referencia: string;
} | null {
  if (entrega === 'retiro') return null;
  const d = cruda ?? {};
  const direccion = String(d.calle ?? '').trim().slice(0, MAX_CALLE);
  const localidad = String(d.localidad ?? '').trim().slice(0, MAX_LOCALIDAD);
  const referencia = String(d.referencia ?? '').trim().slice(0, MAX_REFERENCIA);
  if (!direccion || !localidad) {
    throw new BadRequestException('Para el envío necesitamos la dirección: calle y número, y el barrio o localidad.');
  }
  return { direccion, localidad, referencia };
}

/** El catálogo armado y, aparte, lo que solo usa el pedido para validar stock (no se publica). */
type Armado = {
  catalogo: any;
  pozos: Map<number, { sinTope: boolean; granelKg: number; armados: Map<number, number>; unidades?: number }>;
  listaDeOpcion: Map<string, { id: number; nombre: string }>;
};

@Injectable()
export class TiendaService {
  /** Un catálogo armado por modo, vivo `CATALOGO_TTL_MS`. */
  private readonly cache = new CacheCorto<Armado>(CATALOGO_TTL_MS);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly listas: ListasService,
    private readonly cfg: ConfiguracionService,
    private readonly presupuestos: PresupuestosService,
    private readonly ofertasSvc: OfertasService,
    private readonly accesos: AccesosTiendaService,
    private readonly barrios: BarriosService,
    private readonly vistaPrevia: VistaPreviaService,
    private readonly cupones: CuponesService,
    private readonly links: LinksTiendaService,
  ) {}

  /** La sucursal que surte al sitio. Hoy es la Distribuidora (depósito central). */
  private async sucursalTienda() {
    const [dist] = await this.db.select().from(sucursales).where(eq(sucursales.tipo, 'distribuidora')).limit(1);
    if (dist) return dist;
    const [cualquiera] = await this.db.select().from(sucursales).limit(1);
    return cualquiera;
  }

  /** El modo que se va a servir: minorista solo si está encendido en el ERP; cualquier otra cosa, mayorista. */
  /**
   * QUÉ TIENDAS VE QUIEN PIDE (20/10/2026): las abiertas al público y, con la
   * vista previa, también las que están en preparación; la minorista apagada no
   * la ve nadie. `publica`: si está abierta al público (si no, lo que se compre
   * ahí es de prueba).
   */
  private async visibles(previa?: string) {
    const [cfg, conPrevia] = await Promise.all([this.cfg.get('ventas'), this.vistaPrevia.valida(previa)]);
    const existe: Record<Modo, boolean> = { mayorista: true, minorista: cfg.tiendaMinoristaActiva !== false };
    const publica: Record<Modo, boolean> = {
      mayorista: cfg.tiendaMayoristaPublica !== false,
      minorista: existe.minorista && cfg.tiendaMinoristaPublica !== false,
    };
    const ve: Record<Modo, boolean> = {
      mayorista: publica.mayorista || conPrevia,
      minorista: existe.minorista && (publica.minorista || conPrevia),
    };
    return { publica, ve };
  }

  /** El modo que se sirve: el pedido si se ve; si no, el otro; null = ninguna tienda abierta para quien pide. */
  private async modoVigente(pedido: string | undefined, previa?: string) {
    const v = await this.visibles(previa);
    const pedidoModo: Modo = pedido === 'minorista' ? 'minorista' : 'mayorista';
    const otro: Modo = pedidoModo === 'minorista' ? 'mayorista' : 'minorista';
    return { modo: v.ve[pedidoModo] ? pedidoModo : v.ve[otro] ? otro : null, v };
  }

  /** Para comprar en un modo, tiene que verse. Devuelve si el pedido es de PRUEBA (la tienda está en preparación). */
  private async exigirAbierta(modo: Modo, previa?: string): Promise<boolean> {
    const { ve, publica } = await this.visibles(previa);
    if (!ve[modo]) {
      throw new BadRequestException(modo === 'minorista' ? 'La compra minorista no está disponible por ahora.' : 'La tienda todavía no está abierta.');
    }
    return !publica[modo];
  }

  /** El catálogo armado del modo, de la caché (o armado ahora si no hay copia). */
  private armado(modo: Modo) { return this.cache.get(modo, () => this.armarCatalogo(modo)); }

  /**
   * El catálogo PÚBLICO del sitio, sin los datos internos de stock.
   *   · Minorista: siempre con precios, sin cliente (el comprador se identifica al pedir).
   *   · Mayorista: con sesión válida, con precios y los datos del cliente para
   *     el checkout; sin ella, sin nada de plata (`sinPrecios`).
   */
  async catalogo(token?: string, modoPedido?: string, tokenMin?: string, previa?: string) {
    const { modo, v } = await this.modoVigente(modoPedido, previa);
    /* Ninguna tienda abierta para quien pide: solo lo necesario para la página de «Próximamente». */
    if (!modo) {
      const { logoUrl, contacto, seo } = (await this.armado('mayorista')).catalogo.sitio;
      return { cerrada: true, sitio: { logoUrl, contacto, seo } };
    }
    /* Lo que depende de quien mira va encima del catálogo compartido: si elige modo y si ve una tienda en preparación. */
    const deQuienMira = { minoristaActiva: v.ve.mayorista && v.ve.minorista, vistaPrevia: !v.publica[modo] };
    if (modo === 'minorista') {
      /* También con ingreso (0178): sin sesión minorista, sin nada de plata, como la mayorista. */
      const [arm, c] = await Promise.all([this.armado('minorista'), this.accesos.sesionMinorista(tokenMin)]);
      const cat = { ...arm.catalogo, ...deQuienMira, conPrecios: true, cliente: null };
      return c ? { ...cat, comprador: this.accesos.datosMinorista(c) } : sinPrecios(cat);
    }
    const [completo, s] = await Promise.all([this.catalogoCompleto(), this.accesos.sesion(token)]);
    const cat = { ...completo, ...deQuienMira };
    return s ? { ...cat, cliente: await this.accesos.datosCheckout(s) } : sinPrecios(cat);
  }

  /**
   * CÓMO SE VE UN PRODUCTO EN CADA TIENDA (19/10/2026, Compras › Productos ›
   * Tienda online): del mismo catálogo armado que ve el cliente, así que la
   * regla de publicación no se escribe dos veces. null = no está en esa tienda.
   */
  async vistaProducto(id: number) {
    const [may, min] = await Promise.all([this.armado('mayorista'), this.armado('minorista')]);
    const vista = (arm: Armado) => {
      const it = arm.catalogo.items.find((x: any) => x.id === id);
      return it ? {
        precio: it.precio, unidad: it.unidad, enStock: !!it.enStock,
        opciones: it.variantes?.length ?? 0, oferta: it.oferta?.badge ?? null,
      } : null;
    };
    return { mayorista: vista(may), minorista: vista(min) };
  }

  /** El catálogo mayorista CON precios, tal cual lo ve un cliente habilitado: el de Tienda online del ERP (`GET /web/catalogo`). */
  async catalogoCompleto() {
    return { ...(await this.armado('mayorista')).catalogo, conPrecios: true, cliente: null };
  }

  /**
   * El catálogo del modo y, aparte, el POZO de cada granel (granel suelto
   * utilizable y paquetes armados), que solo usa el pedido para validar el
   * stock entre opciones del mismo producto. El pozo no se publica.
   */
  private async armarCatalogo(modo: Modo): Promise<Armado> {
    const minorista = modo === 'minorista';
    const suc = await this.sucursalTienda();
    const desdeReingreso = new Date(Date.now() - DIAS_REINGRESO * 86400000);
    const [prods, provs, filas, petiq, ms, cs, ets, existencias, cat, cfg, ofertasActivas, ingresosRecientes, imgs, web, subs, press] = await Promise.all([
      /* El sitio no publica ARCHIVADOS, tengan precio mayorista o no: el estado
       * corta antes que el criterio de publicación. El discontinuado se sigue
       * ofreciendo mientras tenga stock — el `webStockMin` ya lo saca de la web
       * cuando conviene guardar lo último para el mostrador. */
      this.db.select().from(productos)
        /* Lo de uso exclusivo de Coffit no se publica nunca (19/10/2026, exclusivoCoffit.ts). */
        .where(and(ne(productos.estado, 'archivado'), eq(productos.soloCafeteria, false))).orderBy(productos.nombre),
      this.db.select().from(productoProveedores),
      this.db.select().from(productoListas),
      this.db.select().from(productoEtiquetas),
      this.db.select({ id: marcas.id, nombre: marcas.nombre }).from(marcas),
      this.db.select({ id: categorias.id, nombre: categorias.nombre }).from(categorias),
      this.db.select({ id: etiquetas.id, nombre: etiquetas.nombre }).from(etiquetas),
      /* TODO el disponible de la sucursal: el del producto (granel en kg,
       * entero en unidades) y el de cada paquete fraccionado (3/10/2026: el
       * sitio vende los paquetes del granel). */
      suc
        ? this.db.select().from(stock).where(and(eq(stock.sucursalId, suc.id), eq(stock.estado, 'disponible')))
        : Promise.resolve([] as any[]),
      this.listas.catalogo(),
      this.cfg.get('ventas'),
      this.ofertasSvc.activas(),
      suc
        ? this.db.select({ productoId: movimientos.productoId }).from(movimientos)
          .where(and(
            eq(movimientos.sucursalId, suc.id), eq(movimientos.tipo, 'compra'),
            gte(movimientos.fecha, desdeReingreso),
          ))
        : Promise.resolve([] as any[]),
      // Solo los METADATOS de las imágenes: el binario se sirve por su endpoint.
      this.db.select({ tipo: webImagenes.tipo, refId: webImagenes.refId, actualizadoEn: webImagenes.actualizadoEn })
        .from(webImagenes),
      this.cfg.get('web'),
      // Las subcategorías (2/10/2026): el menú de Categorías del sitio las muestra debajo de cada una.
      this.db.select({ id: subcategorias.id, nombre: subcategorias.nombre, categoriaId: subcategorias.categoriaId }).from(subcategorias),
      // Los paquetes fraccionados: el granel se vende por ellos (3/10/2026).
      this.db.select({ id: presentaciones.id, productoId: presentaciones.productoId, tamKg: presentaciones.tamKg }).from(presentaciones),
    ]);

    /** URL de una imagen subida ('' si no hay): `rutaImagen`, la misma regla que el ERP. */
    const imgMap = new Map(imgs.map((i) => [`${i.tipo}:${i.refId}`, i.actualizadoEn]));
    const urlImagen = (tipo: string, refId: number) => {
      const v = imgMap.get(`${tipo}:${refId}`);
      return v ? rutaImagen(tipo, refId, v) : '';
    };

    const reingresados = new Set(ingresosRecientes.map((m: any) => m.productoId));

    const nombreMarca = new Map(ms.map((m) => [m.id, m.nombre]));
    const nombreCategoria = new Map(cs.map((c) => [c.id, c.nombre]));
    const subcategoriaDe = new Map(subs.map((s) => [s.id, s]));
    const nombreEtiqueta = new Map(ets.map((e) => [e.id, e.nombre]));
    const etiquetasDe = new Map<number, number[]>();
    for (const e of petiq) {
      const arr = etiquetasDe.get(e.productoId);
      if (arr) arr.push(e.etiquetaId); else etiquetasDe.set(e.productoId, [e.etiquetaId]);
    }
    /** Disponible por (producto, paquete); paquete null = el producto (granel en kg, entero en unidades). */
    const stockPorClave = new Map<string, number>();
    for (const s of existencias) {
      const k = `${s.productoId}:${s.presentacionId ?? ''}`;
      stockPorClave.set(k, (stockPorClave.get(k) ?? 0) + s.cantidad);
    }
    const stockDe = (productoId: number, presentacionId: number | null) => stockPorClave.get(`${productoId}:${presentacionId ?? ''}`) ?? 0;
    const presPorProducto = new Map<number, any[]>();
    for (const pr of press) {
      const arr = presPorProducto.get(pr.productoId);
      if (arr) arr.push(pr); else presPorProducto.set(pr.productoId, [pr]);
    }

    const activas = (cat.listas ?? []).filter((l: any) => l.activa);
    /*
     * LA TIENDA MAYORISTA ES LA MODALIDAD MAYORISTA, CON TODAS SUS LISTAS (3/10/2026,
     * pedido del dueño: «tiene que mostrar sí o sí la llamada Mayorista, y
     * dentro de esa las que tienen creadas»). La modalidad es la configurada
     * para el mínimo por monto o, si no hay, la que se llama «Mayorista». La
     * «lista de la tienda» es la primera de esa modalidad por orden; ya no
     * decide qué se publica (eso lo deciden todas las listas de la modalidad),
     * solo cuál gana cuando dos venden igual.
     *
     * LA MINORISTA (0173) es la lista base de la caja —el precio de mostrador—
     * y nada más. Sin lista base configurada, la primera que NO sea de la
     * modalidad mayorista: un precio de distribuidora nunca se publica como minorista.
     */
    const modalidades = (cat.modalidades ?? []).filter((m: any) => m.activa !== false);
    const conListas = (m: any) => !!m && activas.some((l: any) => l.modalidadId === m.id);
    const modalidadMayorista = [modalidades.find((m: any) => m.id === cfg.modalidadMontoId), modalidades.find((m: any) => /mayorista/i.test(String(m.nombre)))]
      .find(conListas) ?? null;
    const listaBase = activas.find((l: any) => l.id === cfg.listaBaseId)
      ?? activas.find((l: any) => l.modalidadId !== modalidadMayorista?.id) ?? null;
    const listaTienda = minorista ? listaBase
      : (modalidadMayorista ? activas.find((l: any) => l.modalidadId === modalidadMayorista.id) : null) ?? listaBase ?? activas[0] ?? null;

    // Ofertas de vidriera vigentes: solo mecánicas de UN producto (combo/ticket no aplican al catálogo).
    /*
     * LAS LISTAS DE LA OFERTA, COMO EN LA CAJA (16/10/2026, pedido del dueño):
     * «solo sobre las tildadas: un renglón cotizado con otra lista no recibe la
     * promo». Cada opción del sitio se cotiza con UNA lista (la de mostrador en
     * minorista; Mayorista 1 o la caja de Mayorista 2 en mayorista) y recibe la
     * oferta si no tiene listas o si la tiene tildada. Antes el mayorista
     * descartaba toda oferta con listas, aunque fuera justo la de la opción.
     */
    const ofertasWeb = ofertasActivas
      .filter((o: any) => o.tipo !== 'combo' && o.tipo !== 'ticket' && ofertaVigente(o, suc?.id ?? null))
      .map((o: any) => ({ ...o, listasSet: new Set(String(o.listas ?? '').split(',').map((x: string) => Number(x.trim())).filter(Boolean)) }));

    /** Minorista (0185): los avisos de las promos de hoy y el cartel de envío gratis por barrio. */
    const barriosPortada = minorista ? await this.barrios.portada() : null;
    /**
     * Contenido editable del sitio (módulo Web): slides de la portada, logo,
     * favicon y los datos de contacto/redes del footer.
     */
    const sitio = {
      slides: (web.slides ?? []).map((sl: any) => ({ ...sl, bannerUrl: urlImagen('banner', sl.id) })),
      logoUrl: urlImagen('logo', 1),
      faviconUrl: urlImagen('favicon', 1),
      contacto: {
        whatsapp: String(web.whatsapp ?? ''),
        telefono: String(web.contactoTelefono ?? ''),
        email: String(web.contactoEmail ?? ''),
        ubicacion: String(web.contactoUbicacion ?? ''),
        instagram: String(web.redInstagram ?? ''),
        facebook: String(web.redFacebook ?? ''),
      },
      /** Lo que ven Google y quien recibe el link (20/10/2026): Tienda online › Configuración › General. */
      seo: {
        titulo: String(web.seoTitulo ?? ''),
        descripcion: String(web.seoDescripcion ?? ''),
        imagenUrl: urlImagen('compartir', 1),
      },
      /** Los locales con su horario por día ('' = cerrado): el pie del sitio y la ficha de comercio para Google. */
      locales: (web.locales as Array<Record<string, string>>).filter((l) => l.nombre || l.direccion),
      /** Quiénes somos y las preguntas frecuentes (20/10/2026): /nosotros y /llms.txt, lo que leen Google y las IA. */
      nosotros: {
        texto: String(web.nosotrosTexto ?? ''),
        faq: (web.faq as Array<Record<string, string>>).filter((f) => f.pregunta && f.respuesta),
      },
      /** El cartel de bienvenida (3/10/2026): editable en Web › Configuración del sitio. */
      popup: {
        activo: web.popupActivo !== false,
        etiqueta: String(web.popupEtiqueta ?? ''),
        titulo: String(web.popupTitulo ?? ''),
        texto: String(web.popupTexto ?? ''),
      },
      /** La portada minorista (17/10/2026): sus textos, editables en Tienda online › Configuración › Tienda minorista. */
      minorista: {
        /* Las promos por barrio de hoy van primero (0185): «🚚 Hoy: Envío gratis a Independencia». */
        avisos: [...(barriosPortada?.avisos ?? []), ...(web.minAvisos as string[])],
        /** El cartel de envío gratis por barrio (0185): vacío = no se muestra. */
        enviosGratis: barriosPortada?.enviosGratis ?? [],
        hero: {
          eyebrow: String(web.minHeroEyebrow ?? ''), titulo: String(web.minHeroTitulo ?? ''), texto: String(web.minHeroTexto ?? ''),
          cta1: { texto: String(web.minHeroCta1 ?? ''), url: String(web.minHeroCta1Url ?? '/') },
          cta2: { texto: String(web.minHeroCta2 ?? ''), url: String(web.minHeroCta2Url ?? '/') },
        },
        sellos: web.minSellos as string[],
        beneficios: { titulo: String(web.minBeneficiosTitulo ?? ''), items: web.minBeneficios as Array<{ icono: string; titulo: string; texto: string }> },
        cierre: { titulo: String(web.minCierreTitulo ?? ''), texto: String(web.minCierreTexto ?? ''), cta: String(web.minCierreCta ?? '') },
      },
    };

    /** La compra mínima mayorista (0 = sin mínimo por monto): la regla del modo y, en los dos, lo que dice el cartel de elegir modo. */
    const minimoMayorista = Number(cfg.montoMinimoMayorista) > 0 ? Number(cfg.montoMinimoMayorista) : 0;
    /** Lo que es del modo, no del catálogo: mínimos, entregas, el modo mismo. */
    const reglasModo = minorista
      ? { modo, montoMinimo: 0, montoMinimoCamioneta: 0, envioCamionetaActivo: false, reglasMarca: [] as any[] }
      : {
        modo,
        /** 0 = sin mínimo por monto configurado (solo rigen los de marca/producto, si hay). */
        montoMinimo: minimoMayorista,
        /** Piso EXTRA si la entrega es el envío sin costo (la camioneta; 0 = sin piso). */
        montoMinimoCamioneta: Number(cfg.montoMinimoCamioneta) > 0 ? Number(cfg.montoMinimoCamioneta) : 0,
        /** El envío sin costo se ofrece (Tienda online › Configuración › Tienda mayorista). */
        envioCamionetaActivo: cfg.envioCamionetaActivo !== false,
        reglasMarca: (cat.reglasMarca ?? [])
          .filter((r: any) => r.activa && r.unidadesMinimas > 0)
          .map((r: any) => ({ marcaId: r.marcaId, marca: r.marca, unidadesMinimas: r.unidadesMinimas })),
      };
    const comun = {
      sucursalId: suc?.id ?? null,
      ...reglasModo,
      /** El cartel de elegir modo dice desde cuánto compra el mayorista (17/10/2026), aunque se esté en minorista. */
      minimoMayorista,
      /** Minorista: envío gratis desde este monto (0 = se coordina). */
      envioGratisDesde: minorista && Number(cfg.tiendaMinoristaEnvioGratisDesde) > 0 ? Number(cfg.tiendaMinoristaEnvioGratisDesde) : 0,
      /** Minorista (0185): la clave de Google Maps del navegador; vacía = el checkout sin mapa, como antes. */
      mapsKey: minorista ? String(cfg.tiendaMinoristaMapsKey ?? '') : '',
      /** Catálogo sin fotos: la tienda lista los productos en vez de mostrar tarjetas. */
      vistaLista: cfg.tiendaVistaLista === true,
      presupuestoValidezDias: Number(cfg.presupuestoValidezDias) || 7,
      sitio,
    };
    const vacio = { ...comun, listaId: null, listaNombre: '', categorias: [], marcas: [], etiquetas: [], items: [] };
    if (!listaTienda) return { catalogo: vacio, pozos: new Map(), listaDeOpcion: new Map() };
    /** El mínimo de compra de una fila, en el modo: el minorista no tiene mínimos. */
    const minimo = (n: number) => (minorista ? 0 : n);

    /*
     * PRE-ÍNDICE de las tablas hijas, un solo pase cada una. Sin esto, adentro
     * del loop de productos había un `filas.find` sobre `productoListas` entera
     * y un `provs.filter` sobre `productoProveedores` entera POR CADA producto:
     * O(productos × filas). En un endpoint público que además corre en cada
     * pedido, con el catálogo grande son millones de comparaciones. El `.has`
     * conserva el "primer match" que hacía `.find` (hay una sola fila por
     * producto en la lista de la tienda, pero por las dudas).
     */
    /*
     * EL GRANEL (y desde el 3/10 también el entero) MIRA TODAS LAS LISTAS DE LA MODALIDAD DE LA TIENDA (3/10/2026,
     * pedido del dueño): un paquete puede venderse «por 1» en Mayorista 1 y
     * «caja de 5» en Mayorista 2, y el sitio ofrece las dos formas. Primero la
     * lista de la tienda y después las otras por su orden: ante dos filas que
     * venden IGUAL (mismas unidades) gana la primera, así una lista «por 1»
     * más barata —la de un cliente con contrato— no se publica para todos.
     */
    const listasGranel = minorista ? [listaTienda] : activas
      .filter((l: any) => l.modalidadId === listaTienda.modalidadId)
      .sort((a: any, b: any) => (a.id === listaTienda.id ? -1 : b.id === listaTienda.id ? 1 : 0)
        || (a.orden ?? 0) - (b.orden ?? 0) || (a.numero ?? 0) - (b.numero ?? 0) || a.id - b.id);
    const rangoLista = new Map<number, number>(listasGranel.map((l: any, i: number): [number, number] => [l.id, i]));
    /*
     * EL PRECIO MINORISTA, PARA DECIR CUÁNTO SE AHORRA (3/10/2026, pedido del
     * dueño): la lista base de la caja —el precio de mostrador—, la misma regla
     * que el catálogo del POS. Solo en el modo mayorista y si es de otra
     * modalidad que la tienda (si la base fuera la mayorista, no hay contra qué comparar).
     */
    const comparaMinorista = !minorista && !!listaBase && listaBase.modalidadId !== listaTienda.modalidadId;
    const filaMinoristaProducto = new Map<number, any>();
    const filaMinoristaPres = new Map<number, any>();
    if (comparaMinorista) {
      for (const f of filas) {
        if (f.listaId !== listaBase.id) continue;
        if (f.presentacionId == null) filaMinoristaProducto.set(f.productoId, f);
        else filaMinoristaPres.set(f.presentacionId, f);
      }
    }
    type FilaLista = { fila: any; lista: { id: number; nombre: string } };
    const filasGranelProducto = new Map<number, FilaLista[]>();
    /** Las filas de cada PAQUETE (3/10/2026): el granel se vende por ellos. */
    const filasGranelPres = new Map<number, FilaLista[]>();
    for (const f of filas) {
      if (!rangoLista.has(f.listaId)) continue;
      const l = listasGranel[rangoLista.get(f.listaId)!];
      const x = { fila: f, lista: { id: l.id, nombre: l.nombre } };
      const mapa = f.presentacionId == null ? filasGranelProducto : filasGranelPres;
      const k = f.presentacionId == null ? f.productoId : f.presentacionId;
      const arr = mapa.get(k);
      if (arr) arr.push(x); else mapa.set(k, [x]);
    }
    for (const arr of [...filasGranelProducto.values(), ...filasGranelPres.values()]) {
      arr.sort((a, b) => rangoLista.get(a.lista.id)! - rangoLista.get(b.lista.id)!);
    }
    const provsPorProducto = new Map<number, any[]>();
    for (const x of provs) {
      const arr = provsPorProducto.get(x.productoId);
      if (arr) arr.push(x); else provsPorProducto.set(x.productoId, [x]);
    }

    const items: any[] = [];
    /**
     * EL POZO DE CADA GRANEL (uso interno del pedido, no viaja al sitio): el
     * granel suelto que el sitio puede usar y los paquetes ya armados de cada
     * tamaño. El pedido lo usa para que dos opciones del mismo producto (la
     * bolsa y los paquetes) no se vendan dos veces los mismos kilos.
     */
    const pozos = new Map<number, { sinTope: boolean; granelKg: number; armados: Map<number, number>; unidades?: number }>();
    /** De qué lista sale cada opción de granel (`productoId:clave`): el pedido la anota en el renglón. No se publica. */
    const listaDeOpcion = new Map<string, { id: number; nombre: string }>();
    for (const p of prods) {
      // La BASE del precio (0072): el sitio publica el mismo precio que el POS.
      const costoNeto = costoPrecioEntry(formatoDeCosto(p, provsPorProducto.get(p.id) ?? []) as any, p.iva);
      const opts = { iva: p.iva, redondeo: p.redondeo ?? cfg.redondeoPrecio };
      /*
       * Sin control de stock (el propio del producto, 0129, o la llave de su
       * tipo): se ofrece siempre y sin tope (`disponible: null`), como en la caja.
       * Con «La tienda solo vende lo que tiene stock», el sitio controla aunque
       * la llave general esté apagada; solo el «nunca controlar» de la ficha manda.
       */
      const sinTope = cfg.tiendaSoloConStock === true ? p.controlStock === false : stockSinControl(cfg, p);
      const etiquetasIds = etiquetasDe.get(p.id) ?? [];
      /**
       * Una promo por opción: la de mayor beneficio entre las que alcanzan, con
       * la MISMA regla de alcance que la caja (`ofertaAlcanza`): a un paquete
       * lo alcanza una oferta de ESE paquete, y las de su producto, marca,
       * categoría o etiqueta solo si la oferta incluye los fraccionados.
       * `precioUnidad` es el precio de UNA unidad del producto (el kilo de la
       * bolsa, un paquete) y `por` cuántas lleva la opción: el precio con la
       * promo es el de la unidad × `por`, igual que lo cobraría la caja.
       * `listaId`: la lista con la que se cotiza la opción (ver `ofertasWeb`).
       *
       * Las de VARIAS UNIDADES (3×2, 2ª unidad, pack) viajan con sus números:
       * el carrito y el pedido las cobran con `totalConOferta`.
       */
      const ofertaDe = (presentacionId: number | null, precioUnidad: number, por: number, listaId: number) => {
        const r = { productoId: p.id, presentacionId, marcaId: p.marcaId, categoriaId: p.categoriaId, etiquetas: etiquetasIds };
        let mejor: any = null;
        let mejorPrecio: number | null = null;
        for (const o of ofertasWeb) {
          if (o.listasSet.size && !o.listasSet.has(listaId)) continue;
          if (!ofertaAlcanza(o, r)) continue;
          const pOferta = precioConOferta(o, precioUnidad);
          if (pOferta != null && (mejorPrecio == null || pOferta < mejorPrecio)) {
            mejor = o; mejorPrecio = pOferta;
          } else if (pOferta == null && !mejor) {
            mejor = o; // nxm / segunda_unidad / pack: sin precio unitario, pero se avisa igual.
          }
        }
        if (!mejor) return null;
        return {
          id: mejor.id, nombre: mejor.nombre, tipo: mejor.tipo, badge: describirOferta(mejor),
          /* NutriRescate (20/10/2026): la promo es para mercadería por vencer (0187) y hasta cuándo vale (= el vencimiento). */
          ...(mejor.porVencer ? { porVencer: true, venceEl: mejor.hasta ? fechaArgentina(new Date(mejor.hasta)) : null } : {}),
          precioOferta: mejorPrecio != null ? money(mejorPrecio * por) : null,
          ...(MULTI_UNIDAD.has(mejor.tipo)
            ? { lleva: Number(mejor.lleva) || 0, paga: Number(mejor.paga) || 0, porcentaje: Number(mejor.porcentaje) || 0, precioPack: Number(mejor.precio) || 0 }
            : {}),
        };
      };
      const base = {
        id: p.id,
        nombre: p.nombre,
        marcaId: p.marcaId,
        marca: p.marcaId ? (nombreMarca.get(p.marcaId) ?? '') : '',
        categoriaId: p.categoriaId,
        categoria: p.categoriaId ? (nombreCategoria.get(p.categoriaId) ?? '') : '',
        /* La subcategoría SOLO si cuelga de la categoría del producto: una que
         * quedó de otra categoría (se cambió la categoría y no la sub) armaría
         * en el menú una rama que no lleva a ningún lado. */
        ...((): { subcategoriaId: number | null; subcategoria: string } => {
          const sc = p.subcategoriaId ? subcategoriaDe.get(p.subcategoriaId) : undefined;
          return sc && sc.categoriaId === p.categoriaId ? { subcategoriaId: sc.id, subcategoria: sc.nombre } : { subcategoriaId: null, subcategoria: '' };
        })(),
        etiquetas: etiquetasIds
          .map((id) => ({ id, nombre: nombreEtiqueta.get(id) ?? '' }))
          .filter((e) => e.nombre),
        tipo: p.tipo,
        iva: p.iva,
        // La imagen subida en el módulo Web manda; la URL externa es el plan B.
        imagenUrl: urlImagen('producto', p.id) || p.imagenUrl || '',
        destacado: !!p.destacado,
      };

      if (p.tipo !== 'granel') {
        /*
         * REGLA DE PUBLICACIÓN DEL ENTERO (módulo Web): está en el sitio si
         * tiene precio cargado en ALGUNA lista de la modalidad Mayorista (3/10:
         * antes solo la primera; si cambiaba el orden, desaparecían todos).
         * Cada forma distinta (unidad, caja x12) es una opción; ante dos listas
         * que venden igual gana la primera por orden. Ni flag manual ni
         * fallback a otra modalidad: publicar = cargarle el precio mayorista.
         */
        const formasE: { fila: any; lista: { id: number; nombre: string }; n: number; pv: any }[] = [];
        {
          const vistos = new Set<number>();
          for (const { fila, lista } of filasGranelProducto.get(p.id) ?? []) {
            const n = Math.max(1, Math.round(Number(fila.unidades) || 1));
            if (vistos.has(n)) continue;
            const pvF = precioVentaFila(costoNeto, fila, opts);
            if (!(pvF.finalUnitario > 0)) continue;
            vistos.add(n);
            formasE.push({ fila, lista, n, pv: pvF });
          }
        }
        // Sin precio real no hay publicación: el pedido se recotizaría a $0.
        if (!formasE.length) continue;
        formasE.sort((x, y) => x.n - y.n);
        const filaTienda = formasE[0].fila;
        const pv = formasE[0].pv;
        if (formasE.length > 1 || formasE[0].n > 1) {
          /* Con más de una forma, o una sola de a N: se elige en la tarjeta, como el granel. */
          const dispE = sinTope ? null : Math.max(0, r3(stockDe(p.id, null) - (p.webStockMin || 0)));
          const masCaroE = Math.max(...formasE.map((f) => f.pv.finalFormato / f.n));
          const variantesE = formasE.map((f) => {
            const clave = `e${f.n}`;
            listaDeOpcion.set(`${p.id}:${clave}`, f.lista);
            const disponible = dispE == null ? null : Math.floor(dispE / f.n + 1e-9);
            const cu = money(f.pv.finalFormato / f.n);
            const pct = masCaroE > 0 ? Math.round(100 * (1 - cu / masCaroE)) : 0;
            const forma = f.n > 1 ? `Caja x${f.n}` : 'Por unidad';
            return {
              clave, presentacionId: null, etiqueta: f.n > 1 ? `Caja x${f.n}` : 'Unidad',
              kgPorUnidad: f.n, paquetesPorUnidad: f.n, unidadesStock: f.n,
              grupo: 'e', grupoEtiqueta: formasE.length === 1 ? forma : '', forma,
              precio: f.pv.finalFormato, precioKg: cu, precioPaquete: cu, ahorroPct: pct >= 1 ? pct : 0,
              unidadesMinimas: minimo((Number(f.fila.unidadesMinimas) || 0) > 0 ? Math.ceil(Number(f.fila.unidadesMinimas) / f.n - 1e-9) : 0),
              enStock: sinTope || (disponible ?? 0) >= 1,
              disponible,
              oferta: ofertaDe(null, f.pv.finalUnitario, f.n, f.lista.id),
              ahorroMinorista: null,
            };
          });
          pozos.set(p.id, { sinTope, granelKg: 0, armados: new Map(), unidades: dispE ?? 0 });
          const v0e = variantesE.find((v) => v.enStock) ?? variantesE[0];
          const enStockE = variantesE.some((v) => v.enStock);
          items.push({
            ...base,
            unidad: 'u',
            precio: v0e.precio,
            unidadesMinimas: v0e.unidadesMinimas,
            enStock: enStockE,
            disponible: v0e.disponible,
            oferta: v0e.oferta,
            reingreso: enStockE && reingresados.has(p.id),
            variantes: variantesE,
          });
          continue;
        }
        listaDeOpcion.set(`${p.id}:`, formasE[0].lista);
        /* Lo que el sitio PUEDE vender: el disponible menos el piso reservado
         * para el mostrador (`webStockMin`). Es el tope del carrito. */
        const disponibleParaWeb = sinTope ? null : Math.max(0, r3(stockDe(p.id, null) - (p.webStockMin || 0)));
        const disponibleWeb = sinTope || (disponibleParaWeb ?? 0) > 1e-9;
        items.push({
          ...base,
          unidad: 'u',
          precio: pv.finalUnitario,
          /** Mínimo de compra PROPIO del producto (0 = sin mínimo). */
          unidadesMinimas: minimo(filaTienda.unidadesMinimas || 0),
          enStock: disponibleWeb,
          disponible: disponibleParaWeb,
          oferta: ofertaDe(null, pv.finalUnitario, 1, formasE[0].lista.id),
          reingreso: disponibleWeb && reingresados.has(p.id),
        });
        continue;
      }

      /*
       * EL GRANEL SE VENDE POR OPCIONES (3/10/2026, pedido del dueño). Ningún
       * granel se vende suelto: el sitio ofrece, en un selector,
       *   · cada PAQUETE fraccionado que tenga su fila en la lista Mayorista;
       *   · la BOLSA CERRADA del producto madre, si el madre tiene su fila en
       *     la lista Mayorista: «Bolsa de N kg», con N = las unidades de ese
       *     formato, y se compra de a bolsas enteras. No la del que es «solo
       *     para fraccionar» (la caja no lo vende y el pedido no se podría cerrar).
       * Sin ninguna opción con precio, el producto no se publica.
       *
       * STOCK: un paquete está disponible si hay paquetes armados O granel para
       * armarlo (al confirmar el pedido el ERP fracciona lo que falte). La
       * bolsa sale del granel. El piso del mostrador (`webStockMin`) se
       * descuenta del granel.
       */
      const granelKg = Math.max(0, r3(stockDe(p.id, null) - (p.webStockMin || 0)));
      const armados = new Map<number, number>();
      const variantes: any[] = [];
      /*
       * LAS OPCIONES SE AGRUPAN POR TAMAÑO (3/10/2026): el cliente elige
       * primero QUÉ lleva (1 kg, Bolsa de 10 kg) y, si ese tamaño se vende de
       * más de una forma, CÓMO (por unidad o en caja de 5), viendo cuánto le
       * sale cada paquete y cuánto ahorra. `grupo` es el tamaño; `forma`, el
       * texto de la forma de compra; `precioPaquete`, lo que sale cada paquete.
       * Cada bolsa del madre es un tamaño propio.
       */
      if (!p.soloFraccionar) {
        const vistos = new Set<number>();
        for (const { fila, lista } of filasGranelProducto.get(p.id) ?? []) {
          const kgBolsa = r3(Number(fila.unidades) || 1);
          if (!(kgBolsa > 0) || vistos.has(kgBolsa)) continue;
          /* Minorista: la fila de mostrador que vende «por 1» es el granel SUELTO,
           * por kilo, que el sitio no vende; la bolsa cerrada es la que vende por N kg. */
          if (minorista && kgBolsa <= 1) continue;
          const pv = precioVentaFila(costoNeto, fila, opts);
          if (!(pv.finalUnitario > 0)) continue;
          vistos.add(kgBolsa);
          const disponible = sinTope ? null : Math.floor(granelKg / kgBolsa + 1e-9);
          const etiqueta = `Bolsa de ${textoKg(kgBolsa)}`;
          const clave = `p${kgBolsa}`;
          listaDeOpcion.set(`${p.id}:${clave}`, lista);
          variantes.push({
            clave, presentacionId: null, etiqueta, kgPorUnidad: kgBolsa,
            grupo: clave, grupoEtiqueta: etiqueta, forma: 'Bolsa cerrada',
            /** Lo que se cobra por bolsa, y el kilo de referencia. */
            precio: pv.finalFormato, precioKg: pv.finalUnitario, precioPaquete: pv.finalFormato, ahorroPct: 0,
            /** El mínimo del formato viene en kilos: en bolsas, redondeado para arriba. */
            unidadesMinimas: minimo((Number(fila.unidadesMinimas) || 0) > 0 ? Math.ceil(Number(fila.unidadesMinimas) / kgBolsa - 1e-9) : 0),
            enStock: sinTope || (disponible ?? 0) >= 1,
            disponible,
            oferta: ofertaDe(null, pv.finalUnitario, kgBolsa, lista.id),
          });
        }
      }
      for (const pres of presPorProducto.get(p.id) ?? []) {
        if (!(pres.tamKg > 0)) continue;
        const hay = Math.max(0, stockDe(p.id, pres.id));
        const paquetes = hay + Math.floor(granelKg / pres.tamKg + 1e-9);
        const tam = textoKg(pres.tamKg);
        const delTamano: any[] = [];
        const vistos = new Set<number>();
        for (const { fila, lista } of filasGranelPres.get(pres.id) ?? []) {
          const porCaja = Math.max(1, Math.round(Number(fila.unidades) || 1));
          if (vistos.has(porCaja)) continue;
          const pv = precioVentaFila(costoNetoPresentacion(costoNeto, pres.tamKg, p.merma), fila, opts);
          if (!(pv.finalUnitario > 0)) continue;
          vistos.add(porCaja);
          const disponible = sinTope ? null : Math.floor(paquetes / porCaja + 1e-9);
          const clave = porCaja > 1 ? `s${pres.id}x${porCaja}` : `s${pres.id}`;
          /* «Por N» se ofrece como BOLSA con el total de kilos (pedido del dueño, 3/10/2026):
           * «Bolsa x5 kg»; el renglón del pedido aclara qué paquetes lleva adentro. */
          const bolsaN = `Bolsa x${textoKg(r3(pres.tamKg * porCaja))}`;
          listaDeOpcion.set(`${p.id}:${clave}`, lista);
          delTamano.push({
            clave, presentacionId: pres.id, etiqueta: porCaja > 1 ? `${bolsaN} (${porCaja} × ${tam})` : tam,
            kgPorUnidad: r3(pres.tamKg * porCaja), paquetesPorUnidad: porCaja,
            grupo: `s${pres.id}`, grupoEtiqueta: tam, forma: porCaja > 1 ? bolsaN : 'Por unidad',
            precio: pv.finalFormato, precioKg: money(pv.finalFormato / (pres.tamKg * porCaja)),
            precioPaquete: money(pv.finalFormato / porCaja),
            unidadesMinimas: minimo((Number(fila.unidadesMinimas) || 0) > 0 ? Math.ceil(Number(fila.unidadesMinimas) / porCaja - 1e-9) : 0),
            enStock: sinTope || (disponible ?? 0) >= 1,
            disponible,
            oferta: ofertaDe(pres.id, pv.finalUnitario, porCaja, lista.id),
          });
        }
        if (!delTamano.length) continue;
        /* Un tamaño que se vende de UNA sola forma y de a N (la Avena 1 kg «vende
         * por 5»): el botón dice lo que se compra —«Bolsa x5 kg»—, no el tamaño
         * del paquete, que haría creer que se lleva 1 kg (3/10/2026, pedido del dueño). */
        if (delTamano.length === 1 && (delTamano[0].paquetesPorUnidad || 1) > 1) delTamano[0].grupoEtiqueta = delTamano[0].forma;
        armados.set(pres.id, hay);
        /* El ahorro de cada forma contra la más cara del mismo tamaño, por paquete y sin promos. */
        const masCaro = Math.max(...delTamano.map((v) => v.precioPaquete));
        for (const v of delTamano) {
          const pct = masCaro > 0 ? Math.round(100 * (1 - v.precioPaquete / masCaro)) : 0;
          v.ahorroPct = pct >= 1 ? pct : 0;
        }
        variantes.push(...delTamano);
      }
      if (!variantes.length) continue;
      /*
       * CUÁNTO SE AHORRA FRENTE AL MINORISTA: el kilo MÁS BARATO al que se
       * puede comprar al por menor este producto (el madre o cualquiera de sus
       * paquetes en la lista minorista) contra el kilo de cada opción, con la
       * promo si tiene. El más barato a propósito: el ahorro que se anuncia
       * nunca está inflado.
       */
      let kgMinorista = Infinity;
      if (comparaMinorista) {
        const fm = filaMinoristaProducto.get(p.id);
        if (fm) {
          const pv = precioVentaFila(costoNeto, fm, opts);
          if (pv.finalUnitario > 0) kgMinorista = Math.min(kgMinorista, pv.finalUnitario);
        }
        for (const pres of presPorProducto.get(p.id) ?? []) {
          const fp = filaMinoristaPres.get(pres.id);
          if (!fp || !(pres.tamKg > 0)) continue;
          const pv = precioVentaFila(costoNetoPresentacion(costoNeto, pres.tamKg, p.merma), fp, opts);
          if (pv.finalUnitario > 0) kgMinorista = Math.min(kgMinorista, pv.finalUnitario / pres.tamKg);
        }
      }
      for (const v of variantes) {
        const kg = (v.oferta?.precioOferta ?? v.precio) / v.kgPorUnidad;
        v.ahorroMinorista = Number.isFinite(kgMinorista) && kgMinorista > kg * 1.005
          ? { pct: Math.round(100 * (1 - kg / kgMinorista)), precioKg: money(kgMinorista), pesos: money((kgMinorista - kg) * v.kgPorUnidad) }
          : null;
      }
      /* Por tamaño (el kilo de su forma más chica) y, adentro, de la forma más chica a la caja más grande. */
      const kgGrupo = new Map<string, number>();
      for (const v of variantes) {
        const kg = v.kgPorUnidad / (v.paquetesPorUnidad || 1);
        kgGrupo.set(v.grupo, Math.min(kgGrupo.get(v.grupo) ?? Infinity, kg));
      }
      variantes.sort((a, b) => kgGrupo.get(a.grupo)! - kgGrupo.get(b.grupo)! || a.grupo.localeCompare(b.grupo)
        || (a.paquetesPorUnidad || 1) - (b.paquetesPorUnidad || 1));
      pozos.set(p.id, { sinTope, granelKg, armados });
      // Lo de la tarjeta, por defecto: la primera opción CON stock (o la primera).
      const v0 = variantes.find((v) => v.enStock) ?? variantes[0];
      const enStock = variantes.some((v) => v.enStock);
      items.push({
        ...base,
        unidad: 'u',
        precio: v0.precio,
        unidadesMinimas: v0.unidadesMinimas,
        enStock,
        disponible: v0.disponible,
        oferta: v0.oferta,
        reingreso: enStock && reingresados.has(p.id),
        /** Las opciones del selector (3/10/2026): bolsa del madre y paquetes con lista mayorista. */
        variantes,
      });
    }

    /*
     * NUTRIRESCATE (20/10/2026, pedido del dueño): el producto está en la
     * sección de lo próximo a vencer si alguna de sus opciones tiene una promo
     * por vencimiento, con la fecha más cercana. Va en el PRODUCTO y no solo en
     * la oferta: sin sesión la oferta no viaja (`sinPrecios`), pero la sección
     * igual muestra qué productos hay, e invita a ingresar para ver el precio.
     */
    for (const it of items) {
      const porVencer = [it.oferta, ...(it.variantes ?? []).map((v: any) => v.oferta)].filter((o: any) => o?.porVencer);
      if (!porVencer.length) continue;
      it.porVencer = true;
      it.venceEl = porVencer.map((o: any) => o.venceEl).filter(Boolean).sort()[0] ?? null;
    }

    /* Lo que no se puede comprar, al final de cada listado (22/10/2026): el orden estable deja todo lo demás como estaba. */
    items.sort((a, b) => Number(!a.enStock) - Number(!b.enStock));

    const contar = (mapa: Map<number, { id: number; nombre: string; count: number }>, id: number | null, nombre: string) => {
      if (!id || !nombre) return;
      const e = mapa.get(id) ?? { id, nombre, count: 0 };
      e.count += 1;
      mapa.set(id, e);
    };
    const catMap = new Map<number, any>(); const marcaMap = new Map<number, any>(); const etiqMap = new Map<number, any>();
    const subMap = new Map<number, any>();
    for (const it of items) {
      contar(catMap, it.categoriaId, it.categoria);
      contar(subMap, it.subcategoriaId, it.subcategoria);
      contar(marcaMap, it.marcaId, it.marca);
      for (const e of it.etiquetas) contar(etiqMap, e.id, e.nombre);
    }
    const porNombre = (a: any, b: any) => a.nombre.localeCompare(b.nombre, 'es');

    const publico = {
      ...comun,
      listaId: listaTienda.id,
      listaNombre: listaTienda.nombre,
      categorias: [...catMap.values()].sort(porNombre)
        .map((c) => ({ ...c, imagenUrl: urlImagen('categoria', c.id) })),
      /** Las subcategorías con productos publicados, con su categoría: el menú las cuelga debajo de cada una. */
      subcategorias: [...subMap.values()].sort(porNombre)
        .map((s) => ({ ...s, categoriaId: subcategoriaDe.get(s.id)?.categoriaId ?? null })),
      marcas: [...marcaMap.values()].sort(porNombre)
        .map((m) => ({ ...m, imagenUrl: urlImagen('marca', m.id) })),
      etiquetas: [...etiqMap.values()].sort(porNombre),
      items,
    };
    return { catalogo: publico, pozos, listaDeOpcion };
  }

  /**
   * Telemetría del sitio, en LOTE (el navegador junta y manda con sendBeacon).
   * Anónima y a prueba de abuso básico: tipos cerrados, strings recortados,
   * tope de eventos por request. Nunca rompe la navegación del cliente: si
   * algo viene mal, se descarta en silencio.
   */
  async eventos(dto: any) {
    // 'busqueda': el término va en `ruta` — qué busca la gente (y no encuentra)
    // es la lista de compras del catálogo. 'pedido': el pedido que se mandó
    // (0179), para cerrar el embudo por sesión. 'llegada' (0194): una por sesión,
    // de dónde vino; el canal lo decide `clasificarLlegada`, no el navegador.
    const TIPOS = new Set(['vista_pagina', 'vista_producto', 'agregar_carrito', 'busqueda', 'pedido', 'llegada']);
    const sesion = String(dto?.sesion ?? '').slice(0, 64);
    /* El modo lo dice el navegador (0179); cualquier otra cosa cuenta como mayorista. */
    const modo: Modo = dto?.modo === 'minorista' ? 'minorista' : 'mayorista';
    const crudos = (Array.isArray(dto?.eventos) ? dto.eventos : []).slice(0, 200).filter((e: any) => TIPOS.has(e?.tipo));
    /* Con qué oferta estaba publicado cada producto (0180): del catálogo armado del modo, no de lo que diga el navegador. */
    const ofertaDe = crudos.some((e: any) => Number(e.productoId) > 0)
      ? new Map<number, number>((await this.armado(modo)).catalogo.items.filter((i: any) => i.oferta).map((i: any): [number, number] => [i.id, i.oferta.id]))
      : new Map<number, number>();
    /* La llegada por un link medible (0195): el código que trajo la dirección, si existe y está activo. */
    const llegadaConLink = crudos.find((e: any) => e.tipo === 'llegada' && e.link);
    const linkId = llegadaConLink ? (await this.links.resolver(llegadaConLink.link))?.id ?? null : null;
    const filas = crudos
      .map((e: any) => ({
        sesion,
        modo,
        ...(e.tipo === 'llegada' ? { ...origenDe(e), linkId } : {}),
        tipo: String(e.tipo),
        ruta: String(e.ruta ?? '').slice(0, 200),
        productoId: Number(e.productoId) > 0 ? Number(e.productoId) : null,
        ofertaId: ofertaDe.get(Number(e.productoId)) ?? null,
        // Tope de 10 minutos por evento: una pestaña olvidada no es interés.
        segundos: Math.min(Math.max(Number(e.segundos) || 0, 0), 600),
      }));
    if (filas.length) await this.db.insert(webEventos).values(filas);
    return { ok: true, n: filas.length };
  }

  /** Una imagen subida del sitio, de cualquiera de los tipos de la tabla. */
  async imagen(tipo: string, refId: number) {
    if (!(tipoImagenWebEnum.enumValues as readonly string[]).includes(tipo)) return null;
    const [img] = await this.db.select().from(webImagenes)
      .where(and(eq(webImagenes.tipo, tipo as any), eq(webImagenes.refId, refId))).limit(1);
    return img ?? null;
  }

  /**
   * EL CARRITO, COTIZADO POR EL SERVIDOR (nunca confía en lo que mandó el
   * navegador): resuelve cada renglón contra el catálogo del modo, valida el
   * stock por opción y entre opciones del mismo granel, y arma los renglones
   * del presupuesto. Lo comparten los dos modos; los mínimos y el envío sin
   * costo son del mayorista y van en `pedido`.
   */
  private async cotizar(modo: Modo, carritoIn: any[]) {
    if (!carritoIn.length) throw new BadRequestException('El carrito está vacío.');
    /*
     * El techo va ANTES de tocar la base: el body admite 4 MB, y con
     * `{"productoId":1,"cantidad":1}` repetido eso son ~110.000 renglones
     * válidos en un solo INSERT. Un carrito de verdad no tiene 100 productos
     * distintos.
     */
    if (carritoIn.length > MAX_RENGLONES_PEDIDO) {
      throw new BadRequestException(`Un pedido no puede tener más de ${MAX_RENGLONES_PEDIDO} renglones.`);
    }
    const { catalogo: cat, pozos, listaDeOpcion } = await this.armado(modo);
    const porId = new Map<number, any>(cat.items.map((i: any): [number, any] => [i.id, i]));

    /*
     * Se AGRUPA por producto Y OPCIÓN: el mismo artículo repetido en dos
     * renglones es un solo renglón con la suma. Sin esto, el tope de stock de
     * más abajo se esquiva partiendo el pedido en pedacitos que por separado
     * entran.
     *
     * UN GRANEL SE PIDE POR OPCIÓN (3/10/2026): `variante` dice cuál —la bolsa
     * del madre o un paquete—. Un renglón de granel sin opción válida es un
     * carrito viejo (de cuando el granel se pedía en kilos): se rechaza con el
     * nombre, para no interpretar kilos como bolsas.
     *
     * `Number.isFinite` y no `|| 0`: `Number('1e999')` es Infinity, es truthy,
     * pasa `cantidad > 0` y Postgres lo GUARDA en `double precision`.
     */
    type Renglon = { prod: any; v: any | null; cantidad: number };
    const porClave = new Map<string, Renglon>();
    const viejos: string[] = [];
    for (const linea of carritoIn) {
      const prod = porId.get(Number(linea?.productoId));
      const cantidad = Number(linea?.cantidad);
      if (!prod || !Number.isFinite(cantidad) || cantidad <= 0) continue;
      let v: any = null;
      if (prod.variantes) {
        v = prod.variantes.find((x: any) => x.clave === String(linea?.variante ?? ''));
        if (!v) { viejos.push(prod.nombre); continue; }
      }
      const k = `${prod.id}:${v?.clave ?? ''}`;
      const acc = porClave.get(k);
      if (acc) acc.cantidad += cantidad;
      else porClave.set(k, { prod, v, cantidad });
    }
    if (viejos.length) {
      throw new BadRequestException(
        `Cambió la forma de vender ${[...new Set(viejos)].join(', ')}: ahora se elige cómo llevarlo (unidad, caja, paquete o bolsa). `
        + 'Sacalo del carrito y volvé a agregarlo.',
      );
    }
    const resueltos = [...porClave.values()];
    if (!resueltos.length) throw new BadRequestException('Ningún producto del pedido está disponible.');
    const nombreDe = (r: Renglon) => (r.v ? `${r.prod.nombre} (${r.v.etiqueta})` : r.prod.nombre);
    /** Lo que vale una unidad de compra (la bolsa, el paquete o la caja, o la unidad del entero). */
    const de = (r: Renglon) => r.v ?? r.prod;

    // Bolsas, paquetes y unidades se piden ENTEROS: media bolsa cerrada no existe.
    const fraccionados = resueltos.filter((r) => Math.abs(r.cantidad - Math.round(r.cantidad)) > 1e-9);
    if (fraccionados.length) {
      throw new BadRequestException(`Se piden unidades enteras: ${fraccionados.map(nombreDe).join(', ')}.`);
    }

    /*
     * EL STOCK LO DECIDE EL SERVIDOR. El carrito ya topea la cantidad, pero
     * eso es una comodidad del navegador: acá se vuelve a mirar contra el mismo
     * `disponible` que publica el catálogo. También cubre el caso honesto: el
     * pedido que quedó abierto media hora mientras otro se llevaba lo último.
     */
    const agotados = resueltos.filter((r) => !de(r).enStock);
    if (agotados.length) {
      throw new BadRequestException(`Se quedó sin stock: ${agotados.map(nombreDe).join(', ')}. Sacalo del carrito y volvé a intentar.`);
    }
    const excedidos = resueltos.filter((r) => de(r).disponible != null && r.cantidad > de(r).disponible + 1e-9);
    if (excedidos.length) {
      throw new BadRequestException(
        'No tenemos esa cantidad: '
        + excedidos.map((r) => `${nombreDe(r)} (quedan ${de(r).disponible})`).join(', ')
        + '. Ajustá el carrito y volvé a intentar.',
      );
    }
    /*
     * LAS OPCIONES DE UN GRANEL COMPARTEN EL GRANEL: la bolsa sale del granel y
     * los paquetes que no están armados también. Cada opción por separado ya
     * se topeó; acá se suma lo que el pedido entero le saca al granel.
     */
    const porProducto = new Map<number, Renglon[]>();
    for (const r of resueltos) {
      if (!r.v) continue;
      const arr = porProducto.get(r.prod.id);
      if (arr) arr.push(r); else porProducto.set(r.prod.id, [r]);
    }
    for (const [productoId, rs] of porProducto) {
      const pozo = pozos.get(productoId);
      if (!pozo || pozo.sinTope) continue;
      /* Un ENTERO con opciones (unidad, caja x12): las opciones comparten las unidades. */
      if (rs[0].prod.tipo !== 'granel') {
        const u = rs.reduce((acc, r) => acc + r.cantidad * (r.v.unidadesStock || 1), 0);
        if (u > (pozo.unidades ?? 0) + 1e-9) {
          throw new BadRequestException(
            `No tenemos tanto de ${rs[0].prod.nombre} entre todas las formas que elegiste. Bajá alguna cantidad y volvé a intentar.`,
          );
        }
        continue;
      }
      let kg = 0;
      for (const r of rs) {
        if (r.v.presentacionId == null) { kg += r.cantidad * r.v.kgPorUnidad; continue; }
        const paquetes = r.cantidad * (r.v.paquetesPorUnidad || 1);
        const faltan = Math.max(0, paquetes - (pozo.armados.get(r.v.presentacionId) ?? 0));
        kg += faltan * (r.v.kgPorUnidad / (r.v.paquetesPorUnidad || 1));
      }
      if (r3(kg) > pozo.granelKg + 1e-9) {
        throw new BadRequestException(
          `No tenemos tanto de ${rs[0].prod.nombre} entre todos los tamaños que elegiste. Bajá alguna cantidad y volvé a intentar.`,
        );
      }
    }

    // Precio EFECTIVO: si hay una promo con precio propio (porcentaje / precio_fijo),
    // el pedido se cotiza con ese precio — el cliente vio ese número, se le cobra ese número.
    const precioEfectivo = (r: Renglon) => de(r).oferta?.precioOferta ?? de(r).precio;
    /*
     * LO QUE VALE EL RENGLÓN. Las promos de VARIAS UNIDADES (3×2, 2ª unidad,
     * pack) se cuentan en las unidades que cuenta la caja: una caja x6 son 6
     * (`paquetesPorUnidad`); una bolsa cerrada, una bolsa. La misma cuenta que
     * el carrito del sitio.
     */
    const totalRenglon = (r: Renglon) => {
      const x = de(r);
      if (!MULTI_UNIDAD.has(x.oferta?.tipo)) return r.cantidad * precioEfectivo(r);
      const n = r.v?.paquetesPorUnidad ?? 1;
      return totalConOferta(x.oferta, x.precio / n, r.cantidad * n);
    };
    const total = resueltos.reduce((a, r) => a + totalRenglon(r), 0);

    /*
     * EL RENGLÓN DEL PEDIDO, EN LA UNIDAD DEL STOCK: la bolsa viaja en KILOS
     * (2 bolsas de 10 kg = 20 kg del producto, a precio por kilo) y el paquete
     * en PAQUETES (una caja de 6 = 6 paquetes, a precio por paquete). Así la
     * reserva, el fraccionado al confirmar y el cierre en la caja trabajan con
     * lo que ya conocen. El presupuesto guarda el NETO por unidad y el
     * descuento como PORCENTAJE (una oferta 'porcentaje' queda auditada como tal).
     */
    const items = resueltos.map((r) => {
      const iva = r.prod.iva ?? 21;
      const x = de(r);
      const unidadesStock = r.v ? (r.v.unidadesStock ?? (r.v.presentacionId == null ? r.v.kgPorUnidad : (r.v.paquetesPorUnidad || 1))) : 1;
      const esPorcentaje = x.oferta?.tipo === 'porcentaje' && x.oferta.precioOferta != null;
      const multi = MULTI_UNIDAD.has(x.oferta?.tipo);
      const precioCompra = esPorcentaje || multi ? x.precio : precioEfectivo(r);
      /* Varias unidades: el renglón va a precio lleno con el descuento que deja el total exacto (3×2 de 3 = 33,33 %). */
      const descuento = esPorcentaje ? money(100 * (1 - x.oferta.precioOferta / x.precio))
        : multi ? Math.round(1e6 * (1 - totalRenglon(r) / (r.cantidad * x.precio))) / 1e4 : 0;
      /* La lista de la opción (la caja de 5 puede ser Mayorista 2): con esa se cotizó y con esa cierra la caja. */
      const lista = listaDeOpcion.get(`${r.prod.id}:${r.v ? r.v.clave : ''}`) ?? null;
      return {
        productoId: r.prod.id, presentacionId: r.v?.presentacionId ?? null,
        nombre: r.prod.nombre,
        detalle: r.v ? r.v.etiqueta : 'Unidad',
        cantidad: r3(r.cantidad * unidadesStock),
        /* Sin cortar a 2 decimales: el total del presupuesto se suma con este número y
         * tiene que dar EXACTO lo que el cliente vio (la caja de 6 daba 2 centavos menos). */
        precioLista: Math.round((precioCompra / unidadesStock / (1 + iva / 100)) * 1e6) / 1e6,
        descuento, iva, lista: lista?.nombre ?? cat.listaNombre, listaId: lista?.id ?? cat.listaId ?? null,
        ofertaNombre: x.oferta?.nombre ?? '', ofertaId: x.oferta?.id ?? null,
      };
    });
    return { cat, resueltos, de, nombreDe, total, items };
  }

  /**
   * Alta de un pedido MAYORISTA. Recotiza TODO server-side, valida el mínimo
   * de compra y el envío sin costo, y crea el presupuesto.
   */
  async pedido(dto: any, token?: string, previa?: string) {
    const prueba = await this.exigirAbierta('mayorista', previa);
    /* Compra solo el habilitado (0155): quién es sale de la SESIÓN, no del body. */
    const s = await this.accesos.sesion(token);
    if (!s) throw new UnauthorizedException('Para comprar, ingresá con tu DNI.');

    /* El WhatsApp de ESTE pedido (puede cambiarlo; su acceso no se toca). Área + abonado = 10 dígitos. */
    const telCrudo = String(dto?.cliente?.telefono ?? '').trim();
    const telefono = telCrudo ? telefonoArgentino(telCrudo) : s.whatsapp;
    if (!telefono) {
      throw new BadRequestException('El WhatsApp está incompleto: escribilo con el código de área, sin 0 ni 15 — 10 dígitos en total (ej: 370 4123456).');
    }

    const entrega: EntregaTienda = ENTREGAS_TIENDA.includes(dto?.entrega) ? dto.entrega : 'retiro';
    // Se valida ANTES de cotizar: si falta la dirección no hay para qué tocar el catálogo.
    const domicilio = direccionDeEntrega(entrega, dto?.direccion);

    const { cat, resueltos, de, nombreDe, total, items } = await this.cotizar('mayorista', Array.isArray(dto?.items) ? dto.items : []);

    // Gate de compra mínima: por MONTO o por CANTIDAD (marca / producto) — no
    // cambia el precio, solo habilita finalizar el pedido (igual que el sitio real).
    // Las cantidades se cuentan en unidades de compra: bolsas, paquetes, cajas o unidades.
    const montoOk = cat.montoMinimo > 0 ? total >= cat.montoMinimo : true;
    const porMarca = new Map<number, number>();
    for (const r of resueltos) {
      if (!r.prod.marcaId) continue;
      /* Un entero en caja cuenta sus UNIDADES (una caja x12 son 12 para la regla de marca). */
      const u = r.v && r.prod.tipo !== 'granel' ? r.cantidad * (r.v.unidadesStock || 1) : r.cantidad;
      porMarca.set(r.prod.marcaId, (porMarca.get(r.prod.marcaId) ?? 0) + u);
    }
    const marcasIncumplidas = cat.reglasMarca.filter((rm: any) => {
      const enCarrito = porMarca.get(rm.marcaId);
      return enCarrito != null && enCarrito < rm.unidadesMinimas;
    });
    const productosIncumplidos = resueltos.filter((r) => de(r).unidadesMinimas > 0 && r.cantidad < de(r).unidadesMinimas);
    const cantidadOk = marcasIncumplidas.length === 0 && productosIncumplidos.length === 0;

    if (!montoOk && !cantidadOk) {
      const partes: string[] = [];
      if (cat.montoMinimo > 0) partes.push(`llegar a $${cat.montoMinimo} en total`);
      for (const rm of marcasIncumplidas) partes.push(`${rm.unidadesMinimas} unidades surtidas de ${rm.marca}`);
      for (const r of productosIncumplidos) partes.push(`${de(r).unidadesMinimas} de ${nombreDe(r)}`);
      throw new BadRequestException(`Para completar el pedido, alcanzá alguna de estas condiciones: ${partes.join(' — o — ')}.`);
    }

    /*
     * El ENVÍO SIN COSTO (la camioneta de la empresa) se puede apagar, y tiene
     * su PROPIO piso, duro (sin el camino alternativo por cantidades): mover el
     * vehículo cuesta lo mismo lleve lo que lleve, así que el pedido tiene que
     * valer el viaje. El cliente nunca lee «camioneta»: lee «envío sin costo».
     */
    if (entrega === 'camioneta' && !cat.envioCamionetaActivo) {
      throw new BadRequestException('El envío sin costo no está disponible por ahora. Elegí retiro en el local o envío por cadete.');
    }
    if (entrega === 'camioneta' && cat.montoMinimoCamioneta > 0 && total < cat.montoMinimoCamioneta) {
      const pesos = cat.montoMinimoCamioneta.toLocaleString('es-AR', { maximumFractionDigits: 2 });
      throw new BadRequestException(
        `El envío sin costo necesita un pedido de al menos $${pesos}. `
        + 'Sumá productos, o elegí retiro en el local o envío por cadete.',
      );
    }

    /* El cliente es el de su acceso (su ficha se creó al habilitarlo y NO se toca): el WhatsApp
     * y la dirección de este pedido viajan en `webCliente`, que es lo que muestra la orden. */
    return this.presupuestos.crearDesdeWeb({
      clienteId: s.clienteId, sucursalId: cat.sucursalId, modoTienda: 'mayorista',
      // Topes de largo del lado del servidor: el `maxLength` del checkout vive
      // en el navegador y no protege al `POST` directo. Un pedido con 3 MB de
      // texto en observaciones vuelve inusable la bandeja de Órdenes al pintarla.
      entrega, observaciones: String(dto.observaciones ?? '').slice(0, 500),
      webCliente: {
        nombre: s.nombre, apellido: '', telefono, dni: s.dni,
        // La dirección viaja con los datos del cliente (jsonb, sin migración):
        // el ERP la muestra en la orden y la usa al darlo de alta.
        ...(domicilio ?? {}),
        ...(prueba ? { prueba: true } : {}),
      },
      items,
    });
  }

  /* ============================ MODO MINORISTA (0173) ============================ */

  /**
   * Alta de un pedido MINORISTA: sin mínimos, y desde 0178 solo con ingreso.
   * Quién compra sale de la SESIÓN (WhatsApp, nombre y apellido), no del body.
   * El envío va a su dirección guardada (`direccion.guardada`, que el navegador
   * ve a medias) o a una que escribe, que pasa a ser la guardada. El envío
   * sale de su barrio (0185): el punto que marcó en el mapa decide el costo, las
   * promos y el descuento; sin punto o fuera de todo barrio, la regla general
   * (gratis desde el monto configurado; si no, se coordina).
   */
  /**
   * ¿PARA CUÁNDO EL ENVÍO? (23/10/2026): las opciones del checkout minorista
   * con el horario del local de los envíos y los feriados de la sucursal que
   * despacha. Las reglas, en `horario-envio.ts`.
   */
  async agendaEnviosMinorista(previa?: string) {
    await this.exigirAbierta('minorista', previa);
    return this.agendaEnvios();
  }

  private async agendaEnvios() {
    const ahora = new Date();
    const hoy = fechaArgentina(ahora);
    const hasta = fechaArgentina(new Date(ahora.getTime() + DIAS_BUSQUEDA * 86_400_000));
    const [web, ventas, suc] = await Promise.all([this.cfg.get('web'), this.cfg.get('ventas'), this.sucursalTienda()]);
    const delLocal = suc ? await this.db.select({ fecha: feriados.fecha, abre: feriadoSucursales.abre, horario: feriadoSucursales.horario })
      .from(feriadoSucursales).innerJoin(feriados, eq(feriados.id, feriadoSucursales.feriadoId))
      .where(and(eq(feriadoSucursales.sucursalId, suc.id), gte(feriados.fecha, hoy), lte(feriados.fecha, hasta))) : [];
    const local = localDeEnvios(web.locales ?? [], ventas.tiendaMinoristaLocalEnvios ?? '');
    return agendaEnvios(local ?? {}, excepcionesDe(delLocal), ahora);
  }

  async pedidoMinorista(dto: any, tokenMin?: string, previa?: string) {
    const prueba = await this.exigirAbierta('minorista', previa);
    const c = await this.accesos.sesionMinorista(tokenMin);
    if (!c) throw new UnauthorizedException('Para comprar, ingresá con tu WhatsApp.');

    const entrega = ENTREGAS_MINORISTA[String(dto?.entrega ?? '')] ?? 'retiro';
    const guardada = entrega !== 'retiro' && dto?.direccion?.guardada === true;
    if (guardada && !c.direccion) throw new BadRequestException('No tenemos tu dirección guardada: escribila para el envío.');
    const nueva = guardada ? null : direccionDeEntrega(entrega, dto?.direccion);
    const domicilio = guardada ? { direccion: c.direccion, localidad: c.localidad, referencia: c.referencia } : nueva;

    const { cat, total, items } = await this.cotizar('minorista', Array.isArray(dto?.items) ? dto.items : []);
    const zona = entrega === 'cadete' ? await this.zonaDeEnvio(c, dto, total, cat.envioGratisDesde) : null;
    const conBarrio = conDescuentoBarrio(items, zona?.descuentoPct ?? 0);
    const medioPago = medioDeTienda(dto?.medioPago);
    /* Con envío, para cuándo (23/10/2026): lo elegido tiene que seguir valiendo ahora. */
    const elegido = entrega === 'cadete' ? cuandoDe(dto?.cuando, await this.agendaEnvios()) : null;
    if (elegido && 'error' in elegido) throw new BadRequestException(elegido.error);

    return this.db.transaction(async (tx) => {
      /*
       * EL CUPÓN (0190), con la fila trabada mientras se cuentan sus usos: dos
       * pedidos a la vez no se pasan del tope. Lo que el checkout cotizó puede
       * haber cambiado (la hora, el último uso): se vuelve a mirar todo acá.
       */
      const { ev } = await this.descuentoDelPedido(dto, c, entrega === 'cadete' ? 'envio' : 'retiro', conBarrio, tx);
      const r = ev?.resultado;
      if (r && !r.vale) throw new BadRequestException(r.motivo);
      if (r?.vale && r.medios.length && !medioPago) {
        throw new BadRequestException(`Elegí cómo vas a pagar: el cupón vale pagando con ${r.medios.join(' o ')}.`);
      }
      const regalaEnvio = !!r?.vale && r.envioGratis;
      /* Lo del envío queda en la orden: el barrio y el punto (para el cadete), el costo (0 = gratis) y el descuento del barrio. */
      const costoEnvio = regalaEnvio ? 0 : zona?.envio;
      const envio = zona ? {
        ...(zona.barrio ? { barrio: zona.barrio.nombre } : {}),
        ...(zona.punto ? { ubicacion: zona.punto } : {}),
        ...(costoEnvio != null ? { envio: costoEnvio } : {}),
        ...(costoEnvio === 0 ? { envioGratis: true } : {}),
        ...(zona.descuentoPct > 0 ? { descuentoBarrio: zona.descuentoPct } : {}),
      } : {};

      /*
       * La dirección que escribió para ESTE envío pasa a ser la guardada, con su
       * punto (o sin punto, si no lo marcó). La guardada de antes del mapa se
       * queda con el punto que marcó ahora. Con retiro no se toca.
       */
      const punto = zona?.punto ? { lat: zona.punto.lat, lng: zona.punto.lng } : { lat: null, lng: null };
      await tx.update(tiendaCompradores)
        .set({
          ...(nueva ? { ...nueva, ...punto } : guardada && c.lat == null && zona?.punto ? punto : {}),
          pedidos: sql`${tiendaCompradores.pedidos} + 1`, actualizadoEn: new Date(),
        })
        .where(eq(tiendaCompradores.id, c.id));
      const creado = await this.presupuestos.crearDesdeWeb({
        clienteId: null, sucursalId: cat.sucursalId, modoTienda: 'minorista',
        entrega, observaciones: String(dto?.observaciones ?? '').slice(0, 500),
        webCliente: {
          nombre: c.nombre, apellido: c.apellido, telefono: c.telefono, dni: '', ...(domicilio ?? {}), ...envio,
          ...(medioPago ? { medioPago } : {}),
          ...(elegido ? { cuando: elegido.cuando } : {}),
          /* Para medir cuántos clientes nuevos trae cada cupón. */
          ...(!(c.pedidos > 0) ? { primeraCompra: true } : {}),
          ...(prueba ? { prueba: true } : {}),
        },
        items: r?.vale ? conBarrio.map((it, i) => ({ ...it, descuento: r.renglones[i].descuento, cuponPct: r.renglones[i].cuponPct })) : conBarrio,
        cupon: r?.vale && ev?.cupon ? {
          id: ev.cupon.id, codigo: ev.cupon.codigo, descuento: r.descuento,
          /* Lo que regaló un cupón de envío gratis (null = no regaló o se coordinaba). */
          envio: regalaEnvio ? zona?.envio ?? null : null,
        } : null,
      }, tx);
      /* `total` es la mercadería; el envío va aparte (null = se coordina), como en la orden. */
      return { ...creado, envio: costoEnvio ?? null };
    });
  }

  /**
   * LO QUE SALE RECIBIR EN CASA (0185), para el checkout: el barrio del punto
   * marcado (o de la dirección guardada), el costo del envío, el descuento del
   * barrio, las promos que se usan y la que está cerca. Misma cuenta que el
   * alta del pedido: lo que ve el cliente es lo que se le cobra.
   */
  async envioMinorista(dto: any, tokenMin?: string, previa?: string) {
    await this.exigirAbierta('minorista', previa);
    const c = await this.accesos.sesionMinorista(tokenMin);
    if (!c) throw new UnauthorizedException('Para comprar, ingresá con tu WhatsApp.');
    const { cat, total, items } = await this.cotizar('minorista', Array.isArray(dto?.items) ? dto.items : []);
    /* Retirando no hay barrio ni envío: se cotiza igual, por el cupón (0190). Sin `entrega`, envío (como antes). */
    const conEnvio = dto?.entrega !== 'retiro';
    const zona = conEnvio ? await this.zonaDeEnvio(c, dto, total, cat.envioGratisDesde) : null;
    const descuento = montoDescuento(items, zona?.descuentoPct ?? 0);
    const { ev, porMedio } = await this.descuentoDelPedido(dto, c, conEnvio ? 'envio' : 'retiro', conDescuentoBarrio(items, zona?.descuentoPct ?? 0));
    const r = ev?.resultado;
    const cupon = r?.vale ? r.descuento : 0;
    const envio = r?.vale && r.envioGratis && conEnvio ? 0 : zona?.envio ?? null;
    return {
      /** Si hay punto (marcado ahora o el de la dirección guardada): sin él no hay barrio. */
      conPunto: !!zona?.punto,
      barrio: zona?.barrio?.nombre ?? null,
      envio,
      descuentoPct: zona?.descuentoPct ?? 0,
      descuento,
      promos: zona ? zona.aplicadas.map((p) => describirPromo(p, zona.nombreDe)) : [],
      proxima: zona?.proxima ? { texto: describirPromo(zona.proxima.promo, zona.nombreDe), faltan: money(zona.proxima.faltan) } : null,
      /** El cupón que escribió (0190): si vale, cuánto descuenta y qué pide; si no, por qué. */
      cupon: !porMedio && r ? {
        codigo: ev?.cupon?.codigo ?? String(dto.cupon).trim().toUpperCase(),
        vale: r.vale,
        ...(r.vale
          ? { descuento: r.descuento, envioGratis: r.envioGratis, medios: r.medios, descripcion: ev?.cupon?.descripcion ?? '' }
          : { motivo: r.motivo }),
      } : null,
      /**
       * Sin código, los automáticos (0199): el que corre con el medio elegido y lo
       * que daría cada medio (para animar a pagar así). Sin automáticos, null.
       */
      automatico: porMedio && ev ? resumenAutomatico(ev) : null,
      porMedio: porMedio && Object.values(porMedio).some(Boolean)
        ? Object.fromEntries(Object.entries(porMedio).map(([m, e]) => [m, e && resumenAutomatico(e)]))
        : null,
      subtotal: total,
      total: money(total - descuento - cupon + (envio ?? 0)),
    };
  }

  /**
   * EL DESCUENTO DE LA TIENDA SOBRE EL PEDIDO, con la MISMA cuenta en la
   * cotización y en el alta. `items` ya llevan el % del barrio. Con `tx` (el
   * alta) cuenta los usos con las filas trabadas.
   *   · Con código, ese cupón (0190); `porMedio` null.
   *   · Sin código, los automáticos (0199): el mejor para el medio elegido o,
   *     sin medio, el mejor de los que valen con cualquiera. `porMedio`: lo que
   *     daría cada medio. Nunca se suman: un pedido lleva un solo cupón.
   */
  private async descuentoDelPedido(dto: any, c: Comprador, entrega: 'retiro' | 'envio', items: any[], tx?: Database) {
    const renglones = items.map((it) => ({
      productoId: it.productoId, ofertaId: it.ofertaId ?? null, cantidad: it.cantidad,
      precioLista: it.precioLista, iva: it.iva, descuento: Number(it.descuento) || 0,
    }));
    const medioPago = medioDeTienda(dto?.medioPago);
    const pedido = {
      renglones, telefono: c.telefono, primeraCompra: !(c.pedidos > 0), ahora: new Date(), entrega,
      medioPago, subtotal: renglones.reduce((s, x) => s + finalDe(x as any), 0),
    };
    const codigo = String(dto?.cupon ?? '').trim();
    if (codigo) return { ev: await this.cupones.evaluar(codigo, pedido, tx, !!tx), porMedio: null };
    const { todos, porMedio } = mejorPorMedio(await this.cupones.evaluarAutomaticos(pedido, tx, !!tx));
    return { ev: medioPago ? porMedio[medioPago] : todos, porMedio };
  }

  /**
   * El barrio del envío y sus condiciones: el punto marcado en el mapa o, a la
   * dirección guardada, el de ella — y si es de antes del mapa y no tiene, el
   * que marque ahora.
   */
  private async zonaDeEnvio(c: Comprador, dto: any, subtotal: number, gratisDesde: number) {
    const punto = (dto?.direccion?.guardada === true ? puntoValido({ lat: c.lat, lng: c.lng }) : null) ?? puntoValido(dto?.ubicacion);
    return { punto, ...(await this.barrios.condicionesPara(punto, subtotal, gratisDesde)) };
  }
}

/**
 * Los endpoints públicos del sistema — los únicos pensados para recibir
 * internet directo. Cada uno con su cupo por IP (ver rate-limit.guard.ts);
 * el resto de la API no se limita: el ERP le pega todo el día desde la red local.
 */
@Controller('tienda')
@Publico()
@UseGuards(TiendaRateLimitGuard)
export class TiendaController {
  constructor(private readonly svc: TiendaService, private readonly accesos: AccesosTiendaService, private readonly links: LinksTiendaService) {}

  /** `?modo=minorista` pide el catálogo minorista (0173); cualquier otra cosa, el mayorista. */
  @Get('catalogo')
  @RateLimit('catalogo')
  catalogo(
    @Query('modo') modo?: string, @Headers(SESION) token?: string, @Headers(SESION_MIN) tokenMin?: string, @Headers(VISTA_PREVIA) previa?: string,
  ) {
    return this.svc.catalogo(token, modo, tokenMin, previa);
  }

  @Post('pedidos')
  @RateLimit('pedidos')
  pedido(@Body() body: any, @Headers(SESION) token?: string, @Headers(VISTA_PREVIA) previa?: string) { return this.svc.pedido(body ?? {}, token, previa); }

  /* Modo minorista (0173). POST y no GET: el teléfono no queda escrito en la dirección ni en los registros. */
  @Post('minorista/pedidos')
  @RateLimit('pedidos')
  pedidoMinorista(@Body() body: any, @Headers(SESION_MIN) tokenMin?: string, @Headers(VISTA_PREVIA) previa?: string) {
    return this.svc.pedidoMinorista(body ?? {}, tokenMin, previa);
  }

  /* Cuánto sale recibir en casa (0185): el checkout la pide al marcar el punto en el mapa. */
  @Post('minorista/envio')
  @RateLimit('envio')
  envioMinorista(@Body() body: any, @Headers(SESION_MIN) tokenMin?: string, @Headers(VISTA_PREVIA) previa?: string) {
    return this.svc.envioMinorista(body ?? {}, tokenMin, previa);
  }

  /* Para cuándo el envío (23/10/2026): las opciones del checkout con el horario del local. */
  @Get('minorista/horarios-envio')
  @RateLimit('envio')
  horariosEnvio(@Headers(VISTA_PREVIA) previa?: string) { return this.svc.agendaEnviosMinorista(previa); }

  /* Ingreso a la minorista con el WhatsApp (0178): mismos cupos que el del DNI. */
  @Post('minorista/registro')
  @RateLimit('registro')
  registroMinorista(@Body() body: any) { return this.accesos.registrarMinorista(body ?? {}); }

  @Post('minorista/ingresar')
  @RateLimit('ingreso')
  ingresarMinorista(@Body() body: any) { return this.accesos.ingresarMinorista(body ?? {}); }

  /* Ingreso a la tienda (0155). POST y no GET: el DNI no queda escrito en la dirección ni en los registros. */
  @Post('registro')
  @RateLimit('registro')
  registro(@Body() body: any) { return this.accesos.registrar(body ?? {}); }

  @Post('ingresar')
  @RateLimit('ingreso')
  ingresar(@Body() body: any) { return this.accesos.ingresar(body ?? {}); }

  @Post('salir')
  @RateLimit('ingreso')
  salir(@Headers(SESION) token?: string) { return this.accesos.salir(token); }

  @Post('eventos')
  @RateLimit('eventos')
  eventos(@Body() body: any) { return this.svc.eventos(body ?? {}); }

  /**
   * A dónde lleva un link medible (0195): lo pide el servidor de la tienda al
   * abrir `/l/<codigo>`. Sin límite por IP a propósito: todas las visitas
   * llegan desde el servidor de la tienda, y es una lectura de una fila por su
   * código; un código que no existe o está desactivado lleva a la portada.
   */
  @Get('links/:codigo')
  async link(@Param('codigo') codigo: string) {
    const l = await this.links.resolver(codigo);
    if (!l) throw new NotFoundException('Ese link no existe.');
    return { modo: l.modo, destino: l.destino, canal: l.canal };
  }

  /**
   * Sirve el binario de una imagen del sitio. El `?v=` del catálogo versiona el caché.
   *
   * ESTE ENDPOINT ES EL QUE VUELVE PELIGROSA UNA SUBIDA. Es público, y nginx lo
   * publica en el MISMO ORIGEN que el dashboard (`location /api/`), donde vive
   * el token de sesión del ERP. Un archivo que el navegador trate como
   * documento —un SVG, por ejemplo— correría ahí adentro con la sesión de quien
   * abra el link. Tres candados, y ninguno reemplaza a los otros:
   *
   *   1. el mime sale de una lista blanca, no de la base: aunque una fila vieja
   *      o una migración metan otra cosa, de acá no sale;
   *   2. `Content-Disposition: attachment` — el navegador la baja en vez de
   *      renderizarla si alguien la abre como página;
   *   3. `Content-Security-Policy: sandbox` — y si igual la renderiza, ahí
   *      adentro no corre script ni hay acceso al origen.
   *
   * El `<img src="...">` del sitio sigue andando igual: una etiqueta `img` no
   * mira el `Content-Disposition`.
   *
   * Y el CUARTO encabezado va al revés que los otros tres: helmet marca toda la
   * API como `Cross-Origin-Resource-Policy: same-origin`, que es lo correcto
   * para el resto —el dashboard comparte origen con la API— pero deja al sitio
   * público sin poder mostrar una sola imagen cuando vive en otro dominio (o en
   * otro puerto, como en desarrollo: el navegador corta con
   * ERR_BLOCKED_BY_RESPONSE.NotSameOrigin y no se ve ni el logo). Estas
   * imágenes son públicas por definición, así que ACÁ Y SOLO ACÁ se abre.
   */
  @Get('imagenes/:tipo/:refId')
  @RateLimit('imagenes')
  async imagen(
    @Param('tipo') tipo: string,
    @Param('refId', ParseIntPipe) refId: number,
    @Res() res: Response,
  ) {
    const img = await this.svc.imagen(tipo, refId);
    if (!img) throw new NotFoundException('Imagen inexistente.');
    if (!MIMES_IMAGEN.has(img.mime)) throw new NotFoundException('Imagen inexistente.');
    res.setHeader('Content-Type', img.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${tipo}-${refId}"`);
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(img.data, 'base64'));
  }
}

@Module({
  imports: [ListasModule, ConfiguracionModule, PresupuestosModule, OfertasModule, ClientesModule, BarriosModule, CuponesModule],
  controllers: [TiendaController, AccesosTiendaController, VistaPreviaController],
  providers: [TiendaService, AccesosTiendaService, TiendaRateLimitGuard, VistaPreviaService, LinksTiendaService],
  exports: [TiendaService, LinksTiendaService],
})
export class TiendaModule {}
