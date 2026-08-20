/**
 * WSFE — el webservice de facturación electrónica
 * ============================================================================
 * Cuatro llamadas SOAP, sin librería de SOAP: son plantillas XML fijas con
 * `fetch` y extracción por expresión regular. Menos dependencias y menos
 * superficie de error que un cliente SOAP genérico, que para cuatro mensajes
 * conocidos no aporta nada.
 *
 *   FEDummy                 ¿el servicio está vivo? (no pide credenciales)
 *   FECompUltimoAutorizado  el último número emitido → el próximo es este + 1
 *   FECAESolicitar          emitir y obtener el CAE
 *   FECompConsultar         ¿este número ya salió? → recuperación tras un corte
 *
 * DOS TIPOS DE FALLO, Y SE TRATAN AL REVÉS:
 *
 *  · **Red, timeout o SOAP Fault** → transitorio. Reintentar sirve.
 *  · **`Resultado: 'R'` (rechazado)** → los datos están mal. Con los mismos
 *    datos va a fallar siempre, así que reintentar es perder el tiempo: hay
 *    que mostrar el motivo. **El número NO se consumió** y queda libre.
 *
 * Por eso `ErrorArca` lleva `reintentable`: quien llama decide con ese dato,
 * no adivinando por el texto del mensaje.
 */
import type { Database } from '../db/drizzle';
import { ARCA } from './config';
import { fechaComprobante } from './fecha';
import { obtenerTicket } from './wsaa';
import type { AlicuotaArca } from './comprobante';

export class ErrorArca extends Error {
  constructor(
    message: string,
    readonly reintentable: boolean,
    readonly codigo?: string,
  ) {
    super(message);
    this.name = 'ErrorArca';
  }
}

/* --------------------------- Plumbing SOAP --------------------------- */

const NS = 'http://ar.gov.afip.dif.FEV1/';

const esc = (v: unknown) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const tag = (xml: string, t: string): string => {
  const m = new RegExp(`<(?:\\w+:)?${t}>([\\s\\S]*?)</(?:\\w+:)?${t}>`).exec(xml);
  return m ? m[1].trim() : '';
};

const todos = (xml: string, t: string): string[] => {
  const re = new RegExp(`<(?:\\w+:)?${t}>([\\s\\S]*?)</(?:\\w+:)?${t}>`, 'g');
  const out: string[] = [];
  let m = re.exec(xml);
  while (m) { out.push(m[1]); m = re.exec(xml); }
  return out;
};

/**
 * Los `<Err>` y `<Obs>` de la respuesta, legibles.
 *
 * Van juntos a propósito: una observación no impide la emisión pero explica
 * por qué ARCA "aceptó con reparos", y esconderla deja al que mira sin la
 * mitad de la historia cuando después aparece un problema.
 */
function mensajesDe(xml: string, contenedor: 'Errors' | 'Observations'): string[] {
  const bloque = tag(xml, contenedor);
  if (!bloque) return [];
  return todos(bloque, contenedor === 'Errors' ? 'Err' : 'Obs')
    .map((e) => {
      const code = tag(e, 'Code');
      const msg = tag(e, 'Msg');
      return code ? `[${code}] ${msg}` : msg;
    })
    .filter(Boolean);
}

async function llamar(metodo: string, cuerpo: string): Promise<string> {
  const sobre = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" '
    + `xmlns:ar="${NS}">`
    + `<soap:Header/><soap:Body><ar:${metodo}>${cuerpo}</ar:${metodo}></soap:Body></soap:Envelope>`;

  let res: Response;
  try {
    res = await fetch(ARCA.wsfeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `${NS}${metodo}` },
      body: sobre,
      signal: AbortSignal.timeout(ARCA.timeoutMs),
    });
  } catch (e) {
    // Timeout, DNS, TLS, cable: todo esto se reintenta.
    throw new ErrorArca(`No se pudo contactar a ARCA (${(e as Error).message}).`, true);
  }

  const xml = await res.text();
  const fault = tag(xml, 'faultstring');
  if (fault) throw new ErrorArca(`ARCA devolvió un error de servicio: ${fault}`, true);
  if (!res.ok) throw new ErrorArca(`ARCA respondió HTTP ${res.status}.`, true);
  return xml;
}

/** El bloque de credenciales que llevan todas las llamadas menos FEDummy. */
async function auth(db: Database): Promise<string> {
  const ta = await obtenerTicket(db, 'wsfe');
  return '<ar:Auth>'
    + `<ar:Token>${ta.token}</ar:Token>`
    + `<ar:Sign>${ta.sign}</ar:Sign>`
    + `<ar:Cuit>${ARCA.cuit}</ar:Cuit>`
    + '</ar:Auth>';
}

/* ------------------------------ Llamadas ------------------------------ */

export interface EstadoServicio {
  appServer: string;
  dbServer: string;
  authServer: string;
  ok: boolean;
}

