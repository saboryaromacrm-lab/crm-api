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
  Body, Controller, ForbiddenException, Get, Inject, Injectable, Module,
  NotFoundException, Param, Put,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { Auth, Sesion } from '../auth/auth.decoradores';
import { tienePermiso } from '../auth/auth.guard';
// El MISMO normalizador que usan comprobantes y facturas: el punto de venta
// tiene que quedar igual venga de donde venga (ver REGLAS, más abajo).
import { normalizarPuntoVenta } from '../facturas/facturas.module';
import { configuracion } from '../db/schema';

/** Preferencias del circuito de ventas. */
export const VENTAS_DEFAULTS = {
  /* Comprobantes ------------------------------------------------------- */
  /* Acá vivía `comprobanteDefault`, que no leía NADIE y que ninguna pantalla
   * dejaba editar: qué comprobante sale lo decide `tipoVentaPara()` mirando
   * `arcaHabilitado`. Una clave del contrato que prometía una opción
   * inexistente. */
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
  /**
   * Medios que EXIGEN factura (19/8/2026, pedido del dueño): una venta cobrada
   * —aunque sea en parte— con uno de estos no puede salir como ticket interno.
   * El POS bloquea "Liquidar" con el motivo a la vista y la API lo revalida al
   * confirmar. El caso típico: lo bancarizado (transferencia, tarjetas) deja
   * rastro y tiene que estar facturado sí o sí.
   */
  mediosFacturar: [] as string[],

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
  // El remito a Cafetería se imprime todos los días y NO estaba en este
  // catálogo: caía al A4 por defecto y no había forma de mandarlo al rollo.
  remitoCafeteria: 'a4' as string,
  // La planilla del control de stock: la hoja que se lleva a la góndola para
  // anotar a lápiz lo que hay. Papel grande — en un rollo de 80 mm el renglón
  // no entra y no queda lugar para escribir.
  planillaConteo: 'a4' as string,
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

/* ---------------- Rangos y formatos por campo ---------------- */

/**
 * EL CATÁLOGO DE DEFAULTS DICE EL TIPO; ESTO DICE QUÉ VALORES TIENEN SENTIDO.
 *
 * Sin esto, `sanitize` aceptaba cualquier número finito y el único control de
 * dominio vivía en el `<select>` de la pantalla. El caso que lo vuelve urgente:
 * `redondeoPrecio: 100000` hace que `Math.round(precio / redondeo) * redondeo`
 * dé **0** para todo lo que valga menos de $50.000 — en el punto de venta y en
 * el catálogo público del sitio— y el portero de precios ni se entera, porque
 * el precio de lista calculado también es 0 (no hay "precio pisado" que
 * denunciar).
 *
 * LAS REGLAS NORMALIZAN, NO RECHAZAN, y es a propósito: `sanitize` corre
 * también al LEER, así que una regla que lanzara excepción convertiría un valor
 * viejo o mal guardado en una pantalla caída para siempre. Acomodar es seguro
 * en las dos direcciones y es idempotente.
 */
/*
 * LOS FORMATOS DE PAPEL Y LOS DE ETIQUETA SON DOS MUNDOS.
 *
 * Espejo de `FORMATOS` en `crm-dashboard/src/core/services/imprimir.js` — son
 * proyectos separados, así que la lista está duplicada como las de ofertas; lo
 * que no puede pasar es que DIVERJAN, y por eso está dicho acá.
 *
 * La separación no es cosmética: el motor decide por el formato si el documento
 * sale por el camino del papel o por el de las etiquetas. Un `ticketPos:
 * 'etiqueta50x30'` mandaba TODOS los tickets del punto de venta al camino de la
 * etiqueta — sin membrete, sin total y sin la leyenda no fiscal— y un valor
 * inventado caía a A4, con lo que el rollo de 80 mm salía en hoja.
 */
const FORMATOS_PAPEL = ['rollo80', 'rollo58', 'a4', 'carta'];
const FORMATOS_ETIQUETA = ['etiqueta50x30', 'etiqueta50x25', 'etiqueta40x25', 'etiqueta60x40'];

const REGLAS: Record<string, {
  valores?: number[]; opciones?: string[]; min?: number; max?: number;
  entero?: boolean; texto?: (v: string) => string;
}> = {
  /* Impresión: cada documento solo acepta los formatos de SU mundo. */
  'impresion.ticketPos': { opciones: FORMATOS_PAPEL },
  'impresion.presupuesto': { opciones: FORMATOS_PAPEL },
  'impresion.hojaArmado': { opciones: FORMATOS_PAPEL },
  'impresion.listaPreparacion': { opciones: FORMATOS_PAPEL },
  'impresion.remitoCafeteria': { opciones: FORMATOS_PAPEL },
  'impresion.planillaConteo': { opciones: FORMATOS_PAPEL },
  'impresion.etiquetaFraccionado': { opciones: FORMATOS_ETIQUETA },

  /* Los redondeos son una LISTA CERRADA, no un rango: son las monedas con las
   * que se trabaja. Cualquier otra cosa vuelve al default. */
  'ventas.redondeoPrecio': { valores: [0, 1, 10, 50, 100] },
  'ventas.redondeoEfectivo': { valores: [0, 1, 10, 50, 100] },
  /* `1e308` es finito, así que pasaba el filtro del Infinity y llegaba a
   * `Date.now() + dias * 86400000`, que sí desborda: fecha inválida y 500 en
   * cada envío de presupuesto. Un negativo era peor porque no rompe nada
   * visible: TODA orden web nacía vencida y el canal del sitio quedaba muerto. */
  'ventas.presupuestoValidezDias': { min: 1, max: 365, entero: true },
  'ventas.descuentoMaxVendedor': { min: 0, max: 100 },
  'ventas.ctaCteDiasPlazo': { min: 0, max: 365, entero: true },
  'ventas.ctaCteLimiteDefault': { min: 0, max: 100_000_000 },
  'ventas.montoMinimoMayorista': { min: 0, max: 100_000_000 },
  'ventas.montoMinimoCamioneta': { min: 0, max: 100_000_000 },
  'ventas.listaBaseId': { min: 0, max: 1_000_000, entero: true },
  'ventas.modalidadMontoId': { min: 0, max: 1_000_000, entero: true },
  /* El punto de venta se normaliza con la MISMA función que usan comprobantes
   * y facturas — era el único de los cuatro lugares que no la usaba. No es
   * cosmético: `punto_venta` entra en el índice único de la numeración, así que
   * un "00A1 " arrancaba una serie paralela desde 1. */
  'ventas.puntoVenta': { texto: normalizarPuntoVenta },
  'empresa.cuit': { texto: cuitNormalizado },
  'empresa.colorMarca': { texto: colorNormalizado },
};

/**
 * CUIT en el formato de siempre cuando se puede: 11 dígitos → `XX-XXXXXXXX-X`.
 * Lo que no llegue a 11 dígitos se deja tal como se tipeó, porque hoy el CUIT
 * solo se IMPRIME en el membrete: borrarlo en silencio sería peor que mostrarlo
 * a medio cargar. La validación dura (con dígito verificador) va cuando se
 * prenda ARCA, que es donde el número se usa de verdad.
 */
function cuitNormalizado(v: string): string {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length === 11 ? `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}` : String(v ?? '').trim();
}

/** Un color de verdad o el de la marca: entra en un `<style>` del impreso. */
function colorNormalizado(v: string): string {
  return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(String(v ?? '').trim()) ? String(v).trim() : '#166534';
}

/**
 * Aplica la regla de un campo, si tiene. Devuelve el valor ya acomodado.
 *
 * Se llama desde LAS CUATRO ramas de `sanitize`, incluso las de array y
 * booleano que hoy no tienen ninguna regla. Es a propósito: cuando corría solo
 * en la rama numérica y la de texto, una regla nueva sobre un array —por
 * ejemplo para cerrar la lista de medios de pago— **no se habría aplicado y no
 * habría avisado**. Es la trampa de la lista explícita incompleta, la misma que
 * ya mordió con el campo mal escrito de un DTO.
 */
function aplicarRegla(clave: string, campo: string, valor: any, porDefecto: any) {
  const r = REGLAS[`${clave}.${campo}`];
  if (!r) return valor;
  if (r.opciones) {
    const s = String(valor ?? '');
    return r.opciones.includes(s) ? s : porDefecto;
  }
  if (r.texto) return r.texto(String(valor ?? ''));
  let n = Number(valor);
  if (!Number.isFinite(n)) return porDefecto;
  if (r.valores) return r.valores.includes(n) ? n : porDefecto;
  if (r.entero) n = Math.round(n);
  if (r.min != null) n = Math.max(r.min, n);
  if (r.max != null) n = Math.min(r.max, n);
  return n;
}

/**
 * UNA RUTA INTERNA, y nada más. El `ctaUrl` de un slide llega como string pero
 * NO es texto libre: en el panel es un `<select>` de cinco rutas del propio
 * sitio, pero ese control vive solo en el navegador. Sin esto, un `PUT` a mano
 * a la configuración deja el botón principal de la portada PÚBLICA apuntando al
 * dominio de un tercero — con la marca de la casa arriba, que es exactamente la
 * forma de un phishing de cobranzas.
 *
 * La regla no es la lista exacta de cinco (se agranda sola cuando sumen otro
 * link interno) sino el invariante de verdad: el botón enlaza DENTRO del sitio.
 * Una ruta interna empieza con '/', no con '//' (eso es protocolo-relativo, se
 * va afuera) y no lleva ':' (ni `http:` ni `javascript:`). Lo que no cumple cae
 * a la portada, nunca afuera.
 */
/*
 * SE PREGUNTA CON EL MISMO PARSER QUE DECIDE, no con condiciones a mano.
 *
 * La primera versión miraba "empieza con /", "no empieza con //" y "no tiene
 * dos puntos" — y se le escapaba `/\evil.com`: cumple las tres y el parser de
 * los navegadores normaliza la barra invertida a barra, así que ese botón
 * llevaba a `https://evil.com/`. Justo el phishing con la marca de la casa que
 * la función existía para impedir.
 *
 * Adivinar qué texto va a resolver adentro del sitio es una carrera perdida
 * (quedan `%2F`, los espacios en blanco raros, lo que agregue el estándar
 * mañana). Así que se resuelve contra una base de mentira y se compara el
 * ORIGEN: si cambió, no era una ruta interna. Devuelve la ruta ya normalizada.
 */
const BASE_INTERNA = 'https://interno.invalido';
const rutaInterna = (v: string): string => {
  const s = String(v ?? '').trim();
  if (!s.startsWith('/')) return '/';
  try {
    const u = new URL(s, BASE_INTERNA);
    return u.origin === BASE_INTERNA ? `${u.pathname}${u.search}${u.hash}` : '/';
  } catch { return '/'; }
};

/** Campos de un ítem que se saben más que texto libre. Hoy solo el `ctaUrl`. */
const NORMALIZADORES: Record<string, (v: string) => string> = { ctaUrl: rutaInterna };

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
      const s = typeof v === 'string' ? v.trim() : '';
      out[k] = NORMALIZADORES[k] ? NORMALIZADORES[k](s) : s;
    }
  }
  return out;
}

