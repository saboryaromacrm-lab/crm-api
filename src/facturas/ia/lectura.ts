/**
 * QUÉ SE LE PIDE A LA IA Y CÓMO SE LIMPIA LO QUE DEVUELVE (0153).
 * ============================================================================
 * La IA TRANSCRIBE: copia lo impreso tal cual (encabezado, renglones, pie) en
 * un JSON de forma fija. No calcula, no corrige y no reconoce productos: la
 * cuenta la controla el sistema (`control.ts`) y los productos los reconoce el
 * sistema con lo aprendido de cada proveedor. Así un error de la IA se ve
 * (la cuenta no cierra) en vez de quedar escondido detrás de un número
 * "arreglado".
 */
import { TIPOS_ARCA, normalizarPuntoVenta, soloDigitos } from '../comun';

export const SISTEMA = `Transcribís comprobantes de compra argentinos (facturas, notas de crédito, notas de débito, remitos y papeles internos sin factura) para el sistema de gestión de una distribuidora de alimentos.

REGLAS
- Copiá lo IMPRESO, tal cual. No calcules, no redondees, no corrijas, no completes con lo que "debería" decir. Si un dato no está o no se lee, dejalo vacío ("" o 0).
- Los números van como número, con punto decimal: "1.234,56" es 1234.56. Los porcentajes, como número: "10%" es 10.
- El comprobante puede tener varias páginas o varias fotos, en orden: es UN solo comprobante.
- EMISOR es quien vende (el proveedor, arriba). RECEPTOR es el cliente (la empresa que compra). No los confundas. Si el papel no trae los datos de quien vende (pasa en los internos, que solo muestran al cliente), dejá el emisor vacío: nunca pongas al cliente como emisor.

ENCABEZADO
- tipo: factura, nota_credito, nota_debito, remito, liquidacion u otro (si no es un comprobante de compra).
  · liquidacion: un papel de venta NO fiscal, sin CAE ni CAI y sin letra A/B/C/M en un recuadro: "Factura interna", "Comprobante interno", "Presupuesto", "Liquidación", "Nota de venta", "Pedido", "Documento no válido como factura". Que diga "Factura" en el título no lo hace factura: sin CAE ni letra fiscal es liquidacion.
  · remito: solo si dice "Remito" (entrega de mercadería).
- letra: la letra grande del recuadro (A, B, C, M o X); "" si no tiene. En una liquidacion, X.
- codigoArca: el número "COD." junto a la letra (01, 06, 11, 201…); 0 si no figura.
- puntoVenta y numero: los del comprobante ("Punto de Venta: 00012 Comp. Nro: 00004567" → "00012" y "00004567").
- fecha: la de emisión, como AAAA-MM-DD.
- cae: el número de CAE o CAI si figura.
- cuitEmisor, razonSocialEmisor, domicilioEmisor y condicionIvaEmisor del que vende; cuitReceptor del cliente.
- moneda: PES, DOL u otra, si figura; "" si no.

RENGLONES (uno por artículo, en el orden del papel)
- NO son renglones: subtotales, "transporte" o "van" entre páginas, bonificaciones o recargos generales, leyendas, totales.
- codigo: el código del artículo del proveedor si está impreso; "" si no.
- descripcion: como está impresa, completa.
- cantidad, unidad (UN, KG, CJ, BU, PQ… como figura) y precioUnitario impresos.
- descuentos: los % de bonificación del renglón, en orden (por ejemplo "10+5" es [10, 5]); [] si no tiene.
- importe: el importe del renglón tal como está impreso.
- alicuotaIva: la alícuota del renglón si está impresa (21, 10.5, 27…); 0 si no.

PIE
- subtotal: el subtotal o neto gravado impreso.
- bonificacionPct y bonificacionImporte: la bonificación o descuento general, si hay.
- ivas: cada línea de IVA con su alícuota e importe.
- percepciones: cada percepción o retención (IIBB, IVA, etc.) con su nombre como figura, alícuota e importe.
- impuestosInternos, otrosImpuestos y total: como están impresos.

nota: una línea corta solo si algo impide leer bien (una página cortada, borrosa o que falta); si no, "".`;