/**
 * ¿El servicio está vivo? No pide credenciales, así que sirve para distinguir
 * "ARCA está caído" de "mi certificado no anda" — que es la primera pregunta
 * cuando algo falla.
 */
export async function feDummy(): Promise<EstadoServicio> {
  const xml = await llamar('FEDummy', '');
  const e = {
    appServer: tag(xml, 'AppServer') || '?',
    dbServer: tag(xml, 'DbServer') || '?',
    authServer: tag(xml, 'AuthServer') || '?',
  };
  return { ...e, ok: [e.appServer, e.dbServer, e.authServer].every((x) => x.toUpperCase() === 'OK') };
}

/**
 * El último número autorizado para (punto de venta, tipo). **El próximo es
 * este + 1** — así lleva ARCA la numeración, y por eso no puede haber un
 * contador local que compita con ella.
 *
 * Devuelve 0 si nunca se emitió nada por webservice en ese punto de venta.
 */
export async function ultimoAutorizado(db: Database, cbteTipo: number): Promise<number> {
  const xml = await llamar('FECompUltimoAutorizado',
    `${await auth(db)}<ar:PtoVta>${ARCA.ptoVta}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo>`);
  const errores = mensajesDe(xml, 'Errors');
  if (errores.length) throw new ErrorArca(errores.join(' · '), false);
  return Number(tag(xml, 'CbteNro')) || 0;
}

export interface PedidoCae {
  cbteTipo: number;
  cbteNro: number;
  /** Fecha del comprobante; si se omite, hoy en hora argentina. */
  fecha?: Date;
  docTipo: number;
  docNro: string;
  condIvaReceptorId: number;
  /** Suma de las bases gravadas. */
  impNeto: number;
  impIva: number;
  impTotal: number;
  alicuotas: AlicuotaArca[];
  /** Notas de crédito/débito: el comprobante que ajustan. */
  asociado?: { tipo: number; ptoVta: number; nro: number };
}

export interface RespuestaCae {
  cae: string;
  caeVencimiento: string;   // AAAAMMDD
  cbteNro: number;
  observaciones: string[];
}

/**
 * EMITE EL COMPROBANTE Y DEVUELVE EL CAE.
 *
 * `Concepto 1` = Productos. Con ese concepto la fecha tiene que caer dentro de
 * ±5 días de hoy, y por eso `fechaComprobante` calcula en hora ARGENTINA y no
 * con el reloj del servidor.
 *
 * Los importes van en PESOS con dos decimales. El resto del sistema trabaja en
 * pesos con decimales flotantes, así que el redondeo a dos vive acá y en un
 * solo lugar: si cada llamador redondeara por su cuenta, las sumas de las
 * alícuotas dejarían de cerrar contra el total.
 */