/**
 * Deja `raw` con exactamente las claves de `defaults` y sus tipos. Lo que no
 * coincide vuelve al default; lo desconocido se descarta.
 *
 * `clave` es el ÁREA (`ventas`, `empresa`…): con ella se buscan las REGLAS de
 * rango y formato de cada campo, que es lo que el tipo por sí solo no alcanza a
 * decir (un número finito puede ser un desastre igual).
 */
function sanitize(defaults: Record<string, any>, raw: any, clave = ''): Record<string, any> {
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
      out[k] = aplicarRegla(clave, k, out[k], def);
    } else if (typeof def === 'boolean') {
      out[k] = aplicarRegla(clave, k, typeof v === 'boolean' ? v : def, def);
    } else if (typeof def === 'number') {
      const n = Number(v);
      out[k] = aplicarRegla(clave, k, Number.isFinite(n) ? n : def, def);
    } else {
      const s = typeof v === 'string' && v.trim() ? v.trim() : def;
      out[k] = aplicarRegla(clave, k, s, def);
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

  /*
   * SOLO LAS CLAVES PROPIAS DEL MAPA, no las que hereda de `Object`.
   *
   * `CONFIG_DEFAULTS[clave]` "acertaba" con nombres como `constructor` o
   * `toString`, porque el mapa es un objeto común y los hereda. Con eso,
   * `GET /configuracion/constructor` devolvía 200 con un objeto vacío en vez de
   * 404, y el `PUT` terminaba en un 500 (o metía una fila basura en la tabla).
   * No había salteo de permisos —fallaba cerrado de casualidad— pero un 404 es
   * la respuesta correcta. (`hasOwnProperty` desde el prototipo y no del propio
   * objeto: es el mapa el que no es de confianza.)
   */
  private defaultsDe(clave: string) {
    if (!Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, clave)) {
      throw new NotFoundException(`No existe la configuración "${clave}".`);
    }
    return CONFIG_DEFAULTS[clave];
  }

  /** Siempre devuelve el objeto completo (defaults + lo guardado). */
  async get(clave: string) {
    const cacheado = this.cache.get(clave);
    if (cacheado) return cacheado;

    const defaults = this.defaultsDe(clave);
    const [row] = await this.db.select().from(configuracion).where(eq(configuracion.clave, clave)).limit(1);
    const valor = sanitize(defaults, row?.valor, clave);
    this.cache.set(clave, valor);
    return valor;
  }

  /** Merge parcial: el cliente manda solo lo que cambió. */
  async set(clave: string, patch: any) {
    const defaults = this.defaultsDe(clave);
    const actual = await this.get(clave);
    const valor = sanitize(defaults, { ...actual, ...(patch && typeof patch === 'object' ? patch : {}) }, clave);

    await this.db
      .insert(configuracion)
      .values({ clave, valor })
      .onConflictDoUpdate({ target: configuracion.clave, set: { valor, updatedAt: new Date() } });

    this.cache.set(clave, valor);
    return valor;
  }
}

