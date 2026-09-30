/**
 * ARCA — CONSULTA DE CUIT (constancia de inscripción) · 0125, 30/9/2026
 * ============================================================================
 * Para facturar a un CUIT desde la caja: con el número, ARCA devuelve razón
 * social, condición frente al IVA y domicilio fiscal. La condición de IVA la
 * trae ARCA y NO la tipea el cajero — es lo que decide si sale Factura A o B.
 *
 * Servicio `ws_sr_constancia_inscripcion` (en ARCA: «Consulta de constancia
 * de inscripción»), método `getPersona_v2`. Usa la misma URL que el padrón
 * «alcance 5» y el mismo certificado que la facturación, pero necesita SU
 * autorización en el Administrador de Relaciones de ARCA.
 *
 * Igual que `wsfe.ts`: plantilla XML fija + `fetch` + extracción por regex.
 *
 * LO CONSULTADO SE GUARDA 7 DÍAS (`padron_cuit`): el mismo CUIT no se le
 * vuelve a preguntar a ARCA en cada venta — responde al instante y no depende
 * de que ARCA esté arriba en ese momento.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../db/drizzle';
import { padronCuit, type ReceptorVenta } from '../db/schema';
import { ARCA } from './config';
import { obtenerTicket } from './wsaa';

export interface DatosPadron {
  cuit: string;
  nombre: string;
  condicionIva: ReceptorVenta['condicionIva'];
  direccion: string;
  localidad: string;
  provincia: string;
  /** 'ACTIVO' normalmente; otro valor = la clave está inactiva o limitada. */
  estado: string;
  tipoPersona: string;
  /** Algo para mostrar al cajero (clave inactiva, sin impuestos registrados…). */
  aviso: string;
}

/** Un error de la consulta. `reintentable=false` = el dato está mal (no existe el CUIT). */
export class ErrorPadron extends Error {
  constructor(message: string, readonly reintentable: boolean) {
    super(message);
    this.name = 'ErrorPadron';
  }
}

const CACHE_DIAS = 7;

/* ---------------------------- El CUIT en sí ---------------------------- */

export const soloDigitos = (v: unknown) => String(v ?? '').replace(/\D/g, '');

/**
 * ¿El CUIT es válido? Once dígitos y el dígito verificador (módulo 11 con los
 * pesos 5-4-3-2-7-6-5-4-3-2). Un número mal tipeado se ataja acá, antes de ir
 * a ARCA y antes de que salga una factura a nombre de otro.
 */
export function cuitValido(v: unknown): boolean {
  const c = soloDigitos(v);
  if (c.length !== 11) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((a, p, i) => a + p * Number(c[i]), 0);
  const resto = 11 - (suma % 11);
  const dv = resto === 11 ? 0 : resto === 10 ? 9 : resto;
  return dv === Number(c[10]);
}

/* --------------------------- Leer la respuesta --------------------------- */

const desescapar = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml: string, t: string): string => {
  const m = new RegExp(`<(?:\\w+:)?${t}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${t}>`).exec(xml);
  return m ? desescapar(m[1].trim()) : '';
};
const todos = (xml: string, t: string): string[] => {
  const re = new RegExp(`<(?:\\w+:)?${t}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${t}>`, 'g');
  const out: string[] = [];
  let m = re.exec(xml);
  while (m) { out.push(m[1]); m = re.exec(xml); }
  return out;
};

/**
 * La respuesta de `getPersona_v2`, traducida. Función pura: se prueba con
 * respuestas de ejemplo sin salir a la red.
 *
 * LA CONDICIÓN DE IVA:
 *   · monotributista → «datosMonotributo» con contenido.
 *   · Responsable Inscripto → impuesto 30 (IVA) en el régimen general.
 *   · Exento → impuesto 32 (IVA EXENTO).
 *   · Nada de eso → consumidor final (factura B).
 */
