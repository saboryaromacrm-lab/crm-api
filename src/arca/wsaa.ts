/**
 * WSAA — el ticket de acceso
 * ============================================================================
 * Para hablar con cualquier webservice de ARCA hace falta un **ticket de
 * acceso** (token + sign). Se consigue firmando un XML con el certificado en
 * formato CMS/PKCS#7 y mandándolo por SOAP. Dura ~12 horas.
 *
 * TRES COSAS QUE NO SON OPCIONALES:
 *
 * 1. **Se firma con node-forge, no con el binario `openssl`.** El servidor
 *    puede no tenerlo — el contenedor de esta API es `node:22-alpine`, que
 *    viene pelado. Una dependencia JS anda en cualquier lado.
 *
 * 2. **El cache es obligatorio, no una optimización.** ARCA RECHAZA pedir un
 *    ticket nuevo mientras haya otro vigente. Sin cache, el primer reinicio
 *    deja la facturación trabada hasta doce horas.
 *
 * 3. **Los sellos de tiempo llevan el offset explícito** (ver `fecha.ts`). Es
 *    la trampa que hace que esto ande en desarrollo y falle en el servidor.
 */
import { readFileSync } from 'node:fs';
import * as forge from 'node-forge';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/drizzle';
import { arcaTokens } from '../db/schema';
import { ARCA, arcaDisponible, motivoNoDisponible } from './config';
import { selloWsaa } from './fecha';

export interface TicketAcceso {
  token: string;
  sign: string;
  expiresAt: Date;
}

/** Servicios a los que se pide acceso. Cada uno lleva su propio ticket. */
export type ServicioArca = 'wsfe' | 'ws_sr_constancia_inscripcion';

/**
 * LA CLAVE DEL CACHE LLEVA EL ENTORNO — trampa §9.7.
 *
 * Un ticket de homologación no sirve en producción. Con una sola clave, al
 * cambiar de entorno el sistema le manda al ARCA real el permiso de pruebas:
 * lo rechaza, y como el anterior sigue vigente tampoco entrega uno nuevo.
 * Doce horas de facturas trabadas, el primer día en producción.
 */
const claveCache = (s: ServicioArca) => (ARCA.produccion ? `${s}@prod` : s);

/** Nivel 1 del cache: memoria del proceso. */
const enMemoria = new Map<string, TicketAcceso>();

/** Margen para no usar nunca uno a punto de vencer en medio de una emisión. */
const MARGEN_MS = 2 * 60_000;

const vigente = (t: { expiresAt: Date } | null | undefined) =>
  !!t && t.expiresAt.getTime() > Date.now() + MARGEN_MS;

/* ------------------------------------------------------------------ *
 * La firma
 * ------------------------------------------------------------------ */

/**
 * El `loginTicketRequest`, firmado en CMS/PKCS#7 y en base64.
 *
 * `generationTime` va 10 minutos al pasado y `expirationTime` 10 al futuro: es
 * la tolerancia para que un reloj corrido unos minutos no tire abajo la
 * emisión. ARCA rechaza un `generationTime` en el futuro o de más de 24 horas.
 *
 * El `uniqueId` tiene que cambiar en cada pedido — si se repite dentro de la
 * misma ventana, ARCA lo toma por un reenvío.
 */
function armarCms(service: ServicioArca): string {
  const cert = readFileSync(ARCA.certPath, 'utf8');
  const key = readFileSync(ARCA.keyPath, 'utf8');
  const ahora = Date.now();

  const tra = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<loginTicketRequest version="1.0">'
    + '<header>'
    + `<uniqueId>${Math.floor(ahora / 1000)}</uniqueId>`
    + `<generationTime>${selloWsaa(new Date(ahora - 10 * 60_000))}</generationTime>`
    + `<expirationTime>${selloWsaa(new Date(ahora + 10 * 60_000))}</expirationTime>`
    + '</header>'
    + `<service>${service}</service>`
    + '</loginTicketRequest>';

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key: forge.pki.privateKeyFromPem(key) as any,
    certificate: forge.pki.certificateFromPem(cert),
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date(ahora).toISOString() },
    ],
  });
  p7.sign();
  return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary').toString('base64');
}

/* ------------------------------------------------------------------ *
 * El diálogo con ARCA
 * ------------------------------------------------------------------ */

