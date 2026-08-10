/**
 * CONFIGURACIÓN POR ÁREA
 * ============================================================================
 * Un JSON por área (`ventas`, luego `compras`…) en vez de una columna por
 * opción: agregar una preferencia nueva no requiere migración.
 *
 * El catálogo de DEFAULTS de abajo es el contrato: es la lista de claves
 * válidas, sus tipos y sus valores iniciales. Al guardar se descarta todo lo
 * que no esté acá y todo lo que no coincida en tipo, así la config nunca se
 * corrompe desde el cliente y leerla no necesita defensas en cada lectura.
 */
import {
  Body, Controller, Get, Inject, Injectable, Module, NotFoundException, Param, Put,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { configuracion } from '../db/schema';

/** Preferencias del circuito de ventas. */
export const VENTAS_DEFAULTS = {
  /* Comprobantes ------------------------------------------------------- */
  // 'ticket' = comprobante interno (etapa actual). 'factura' = fiscal vía ARCA.
  comprobanteDefault: 'ticket' as string,
  puntoVenta: '0001' as string,
  // Mientras esté en false, la venta se confirma sin pedir CAE.
  arcaHabilitado: false as boolean,
  // Condición fiscal PROPIA: junto con la del cliente define la letra (A/B/C).
  condicionIvaEmpresa: 'responsable_inscripto' as string,

  /* Precios y descuentos ----------------------------------------------- */
  /**
   * PISO del sistema: la lista con la que se cotiza cuando el renglón no
   * habilitó ninguna otra. 0 = la primera activa por orden de preferencia.
   *
   * Conviene que sea la de PEOR orden (la más cara, mostrador): es la red de
   * contención, no una candidata más.
   *
   * El catálogo vive en `modalidades_venta` / `listas_venta`, y el markup de
   * cada producto en `producto_listas` — acá solo se elige cuál es el piso.
   */
  listaBaseId: 0 as number,

  /* Acceso mayorista por monto ------------------------------------------ */
  /**
   * Monto de ticket que desbloquea una modalidad entera. 0 = desactivado.
   *
   * NUNCA se aplica solo: se mide sobre precios, y aplicar el beneficio baja el
   * total, lo que podría dejar el ticket por debajo del umbral y revertirse en
   * un ciclo infinito. La caja lo sugiere y el vendedor lo aplica con un clic.
   *
   * Solo alcanza a los productos que tengan una lista cargada en esa modalidad;
   * el resto sigue con su precio de siempre.
   */
  montoMinimoMayorista: 0 as number,
  modalidadMontoId: 0 as number,        // qué modalidad desbloquea (0 = ninguna)
  /**
   * Piso extra del SITIO para la entrega con camioneta de la empresa: mover
   * el vehículo tiene un costo fijo, así que el pedido tiene que valer el
   * viaje. Se valida en el checkout Y en el servidor. 0 = sin piso extra.
   */
  montoMinimoCamioneta: 80000 as number,
  /**
   * Medios de pago con los que se respeta ese precio. Vacío = cualquiera.
   * Se valida AL CONFIRMAR, porque el medio de pago se elige al cobrar y el
   * precio se armó antes.
   */
  mediosPagoMonto: [] as string[],
  /**
   * Cambiar la lista de un renglón a mano esquiva por completo el tope de
   * descuento (pasar de minorista a mayorista puede ser −40% sin registrarse
   * como descuento). Con esto en `true`, solo un admin puede hacerlo; el
   * automático por condición sigue funcionando para todos, porque es una regla
   * y no una decisión.
   */
  overrideListaRequiereAdmin: true as boolean,
  descuentoMaxVendedor: 10 as number,   // % que un no-admin puede aplicar
  redondeoEfectivo: 0 as number,        // 0 = sin redondeo; 10/50/100 = a esa unidad
  /**
   * Redondeo del PRECIO DE GÓNDOLA. 0 = sin redondeo; 1 = al entero; 10/50/100
   * = a esa unidad. Se aplica sobre el precio FINAL (con IVA), que es el que ve
   * el cliente: redondear el neto dejaría la góndola con centavos igual.
   */
  redondeoPrecio: 1 as number,

  /* Cuenta corriente ---------------------------------------------------- */
  ctaCteHabilitada: true as boolean,
  ctaCteLimiteDefault: 0 as number,     // 0 = sin tope
  ctaCteDiasPlazo: 30 as number,
  ctaCteBloquearSuperado: true as boolean,

  /* Presupuestos -------------------------------------------------------- */
  presupuestoValidezDias: 7 as number,
  /** Al CONFIRMAR un presupuesto se reserva el stock (disponible → comprometido):
   *  mientras el vendedor arma el pedido, la caja no puede vender esa mercadería. */
  presupuestoReservaStock: true as boolean,

  /* Caja / punto de venta ----------------------------------------------- */
  cajaObligatoria: true as boolean,     // exigir turno de caja abierto para vender
  permitirStockNegativo: false as boolean,
  mediosPago: ['efectivo', 'transferencia', 'tarjeta_debito', 'tarjeta_credito', 'qr'] as string[],

  /* Lector de códigos / balanza ----------------------------------------- */
  lectorHabilitado: true as boolean,
  lectorSufijoEnter: true as boolean,   // el lector envía Enter al final
  balanzaHabilitada: false as boolean,  // etiquetas EAN-13 de peso variable
  balanzaPrefijo: '20' as string,       // prefijo que identifica esas etiquetas
  balanzaModo: 'peso' as string,        // 'peso' | 'importe'
};

/** Catálogo de áreas configurables. Agregar un área = agregar una entrada acá. */
/**
 * Identidad de la EMPRESA: la usan todos los documentos impresos (encabezado
 * con logo + nombre + CUIT). El logo viaja como data-URL (imagen chica).
 */
export const EMPRESA_DEFAULTS = {
  nombre: 'Sabor y Aroma' as string,
  cuit: '' as string,
  direccion: '' as string,
  telefono: '' as string,
  logo: '' as string,
  colorMarca: '#166534' as string,   // acentos en documentos A4 (los rollos son B/N)
};

/**
 * IMPRESIÓN: qué formato usa cada documento del sistema.
 * rollo80 (recomendado: más texto por línea) · rollo58 (posnet/portátil) ·
 * a4 · carta. Global a propósito: la impresora FÍSICA la elige cada puesto
 * en el diálogo del navegador (o su predeterminada con Chrome kiosco).
 *
 * Las ETIQUETAS del fraccionado son la excepción de tamaño: van a la impresora
 * térmica de etiquetas, en su medida (etiqueta50x30 y compañía) y sin membrete.
 */
export const IMPRESION_DEFAULTS = {
  ticketPos: 'rollo80' as string,
  presupuesto: 'a4' as string,
  hojaArmado: 'a4' as string,
  listaPreparacion: 'a4' as string,
  etiquetaFraccionado: 'etiqueta50x30' as string,
  imprimirTicketAlCobrar: true as boolean,
  pieTicket: '¡Gracias por su compra!' as string,
  leyendaNoFiscal: true as boolean,
};

/**
 * SITIO WEB: los textos editables de la portada. Las IMÁGENES (banner, fotos
 * de producto, categorías, marcas) no viven acá sino en `web_imagenes` — la
 * configuración es texto chico, no binarios.
 */
/**
 * Slides de la portada del sitio: SON DATO, no código — alta, baja, edición y
 * orden se manejan desde Web › Contenido. Estos tres son solo el arranque
 * (equivalen a la portada original); una vez guardados desde el CRM, mandan
 * los guardados. `id` ata cada slide a su imagen (`web_imagenes` tipo
 * 'banner', refId = id) y NO se recicla al borrar. `posicion`: dónde va el
 * texto sobre la imagen (left | center | right).
 */
export const WEB_DEFAULTS = {
  /*
   * Contacto y redes del SITIO (footer, botón flotante y links de WhatsApp).
   * Los defaults son la información real actual: editable desde Web ›
   * Configuración del sitio. El WhatsApp va como número argentino de 10
   * dígitos (área + abonado, sin 0 ni 15) — el sitio arma el wa.me solo.
   */
  whatsapp: '3704621563' as string,
  contactoTelefono: '' as string,
  contactoEmail: 'info@saboryaroma.com' as string,
  contactoUbicacion: 'Formosa, Argentina' as string,
  redInstagram: 'saboryaroma__' as string,
  redFacebook: '' as string,
  slides: [
    {
      id: 1,
      badge: 'Distribuidora saludable en Formosa',
      titulo: 'Productos naturales y saludables, al por mayor',
      texto: 'Alimentos orgánicos, libres de gluten y las mejores marcas del mercado.',
      cta: 'Ver catálogo',
      ctaUrl: '/tienda',
      posicion: 'left',
    },
    {
      id: 2,
      badge: 'Ofertas activas',
      titulo: 'Precios especiales por tiempo limitado',
      texto: 'Aprovechá descuentos exclusivos para tu compra mayorista antes de que se agoten.',
      cta: 'Ver ofertas',
      ctaUrl: '/#ofertas',
      posicion: 'center',
    },
    {
      id: 3,
      badge: 'Marcas líderes',
      titulo: 'Trabajamos con las mejores marcas del mercado',
      texto: 'Encontrá tus marcas de confianza para reponer stock, todas en un mismo lugar.',
      cta: 'Conocer marcas',
      ctaUrl: '/#marcas',
      posicion: 'right',
    },
  ] as Array<Record<string, any>>,
};

export const CONFIG_DEFAULTS: Record<string, Record<string, any>> = {
  ventas: VENTAS_DEFAULTS,
  empresa: EMPRESA_DEFAULTS,
  impresion: IMPRESION_DEFAULTS,
  web: WEB_DEFAULTS,
};

/**
 * Limpia un ítem de un array de objetos contra su plantilla (el primer
 * elemento del default): solo sus claves, con su tipo. A diferencia del
 * sanitize de arriba, un string VACÍO acá es válido — el badge de un slide
 * puede no estar, y forzar el texto del default sería inventar contenido.
 */
function sanitizeItem(template: Record<string, any>, raw: any): Record<string, any> | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: Record<string, any> = {};
  for (const [k, def] of Object.entries(template)) {
    const v = (raw as any)[k];
    if (typeof def === 'number') {
      const n = Number(v);
      out[k] = Number.isFinite(n) ? n : 0;
    } else if (typeof def === 'boolean') {
      out[k] = typeof v === 'boolean' ? v : false;
    } else {
      out[k] = typeof v === 'string' ? v.trim() : '';
    }
  }
  return out;
}