export async function solicitarCae(db: Database, p: PedidoCae): Promise<RespuestaCae> {
  const m = (n: number) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
  const fecha = fechaComprobante(p.fecha ?? new Date());

  /* Sin renglones gravados el bloque `Iva` NO se manda: ARCA rechaza un
   * arreglo vacío, que no es lo mismo que ausente. */
  const bloqueIva = p.alicuotas.length
    ? `<ar:Iva>${p.alicuotas.map((a) => '<ar:AlicIva>'
      + `<ar:Id>${a.id}</ar:Id>`
      + `<ar:BaseImp>${m(a.baseImp)}</ar:BaseImp>`
      + `<ar:Importe>${m(a.importe)}</ar:Importe>`
      + '</ar:AlicIva>').join('')}</ar:Iva>`
    : '';

  const bloqueAsoc = p.asociado
    ? '<ar:CbtesAsoc><ar:CbteAsoc>'
      + `<ar:Tipo>${p.asociado.tipo}</ar:Tipo>`
      + `<ar:PtoVta>${p.asociado.ptoVta}</ar:PtoVta>`
      + `<ar:Nro>${p.asociado.nro}</ar:Nro>`
      + '</ar:CbteAsoc></ar:CbtesAsoc>'
    : '';

  const detalle = '<ar:FECAEDetRequest>'
    + '<ar:Concepto>1</ar:Concepto>'
    + `<ar:DocTipo>${p.docTipo}</ar:DocTipo>`
    + `<ar:DocNro>${esc(p.docNro)}</ar:DocNro>`
    + `<ar:CbteDesde>${p.cbteNro}</ar:CbteDesde>`
    + `<ar:CbteHasta>${p.cbteNro}</ar:CbteHasta>`
    + `<ar:CbteFch>${fecha}</ar:CbteFch>`
    + `<ar:ImpTotal>${m(p.impTotal)}</ar:ImpTotal>`
    + '<ar:ImpTotConc>0</ar:ImpTotConc>'
    + `<ar:ImpNeto>${m(p.impNeto)}</ar:ImpNeto>`
    + '<ar:ImpOpEx>0</ar:ImpOpEx>'
    + '<ar:ImpTrib>0</ar:ImpTrib>'
    + `<ar:ImpIVA>${m(p.impIva)}</ar:ImpIVA>`
    + '<ar:MonId>PES</ar:MonId>'
    + '<ar:MonCotiz>1</ar:MonCotiz>'
    + `<ar:CondicionIVAReceptorId>${p.condIvaReceptorId}</ar:CondicionIVAReceptorId>`
    + bloqueAsoc
    + bloqueIva
    + '</ar:FECAEDetRequest>';

  const cuerpo = `${await auth(db)}<ar:FeCAEReq>`
    + '<ar:FeCabReq>'
    + '<ar:CantReg>1</ar:CantReg>'
    + `<ar:PtoVta>${ARCA.ptoVta}</ar:PtoVta>`
    + `<ar:CbteTipo>${p.cbteTipo}</ar:CbteTipo>`
    + '</ar:FeCabReq>'
    + `<ar:FeDetReq>${detalle}</ar:FeDetReq>`
    + '</ar:FeCAEReq>';

  const xml = await llamar('FECAESolicitar', cuerpo);

  /* Los `Errors` de la cabecera son de PROTOCOLO (token vencido, CUIT que no
   * corresponde): transitorios algunos, definitivos otros, pero ninguno se
   * arregla reintentando con los mismos datos salvo el del token, que se
   * resuelve solo al pedir uno nuevo. Se marcan reintentables. */
  const errores = mensajesDe(xml, 'Errors');
  const resultado = tag(xml, 'Resultado');
  const observaciones = mensajesDe(xml, 'Observations');

  if (resultado === 'R') {
    const motivo = [...errores, ...observaciones].join(' · ') || 'ARCA rechazó el comprobante sin detalle.';
    // Rechazado = los datos están mal. El número quedó LIBRE.
    throw new ErrorArca(motivo, false);
  }
  if (errores.length && resultado !== 'A') {
    throw new ErrorArca(errores.join(' · '), true);
  }

  const cae = tag(xml, 'CAE');
  const caeVto = tag(xml, 'CAEFchVto');
  if (!cae) {
    throw new ErrorArca(
      [...errores, ...observaciones].join(' · ') || 'ARCA aceptó pero no devolvió el CAE.',
      true,
    );
  }
  return { cae, caeVencimiento: caeVto, cbteNro: Number(tag(xml, 'CbteDesde')) || p.cbteNro, observaciones };
}

export interface ComprobanteEmitido {
  cbteNro: number;
  cae: string;
  caeVencimiento: string;
  impTotal: number;
  docTipo: number;
  docNro: string;
  fecha: string;
}

/**
 * ¿ESTE NÚMERO YA SE EMITIÓ? Es la pieza de la RECUPERACIÓN.
 *
 * El caso que existe para cubrir: se manda `FECAESolicitar`, ARCA lo procesa
 * y emite, y la respuesta se pierde (timeout, corte, reinicio del contenedor).
 * Para nosotros falló; para ARCA la factura existe. Si reintentáramos a ciegas
 * con el número siguiente, quedaría un comprobante emitido que el sistema no
 * conoce — y encima el cliente se llevó el papel del provisorio.
 *
 * Con esto, antes de reintentar se pregunta si el número ya salió; si salió y
 * los datos coinciden, se ADOPTA el CAE en vez de emitir de nuevo.
 *
 * `null` = ese número no está emitido (quedó libre).
 */
export async function consultarComprobante(
  db: Database, cbteTipo: number, cbteNro: number,
): Promise<ComprobanteEmitido | null> {
  const xml = await llamar('FECompConsultar',
    `${await auth(db)}<ar:FeCompConsReq>`
    + `<ar:CbteTipo>${cbteTipo}</ar:CbteTipo>`
    + `<ar:CbteNro>${cbteNro}</ar:CbteNro>`
    + `<ar:PtoVta>${ARCA.ptoVta}</ar:PtoVta>`
    + '</ar:FeCompConsReq>');

  const errores = mensajesDe(xml, 'Errors');
  /* 602 = "no existe en los registros de AFIP": no es un error, es la
   * respuesta a la pregunta. Cualquier otro sí lo es. */
  if (errores.length) {
    if (errores.some((e) => e.includes('[602]'))) return null;
    throw new ErrorArca(errores.join(' · '), true);
  }

  const cae = tag(xml, 'CodAutorizacion');
  if (!cae) return null;
  return {
    cbteNro: Number(tag(xml, 'CbteDesde')) || cbteNro,
    cae,
    caeVencimiento: tag(xml, 'FchVto'),
    impTotal: Number(tag(xml, 'ImpTotal')) || 0,
    docTipo: Number(tag(xml, 'DocTipo')) || 0,
    docNro: tag(xml, 'DocNro'),
    fecha: tag(xml, 'CbteFch'),
  };
}