export function interpretarPersona(xml: string, cuit: string): DatosPadron {
  const general = tag(xml, 'datosGenerales');
  const errores = todos(tag(xml, 'errorConstancia'), 'error').map((e) => desescapar(e.trim())).filter(Boolean);
  if (!general) {
    const motivo = errores[0] || 'ARCA no devolvió datos para ese CUIT.';
    throw new ErrorPadron(`CUIT ${cuit}: ${motivo}`, false);
  }
  const razon = tag(general, 'razonSocial');
  const nombre = razon || [tag(general, 'apellido'), tag(general, 'nombre')].filter(Boolean).join(' ');
  const dom = tag(general, 'domicilioFiscal');
  const mono = tag(xml, 'datosMonotributo');
  const regimen = tag(xml, 'datosRegimenGeneral');
  const impuestos = todos(regimen, 'impuesto').map((i) => Number(tag(i, 'idImpuesto')));
  const condicionIva: DatosPadron['condicionIva'] = mono
    ? 'monotributo'
    : impuestos.includes(30) ? 'responsable_inscripto'
      : impuestos.includes(32) ? 'exento'
        : 'consumidor_final';
  const estado = tag(general, 'estadoClave') || 'ACTIVO';
  const avisos: string[] = [];
  if (estado.toUpperCase() !== 'ACTIVO') avisos.push(`La clave figura ${estado.toLowerCase()} en ARCA.`);
  if (condicionIva === 'consumidor_final') avisos.push('No figura inscripto en IVA ni en el monotributo: sale Factura B.');
  return {
    cuit,
    nombre: nombre || `CUIT ${cuit}`,
    condicionIva,
    direccion: tag(dom, 'direccion'),
    localidad: tag(dom, 'localidad'),
    provincia: tag(dom, 'descripcionProvincia'),
    estado,
    tipoPersona: tag(general, 'tipoPersona'),
    aviso: avisos.join(' '),
  };
}

/* ------------------------------ La llamada ------------------------------ */

async function pedirPersona(db: Database, cuit: string): Promise<DatosPadron> {
  let ta;
  try {
    ta = await obtenerTicket(db, 'ws_sr_constancia_inscripcion');
  } catch (e) {
    const m = String((e as Error).message ?? e);
    if (/no autorizado|not authorized|computador/i.test(m)) {
      throw new ErrorPadron(
        'El certificado del ERP no está autorizado para consultar CUITs. En ARCA › Administrador de Relaciones, '
        + 'autorizá «Consulta de constancia de inscripción» para el mismo alias del certificado.', true,
      );
    }
    throw new ErrorPadron(`No se pudo pedir permiso a ARCA para consultar el CUIT (${m}).`, true);
  }

  const sobre = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a5="http://a5.soap.ws.server.puc.sr/">'
    + '<soapenv:Header/><soapenv:Body><a5:getPersona_v2>'
    + `<token>${ta.token}</token><sign>${ta.sign}</sign>`
    + `<cuitRepresentada>${ARCA.cuit}</cuitRepresentada><idPersona>${cuit}</idPersona>`
    + '</a5:getPersona_v2></soapenv:Body></soapenv:Envelope>';

  let res: Response;
  try {
    res = await fetch(ARCA.padronUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '' },
      body: sobre,
      signal: AbortSignal.timeout(ARCA.timeoutMs),
    });
  } catch (e) {
    throw new ErrorPadron(`ARCA no respondió la consulta del CUIT (${(e as Error).message}).`, true);
  }
  const xml = await res.text();
  const fault = tag(xml, 'faultstring');
  if (fault) {
    // «No existe persona con ese Id» y parecidos: el dato está mal, no la red.
    const noExiste = /no existe|inexistente|no se encontr/i.test(fault);
    throw new ErrorPadron(noExiste ? `ARCA no tiene registrado el CUIT ${cuit}.` : `ARCA respondió con un error: ${fault}`, !noExiste);
  }
  if (!res.ok) throw new ErrorPadron(`ARCA respondió HTTP ${res.status} a la consulta del CUIT.`, true);
  return interpretarPersona(xml, cuit);
}

/**
 * Los datos de un CUIT: primero lo guardado (7 días), si no ARCA. Con
 * `forzar`, siempre ARCA (el botón «volver a consultar»).
 */
export async function consultarCuit(db: Database, cuitCrudo: unknown, opciones: { forzar?: boolean } = {}): Promise<DatosPadron & { guardado: boolean }> {
  const cuit = soloDigitos(cuitCrudo);
  if (!cuitValido(cuit)) throw new ErrorPadron('Ese CUIT no es válido: revisá los 11 números (el último es un dígito verificador).', false);

  if (!opciones.forzar) {
    const [g] = await db.select().from(padronCuit).where(eq(padronCuit.cuit, cuit)).limit(1);
    if (g && Date.now() - new Date(g.consultadoEn).getTime() < CACHE_DIAS * 86_400_000) {
      return { ...(g.datos as DatosPadron), guardado: true };
    }
  }
  const datos = await pedirPersona(db, cuit);
  await db.insert(padronCuit).values({ cuit, datos, consultadoEn: new Date() })
    .onConflictDoUpdate({ target: padronCuit.cuit, set: { datos, consultadoEn: new Date() } });
  return { ...datos, guardado: false };
}