/**
 * Deja `raw` con exactamente las claves de `defaults` y sus tipos. Lo que no
 * coincide vuelve al default; lo desconocido se descarta.
 */
function sanitize(defaults: Record<string, any>, raw: any): Record<string, any> {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out: Record<string, any> = {};
  for (const [k, def] of Object.entries(defaults)) {
    const v = src[k];
    if (Array.isArray(def)) {
      const template = def[0];
      if (template && typeof template === 'object') {
        // Array de OBJETOS (p. ej. los slides): cada ítem se limpia contra la
        // plantilla. Si no se guardó nunca, valen los defaults completos.
        out[k] = Array.isArray(v)
          ? v.map((x) => sanitizeItem(template, x)).filter(Boolean)
          : def.map((d) => ({ ...d }));
      } else {
        out[k] = Array.isArray(v)
          ? v.map((x) => String(x).trim()).filter(Boolean)
          : [...def];
      }
    } else if (typeof def === 'boolean') {
      out[k] = typeof v === 'boolean' ? v : def;
    } else if (typeof def === 'number') {
      const n = Number(v);
      out[k] = Number.isFinite(n) ? n : def;
    } else {
      out[k] = typeof v === 'string' && v.trim() ? v.trim() : def;
    }
  }
  return out;
}

@Injectable()
export class ConfiguracionService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Caché en memoria. La config se lee en CADA venta, bootstrap y cálculo de
   * precio, y cambia una vez por mes: sin caché serían miles de consultas
   * idénticas por día. Se invalida sola al guardar.
   */
  private cache = new Map<string, Record<string, any>>();

  private defaultsDe(clave: string) {
    const d = CONFIG_DEFAULTS[clave];
    if (!d) throw new NotFoundException(`No existe la configuración "${clave}".`);
    return d;
  }

  /** Siempre devuelve el objeto completo (defaults + lo guardado). */
  async get(clave: string) {
    const cacheado = this.cache.get(clave);
    if (cacheado) return cacheado;

    const defaults = this.defaultsDe(clave);
    const [row] = await this.db.select().from(configuracion).where(eq(configuracion.clave, clave)).limit(1);
    const valor = sanitize(defaults, row?.valor);
    this.cache.set(clave, valor);
    return valor;
  }

  /** Merge parcial: el cliente manda solo lo que cambió. */
  async set(clave: string, patch: any) {
    const defaults = this.defaultsDe(clave);
    const actual = await this.get(clave);
    const valor = sanitize(defaults, { ...actual, ...(patch && typeof patch === 'object' ? patch : {}) });

    await this.db
      .insert(configuracion)
      .values({ clave, valor })
      .onConflictDoUpdate({ target: configuracion.clave, set: { valor, updatedAt: new Date() } });

    this.cache.set(clave, valor);
    return valor;
  }
}

@Controller('configuracion')
export class ConfiguracionController {
  constructor(private readonly svc: ConfiguracionService) {}

  @Get(':clave') get(@Param('clave') clave: string) { return this.svc.get(clave); }
  @Put(':clave') set(@Param('clave') clave: string, @Body() body: any) { return this.svc.set(clave, body); }
}

@Module({
  controllers: [ConfiguracionController],
  providers: [ConfiguracionService],
  exports: [ConfiguracionService],
})
export class ConfiguracionModule {}