const num = { type: 'number' };
const str = { type: 'string' };
const objeto = (properties: Record<string, any>) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});

export const ESQUEMA = objeto({
  esComprobante: { type: 'boolean' },
  encabezado: objeto({
    tipo: { type: 'string', enum: ['factura', 'nota_credito', 'nota_debito', 'remito', 'liquidacion', 'otro'] },
    letra: { type: 'string', enum: ['A', 'B', 'C', 'M', 'X', ''] },
    codigoArca: { type: 'integer' },
    puntoVenta: str, numero: str, fecha: str, cae: str,
    cuitEmisor: str, razonSocialEmisor: str, domicilioEmisor: str,
    condicionIvaEmisor: { type: 'string', enum: ['responsable_inscripto', 'monotributo', 'exento', 'otro', ''] },
    cuitReceptor: str, moneda: str,
  }),
  renglones: {
    type: 'array',
    items: objeto({
      codigo: str, descripcion: str, cantidad: num, unidad: str, precioUnitario: num,
      descuentos: { type: 'array', items: num }, importe: num, alicuotaIva: num,
    }),
  },
  pie: objeto({
    subtotal: num, bonificacionPct: num, bonificacionImporte: num,
    ivas: { type: 'array', items: objeto({ alicuota: num, importe: num }) },
    percepciones: { type: 'array', items: objeto({ nombre: str, alicuota: num, importe: num }) },
    impuestosInternos: num, otrosImpuestos: num, total: num,
  }),
  nota: str,
});

/** Las páginas del comprobante como bloques del mensaje: el PDF como documento, la foto como imagen. */
export function contenidoDe(archivos: { mime: string; data: string }[], receptor: { nombre: string; cuit: string }) {
  const bloques: any[] = archivos.map((a) => (a.mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } }
    : { type: 'image', source: { type: 'base64', media_type: a.mime, data: a.data } }));
  const quien = receptor.cuit || receptor.nombre
    ? ` El receptor (nuestra empresa) es ${receptor.nombre || 'la empresa'}${receptor.cuit ? `, CUIT ${receptor.cuit}` : ''}.`
    : '';
  bloques.push({ type: 'text', text: `Transcribí este comprobante (${archivos.length} ${archivos.length === 1 ? 'archivo' : 'archivos, en orden'}).${quien}` });
  return bloques;
}

/* ------------------------------ la limpieza ------------------------------ */

const N = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0; };
const S = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const pct = (v: unknown) => Math.min(100, Math.max(0, N(v)));
/** 'AAAA-MM-DD' que existe en el calendario (el 31/2 no); si no, ''. */
const fechaReal = (v: unknown) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? ''));
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? m[0] : '';
};

export type RenglonIa = {
  codigo: string; descripcion: string; cantidad: number; unidad: string; precioUnitario: number;
  descuentos: number[]; importe: number; alicuotaIva: number;
};
export type LecturaIa = ReturnType<typeof limpiar>;

/**
 * LO QUE DEVOLVIÓ LA IA, LIMPIO Y EN EL VOCABULARIO DEL SISTEMA. Topes a
 * todo (viene de afuera), el tipo y la letra por el código de ARCA cuando lo
 * trae (es lo exacto), el punto de venta normalizado y los CUIT solo dígitos.
 *
 * `propio` es el CUIT de la empresa: si la IA lo puso como emisor (un papel
 * interno que solo muestra al cliente), el emisor queda vacío — si no, el
 * alta de proveedor propondría a la propia empresa.
 */
