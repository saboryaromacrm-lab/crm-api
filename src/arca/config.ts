/**
 * ARCA — configuración y el interruptor general
 * ============================================================================
 * Todo lo que este módulo sabe del entorno vive acá. El resto del código de
 * ARCA no lee `process.env` ni decide URLs: las pide a este archivo.
 *
 * TRES DECISIONES QUE SE TOMAN ACÁ:
 *
 * 1. **El CUIT sale del ENTORNO, no de la configuración de la empresa.** El
 *    CUIT con el que se factura tiene que ser EXACTAMENTE el del certificado
 *    (ARCA compara y rechaza), así que va atado al certificado y no a un campo
 *    que se edita desde una pantalla. El de `configuracion.empresa` sigue
 *    siendo el del membrete; `diferenciasConEmpresa()` compara los dos y avisa
 *    si divergen — un CUIT distinto en el papel y en el comprobante es un
 *    problema fiscal que nadie ve hasta que lo mira un inspector.
 *
 * 2. **El punto de venta de web services es PROPIO.** El de "Factura en Línea"
 *    (el de facturar a mano en la web de ARCA) no sirve para el webservice y
 *    tiene su NUMERACIÓN INDEPENDIENTE. Pueden convivir —conviene, como plan B
 *    si el servicio se cae— así que este número puede ser distinto del
 *    `puntoVenta` que usan los tickets internos, y no se mezclan.
 *
 * 3. **Las rutas de los certificados NO tienen default dentro del proyecto.**
 *    Es la trampa §9.3 de la guía: un default tipo `join(cwd, 'certs', ...)`
 *    termina copiando la clave privada adentro del artefacto de deploy. Acá el
 *    equivalente es la imagen Docker, que se reconstruye entera en cada deploy:
 *    los certificados van en un VOLUMEN MONTADO, fuera de la imagen y fuera de
 *    cualquier carpeta servida. Sin variable de entorno, no hay ruta, y sin
 *    ruta la facturación queda dormida — que es exactamente lo que se quiere.
 */
import { existsSync } from 'node:fs';

const PROD = String(process.env.ARCA_ENV || '').toLowerCase() === 'produccion';

/** Solo los 11 dígitos: así lo quiere el bloque `Auth` del WSFE. */
const soloDigitos = (v: unknown) => String(v ?? '').replace(/\D/g, '');

export const ARCA = {
  produccion: PROD,

  /** CUIT del emisor, 11 dígitos. Tiene que coincidir con el del certificado. */
  cuit: soloDigitos(process.env.ARCA_CUIT),

  /** Punto de venta tipo "Web Services". Ver decisión 2 del encabezado. */
  ptoVta: Number(process.env.ARCA_PTO_VTA) || 0,

  /*
   * Los endpoints. Homologación no tiene ningún valor fiscal: es donde se
   * desarrolla y se prueba todo. Producción emite facturas de verdad.
   */
  wsaaUrl: PROD
    ? 'https://wsaa.afip.gov.ar/ws/services/LoginCms'
    : 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
  wsfeUrl: PROD
    ? 'https://servicios1.afip.gov.ar/wsfev1/service.asmx'
    : 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
  padronUrl: PROD
    ? 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5'
    : 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5',

  /** Sin default a propósito: ver decisión 3 del encabezado. */
  certPath: process.env.ARCA_CERT_PATH || '',
  keyPath: process.env.ARCA_KEY_PATH || '',

  /**
   * Cuánto se espera a ARCA antes de darlo por caído. Corto a propósito: hay
   * una cajera con un cliente enfrente, y el circuito de caída ya existe (sale
   * el ticket provisorio y la factura queda pendiente). Preferimos un
   * provisorio a los 12 segundos que una caja congelada un minuto.
   */
  timeoutMs: Number(process.env.ARCA_TIMEOUT_MS) || 12_000,
} as const;

/* ------------------------------------------------------------------ *
 * El interruptor general
 * ------------------------------------------------------------------ */

/**
 * `null` = todavía no se miró. Se cachea porque `existsSync` corre en cada
 * venta y el disco no cambia solo.
 *
 * OJO al operar: después de subir o RENOMBRAR un certificado hay que
 * **reiniciar la API**. Es la trampa §9.8 — Windows esconde las extensiones y
 * el archivo termina como `certificado.crt.crt`; se corrige el nombre, se
 * recarga la página y sigue diciendo "sin certificado" porque esto está
 * cacheado. `resetDisponible()` existe para que el panel de diagnóstico pueda
 * forzar la relectura sin reiniciar.
 */
let cacheDisponible: boolean | null = null;

/**
 * ¿Se puede facturar? Sin certificado, TODA la facturación se apaga sola y el
 * sistema opera exactamente como antes.
 *
 * Es lo que permite desplegar sin riesgo: el código sube a producción con la
 * facturación dormida, se verifica que el POS funciona igual, y se prende
 * recién al cargar los certificados. Va como guarda al principio de cada
 * función pública del módulo.
 */
export function arcaDisponible(): boolean {
  if (cacheDisponible === null) {
    cacheDisponible = !!ARCA.cuit && !!ARCA.ptoVta
      && !!ARCA.certPath && !!ARCA.keyPath
      && existsSync(ARCA.certPath) && existsSync(ARCA.keyPath);
  }
  return cacheDisponible;
}

/** Fuerza releer el disco (lo usa el panel de diagnóstico). */
export function resetDisponible(): void {
  cacheDisponible = null;
}

/**
 * POR QUÉ NO SE PUEDE FACTURAR, en castellano. Un "no disponible" pelado
 * manda a adivinar entre cinco causas; esto dice cuál es.
 */
export function motivoNoDisponible(): string | null {
  if (arcaDisponible()) return null;
  if (!ARCA.cuit) return 'Falta ARCA_CUIT (el CUIT del emisor, 11 dígitos).';
  if (ARCA.cuit.length !== 11) return `ARCA_CUIT tiene ${ARCA.cuit.length} dígitos y necesita 11.`;
  if (!ARCA.ptoVta) return 'Falta ARCA_PTO_VTA (el punto de venta tipo "Web Services").';
  if (!ARCA.certPath) return 'Falta ARCA_CERT_PATH (la ruta al certificado .crt).';
  if (!ARCA.keyPath) return 'Falta ARCA_KEY_PATH (la ruta a la clave privada .key).';
  if (!existsSync(ARCA.certPath)) {
    return `No existe el certificado en ${ARCA.certPath}. Revisá el nombre EXACTO del archivo `
      + '(Windows esconde las extensiones y suele quedar ".crt.crt") y reiniciá la API.';
  }
  if (!existsSync(ARCA.keyPath)) {
    return `No existe la clave privada en ${ARCA.keyPath}. Mismo chequeo que el certificado.`;
  }
  return 'Configuración de ARCA incompleta.';
}

/**
 * Compara lo que sabe ARCA con lo que dice el membrete de la empresa. No
 * bloquea nada —el que manda es el certificado— pero un CUIT distinto en el
 * papel y en el comprobante hay que verlo ANTES de emitir mil facturas.
 */
export function diferenciasConEmpresa(empresa: { cuit?: string } | null): string[] {
  const avisos: string[] = [];
  const suyo = soloDigitos(empresa?.cuit);
  if (ARCA.cuit && suyo && suyo !== ARCA.cuit) {
    avisos.push(
      `El CUIT con el que se factura (${ARCA.cuit}) no es el de Sistema › Empresa (${suyo}). `
      + 'El de ARCA es el del certificado y es el que manda; corregí el del membrete.',
    );
  }
  return avisos;
}