const entreTags = (xml: string, tag: string): string => {
  // Los tags pueden venir con prefijo de namespace (`<ns:token>`), así que el
  // patrón lo contempla en vez de asumir el nombre pelado.
  const m = new RegExp(`<(?:\\w+:)?${tag}>([\\s\\S]*?)</(?:\\w+:)?${tag}>`).exec(xml);
  return m ? m[1].trim() : '';
};

const desescapar = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

/** "Ya posee un TA válido": ARCA no da otro hasta que venza el anterior. */
const esErrorTaVigente = (e: unknown) =>
  /ya posee un ta valido|ya posee un TA v[aá]lido|alreadyAuthenticated/i.test(String((e as Error)?.message ?? e));

async function pedirTicket(service: ServicioArca): Promise<TicketAcceso> {
  const cms = armarCms(service);
  const sobre = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" '
    + 'xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">'
    + '<soapenv:Header/><soapenv:Body><wsaa:loginCms>'
    + `<wsaa:in0>${cms}</wsaa:in0>`
    + '</wsaa:loginCms></soapenv:Body></soapenv:Envelope>';

  const res = await fetch(ARCA.wsaaUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '' },
    body: sobre,
    signal: AbortSignal.timeout(ARCA.timeoutMs),
  });
  const xml = await res.text();

  const fault = entreTags(xml, 'faultstring');
  if (fault) throw new Error(`WSAA rechazó el pedido: ${desescapar(fault)}`);
  if (!res.ok) throw new Error(`WSAA respondió HTTP ${res.status}.`);

  // La respuesta trae el loginTicketResponse ESCAPADO dentro del sobre SOAP.
  const interno = desescapar(entreTags(xml, 'loginCmsReturn'));
  const token = entreTags(interno, 'token');
  const sign = entreTags(interno, 'sign');
  const expira = entreTags(interno, 'expirationTime');
  if (!token || !sign) throw new Error('WSAA contestó sin token: revisá el certificado y su autorización al servicio.');

  const expiresAt = expira ? new Date(expira) : new Date(Date.now() + 11 * 3600_000);
  return { token, sign, expiresAt };
}

/* ------------------------------------------------------------------ *
 * La puerta pública
 * ------------------------------------------------------------------ */

/**
 * El ticket vigente para un servicio. Busca en memoria → base → ARCA.
 *
 * El `catch` del final no es paranoia: pasa de verdad al reiniciar la API o al
 * correr dos pruebas seguidas. Si ARCA dice "ya tenés uno" y nosotros tenemos
 * la copia guardada, esa copia es **el único ticket que va a aceptar** hasta
 * que venza — usarla es lo correcto, no un parche.
 */
export async function obtenerTicket(db: Database, service: ServicioArca): Promise<TicketAcceso> {
  if (!arcaDisponible()) throw new Error(motivoNoDisponible() ?? 'ARCA no está configurado.');

  const clave = claveCache(service);

  const mem = enMemoria.get(clave);
  if (vigente(mem)) return mem!;

  const [guardado] = await db.select().from(arcaTokens).where(eq(arcaTokens.service, clave)).limit(1);
  if (vigente(guardado)) {
    const t: TicketAcceso = { token: guardado.token, sign: guardado.sign, expiresAt: guardado.expiresAt };
    enMemoria.set(clave, t);
    return t;
  }

  try {
    const nuevo = await pedirTicket(service);
    await db.insert(arcaTokens)
      .values({ service: clave, token: nuevo.token, sign: nuevo.sign, expiresAt: nuevo.expiresAt })
      .onConflictDoUpdate({
        target: arcaTokens.service,
        set: { token: nuevo.token, sign: nuevo.sign, expiresAt: nuevo.expiresAt, updatedAt: new Date() },
      });
    enMemoria.set(clave, nuevo);
    return nuevo;
  } catch (e) {
    if (guardado && esErrorTaVigente(e)) {
      const t: TicketAcceso = { token: guardado.token, sign: guardado.sign, expiresAt: guardado.expiresAt };
      enMemoria.set(clave, t);
      return t;
    }
    throw e;
  }
}

/** Tira el ticket cacheado (lo usa el diagnóstico para forzar uno nuevo). */
export function olvidarTicket(service: ServicioArca): void {
  enMemoria.delete(claveCache(service));
}
