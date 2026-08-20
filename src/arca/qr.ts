/**
 * EL QR FISCAL — RG 4892
 * ============================================================================
 * Todo comprobante electrónico tiene que llevar impreso un QR con los datos
 * del comprobante. No es una imagen decorativa: es lo que le permite a
 * cualquiera —el cliente, un inspector— verificar contra ARCA que ese papel
 * existe y dice lo que dice.
 *
 * El contenido es un JSON en base64 metido en una URL fija de ARCA.
 *
 * VIVE EN LA API Y NO EN EL DASHBOARD a propósito, aunque quien imprime es el
 * navegador: acá están la tabla de códigos de comprobante, la de tipos de
 * documento y el CUIT del certificado. Armarlo del otro lado obligaría a
 * duplicar las tres cosas, y el día que una se desincronice el QR va a apuntar
 * a un comprobante que no existe — sin que nada falle a la vista.
 */
import { ARCA } from './config';
import { fechaQr } from './fecha';
import { CBTE_TIPO, DOC_TIPO } from './comprobante';

export interface DatosQr {
  tipo: string;              // 'factura_a' | 'factura_b' | …
  puntoVenta: string;
  numero: number | null;
  fecha: Date;
  total: number;
  cae: string;
  receptor?: { tipoDoc?: string; numeroDoc?: string } | null;
}

const DOC_POR_NOMBRE: Record<string, number> = {
  cuit: DOC_TIPO.CUIT,
  cuil: DOC_TIPO.CUIL,
  dni: DOC_TIPO.DNI,
  sin_identificar: DOC_TIPO.SIN_IDENTIFICAR,
};

/**
 * La URL del QR, o `null` si al comprobante le falta algo para tenerlo.
 *
 * `null` no es un error: un ticket interno no lleva QR, y una venta sin CAE
 * tampoco. Quien imprime pregunta y decide.
 */
export function urlQrFiscal(d: DatosQr): string | null {
  const tipoCmp = CBTE_TIPO[d.tipo];
  const cae = String(d.cae ?? '').trim();
  // Solo un CAE de verdad: un comprobante cargado a mano no tiene QR que rehacer.
  if (!tipoCmp || !d.numero || !/^\d+$/.test(cae) || !ARCA.cuit) return null;

  const digitos = String(d.receptor?.numeroDoc ?? '').replace(/\D/g, '');
  const tipoDocRec = digitos
    ? (DOC_POR_NOMBRE[d.receptor?.tipoDoc ?? ''] ?? DOC_TIPO.DNI)
    : DOC_TIPO.SIN_IDENTIFICAR;

  const payload = {
    ver: 1,
    fecha: fechaQr(d.fecha),
    cuit: Number(ARCA.cuit),
    ptoVta: Number(d.puntoVenta) || ARCA.ptoVta,
    tipoCmp,
    nroCmp: d.numero,
    importe: Number(Number(d.total).toFixed(2)),
    moneda: 'PES',
    ctz: 1,
    tipoDocRec,
    nroDocRec: digitos ? Number(digitos) : 0,
    tipoCodAut: 'E',
    codAut: Number(cae),
  };
  const p = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `https://www.afip.gob.ar/fe/qr/?p=${p}`;
}

/** El código numérico del comprobante, para el recuadro del papel ("COD. 06"). */
export function codigoComprobante(tipo: string): number | null {
  return CBTE_TIPO[tipo] ?? null;
}