/**
 * QUIÉN PUEDE ESCRIBIR CADA ÁREA.
 *
 * El permiso no puede ser del controller ni del método: depende de la CLAVE que
 * llega en la URL, y son cuatro dueños distintos. Por eso se resuelve a mano con
 * el mismo `tienePermiso` que usa el guard, en vez de un `@Permiso` estático que
 * tendría que ser el más flojo de los cuatro.
 *
 * No es cosmética: estas claves son los interruptores de seguridad del módulo.
 * Un solo `PUT /configuracion/ventas` apagaba `cajaObligatoria` (vender sin
 * turno, o sea sin arqueo), prendía `permitirStockNegativo`, soltaba el tope de
 * crédito y arrancaba una serie de numeración paralela con otro `puntoVenta`.
 */
const DUENO_DE_AREA: Record<string, string[]> = {
  ventas: ['ventas.configuracion'],
  empresa: ['sistema.empresa'],
  impresion: ['sistema.impresion'],
  web: ['web.configuracion'],
};

@Controller('configuracion')
export class ConfiguracionController {
  constructor(private readonly svc: ConfiguracionService) {}

  /*
   * La LECTURA queda abierta a sesión válida: el POS necesita la config de
   * ventas para cotizar, la etiqueta necesita la de impresión y el encabezado de
   * cualquier documento necesita la de empresa. No hay plata ni datos personales
   * acá — son reglas del negocio.
   */
  @Get(':clave') get(@Param('clave') clave: string) { return this.svc.get(clave); }

  @Put(':clave')
  set(@Param('clave') clave: string, @Body() body: any, @Auth() sesion: Sesion) {
    const claves = DUENO_DE_AREA[clave];
    // Área desconocida: 404 como el servicio, sin filtrar si existe o no.
    if (!claves) throw new NotFoundException(`No existe la configuración "${clave}".`);
    if (!tienePermiso(sesion.permisos, claves)) {
      throw new ForbiddenException('Tu rol no tiene permiso para cambiar esta configuración.');
    }
    /*
     * El body sigue siendo `any` A PROPÓSITO. `sanitize` (arriba) ya es el
     * portero de tipos: deja exactamente las claves de los defaults, coacciona
     * cada tipo, descarta lo desconocido y devuelve al default lo que no sea un
     * número finito (así `1e999` no entra). Un DTO por área sería una SEGUNDA
     * definición de la misma forma, y cuando una regla vive en dos lugares uno
     * de los dos ya está mal. El objeto de defaults es el esquema.
     */
    return this.svc.set(clave, body);
  }
}

@Module({
  controllers: [ConfiguracionController],
  providers: [ConfiguracionService],
  exports: [ConfiguracionService],
})
export class ConfiguracionModule {}