export function limpiar(j: any, propio = '') {
  const e = j?.encabezado ?? {};
  const arca = TIPOS_ARCA[Math.trunc(N(e.codigoArca))];
  const notas: string[] = [];
  let tipo: string = ['factura', 'nota_credito', 'nota_debito', 'remito', 'liquidacion'].includes(e.tipo) ? e.tipo : '';
  let letra: string = ['A', 'B', 'C', 'X'].includes(e.letra) ? e.letra : e.letra === 'M' ? 'A' : '';
  if (e.letra === 'M') notas.push('Factura M: se carga como A (discrimina IVA igual).');
  if (arca) { tipo = arca.tipo; letra = arca.letra; if (arca.nota) notas.push(arca.nota); }
  const cae = soloDigitos(e.cae).slice(0, 20);
  /* El sistema controla, no confía: una "factura" sin código de ARCA, sin CAE
   * y sin letra fiscal no es una factura — es un papel interno (liquidación). */
  if (tipo === 'factura' && !arca && !cae && (letra === '' || letra === 'X')) {
    tipo = 'liquidacion';
    notas.push('Sin CAE ni letra fiscal: se tomó como liquidación (sin factura).');
  }
  if ((tipo === 'remito' || tipo === 'liquidacion') && !arca) letra = 'X';
  const cuitEmisor = soloDigitos(e.cuitEmisor).slice(0, 11);
  const esPropio = !!cuitEmisor && cuitEmisor === soloDigitos(propio);
  const numero = Number(soloDigitos(e.numero).slice(-8)) || null;
  const fecha = fechaReal(e.fecha);
  const moneda = S(e.moneda, 6).toUpperCase();

  const renglones: RenglonIa[] = (Array.isArray(j?.renglones) ? j.renglones : []).slice(0, 500).map((r: any) => ({
    codigo: S(r?.codigo, 40),
    descripcion: S(r?.descripcion, 300),
    cantidad: Math.max(0, N(r?.cantidad)),
    unidad: S(r?.unidad, 12),
    precioUnitario: Math.max(0, N(r?.precioUnitario)),
    descuentos: (Array.isArray(r?.descuentos) ? r.descuentos : []).slice(0, 5).map(pct).filter((d: number) => d > 0),
    importe: N(r?.importe),
    alicuotaIva: Math.max(0, N(r?.alicuotaIva)),
  })).filter((r: RenglonIa) => r.descripcion || r.codigo || r.importe);

  const p = j?.pie ?? {};
  const lista = (v: unknown) => (Array.isArray(v) ? v : []).slice(0, 20);
  return {
    esComprobante: j?.esComprobante !== false && tipo !== '',
    encabezado: {
      tipo, letra,
      puntoVenta: soloDigitos(e.puntoVenta) ? normalizarPuntoVenta(e.puntoVenta) : '',
      numero, fecha, cae,
      cuitEmisor: esPropio ? '' : cuitEmisor,
      razonSocialEmisor: esPropio ? '' : S(e.razonSocialEmisor, 160),
      domicilioEmisor: esPropio ? '' : S(e.domicilioEmisor, 200),
      condicionIvaEmisor: !esPropio && ['responsable_inscripto', 'monotributo', 'exento'].includes(e.condicionIvaEmisor) ? e.condicionIvaEmisor : '',
      cuitReceptor: soloDigitos(e.cuitReceptor).slice(0, 11),
      moneda: moneda === 'ARS' || moneda === '$' ? 'PES' : moneda,
    },
    renglones,
    pie: {
      subtotal: N(p.subtotal),
      bonificacionPct: pct(p.bonificacionPct),
      bonificacionImporte: Math.abs(N(p.bonificacionImporte)),
      ivas: lista(p.ivas).map((x: any) => ({ alicuota: Math.max(0, N(x?.alicuota)), importe: N(x?.importe) })).filter((x) => x.importe),
      percepciones: lista(p.percepciones)
        .map((x: any) => ({ nombre: S(x?.nombre, 120) || 'Percepción', alicuota: Math.max(0, N(x?.alicuota)), importe: N(x?.importe) }))
        .filter((x) => x.importe),
      impuestosInternos: N(p.impuestosInternos),
      otrosImpuestos: N(p.otrosImpuestos),
      total: N(p.total),
    },
    nota: [S(j?.nota, 300), ...notas].filter(Boolean).join(' '),
  };
}
