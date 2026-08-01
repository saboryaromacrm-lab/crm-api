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
  listasPrecio: ['Minorista', 'Mayorista', 'Oferta'] as string[],
  listaPrecioDefault: 'Minorista' as string,
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
  presupuestoValidezDias: 15 as number,
  presupuestoReservaStock: false as boolean, // mueve disponible → comprometido

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
export const CONFIG_DEFAULTS: Record<string, Record<string, any>> = {
  ventas: VENTAS_DEFAULTS,
};

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
      out[k] = Array.isArray(v)
        ? v.map((x) => String(x).trim()).filter(Boolean)
        : [...def];
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
