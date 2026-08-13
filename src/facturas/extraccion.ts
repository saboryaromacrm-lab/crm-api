/**
 * EXTRACCIÓN DE TEXTO DE UN PDF DIGITAL
 * ============================================================================
 * La contraparte local del modelo de visión que quedó EN ESPERA: si el PDF trae
 * capa de texto (factura electrónica que el proveedor manda por mail), no hay
 * nada que "interpretar" — el texto ESTÁ, solo hay que reconstruirlo en el
 * orden visual. Gratis, sin clave de API, y el archivo no sale del sistema.
 *
 * La técnica: cada fragmento de texto viene con su posición X/Y en la hoja.
 * Se agrupa por altura (misma Y ± tolerancia = misma línea) y se ordena por X
 * (izquierda a derecha). El resultado es el renglón tal como se ve impreso.
 *
 * Lo que NO puede hacer: una foto o un escaneo no tienen capa de texto — para
 * esos el único camino sigue siendo el modelo de visión (ficha en /info).
 */

export type FragPdf = { x: number; y: number; s: string };
export type LineaPdf = {
  pagina: number;
  y: number;
  frags: FragPdf[];
  /** Los fragmentos unidos con un espacio, en orden visual. */
  texto: string;
};

/*
 * pdfjs-dist 6 es ESM puro y este proyecto compila a CommonJS: un `import`
 * estático (o un `await import()` transpilado) se convierte en `require()` y
 * explota con ERR_REQUIRE_ESM. `new Function` esconde el import() del
 * compilador, así llega a Node como import dinámico de verdad — que desde
 * CommonJS sí puede cargar ESM. Cacheado: el módulo se carga una sola vez.
 */
let pdfjsPromise: Promise<any> | null = null;
const importarPdfjs = () => {
  // eslint-disable-next-line no-new-func
  pdfjsPromise ??= new Function('return import("pdfjs-dist/legacy/build/pdf.mjs")')();
  return pdfjsPromise;
};

/** Misma línea = misma altura, con tolerancia: los renglones no vienen a Y exacta. */
const TOLERANCIA_Y = 2.5;

/*
 * TECHOS DEL EXTRACTOR — un PDF no confiable no puede decidir cuánto trabaja
 * el servidor.
 * ============================================================================
 * El archivo lo sube cualquiera desde un celular, y esto corre en el MISMO
 * proceso que atiende el POS: Node es uno solo. Sin techo, un PDF válido de 2 MB
 * (pasa la verificación de bytes sin problema) con decenas de miles de páginas o
 * con streams que expanden a cientos de MB de texto **deja toda la API sin
 * responder mientras parsea**, y con suerte muere por falta de memoria. Los
 * límites que ya existían —2,5 MB por archivo, 20 páginas— cuentan las páginas
 * SUBIDAS a la bandeja, no las que el PDF tiene adentro.
 *
 * Los tres son generosos para una factura real: la más larga que vimos (Bavosi)
 * tiene 3 páginas y unos 4.000 fragmentos.
 */
const MAX_PAGINAS_PDF = 30;
const MAX_FRAGMENTOS = 200_000;

export class PdfDemasiadoGrande extends Error {}

export async function extraerLineasPdf(buf: Buffer): Promise<LineaPdf[]> {
  const pdfjs = await importarPdfjs();
  const tarea = pdfjs.getDocument({
    data: new Uint8Array(buf),
    // `verbosity: 0` calla el aviso de fuentes estándar, que acá no importa:
    // no se renderiza nada, solo se lee el texto.
    verbosity: 0,
    /*
     * Por defecto pdf.js COMPILA CON eval los programas de fuente del archivo,
     * para acelerar el renderizado. Acá no se renderiza nada, así que es
     * superficie de ejecución sobre un archivo que subió un desconocido a
     * cambio de exactamente ningún beneficio.
     */
    isEvalSupported: false,
  });
  const doc = await tarea.promise;
  const lineas: LineaPdf[] = [];
  let fragmentos = 0;
  try {
    if (doc.numPages > MAX_PAGINAS_PDF) {
      throw new PdfDemasiadoGrande(
        `Ese PDF tiene ${doc.numPages} páginas: no parece una factura. El límite es ${MAX_PAGINAS_PDF}.`,
      );
    }
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const frags: FragPdf[] = tc.items
        .filter((it: any) => it.str && it.str.trim())
        .map((it: any) => ({ x: it.transform[4], y: it.transform[5], s: it.str }));
      fragmentos += frags.length;
      if (fragmentos > MAX_FRAGMENTOS) {
        throw new PdfDemasiadoGrande(
          'Ese PDF tiene demasiado texto para leerlo acá. Cargá los renglones a mano.',
        );
      }
      // De arriba hacia abajo, y dentro de la línea de izquierda a derecha.
      frags.sort((a, b) => b.y - a.y || a.x - b.x);
      let actual: LineaPdf | null = null;
      for (const f of frags) {
        if (!actual || Math.abs(actual.y - f.y) > TOLERANCIA_Y) {
          actual = { pagina: p, y: f.y, frags: [f], texto: '' };
          lineas.push(actual);
        } else {
          actual.frags.push(f);
        }
      }
      // pdf.js CACHEA cada página en el documento: sin esto, un PDF largo
      // acumula todas las páginas parseadas en memoria hasta el final.
      page.cleanup();
    }
  } finally {
    // En pdfjs 6 el destroy vive en la TAREA de carga, no en el documento.
    await tarea.destroy();
  }
  for (const l of lineas) {
    l.frags.sort((a, b) => a.x - b.x);
    l.texto = l.frags.map((f) => f.s.trim()).join(' ');
  }
  return lineas;
}

/* ============================================================================
 * NORMALIZACIÓN — las dos mugres típicas del texto extraído
 * ==========================================================================*/

/**
 * Los PDFs de Tango (y varios más) traen espacios ADENTRO de los números:
 * "87, 731. 41", "1. 00", "00115- 00194842", "04/ 08/ 2026".
 *
 * La regla fina, afinada dos veces contra la factura real:
 *   1. Pegar dígito-espacio-dígito fusionaba números DISTINTOS ("1.00 9005.320"
 *      quedaba un bloque; "RG5329 3%" se volvía "53293%").
 *   2. Pegar tras cualquier separador también: el punto de la UNIDAD ("LT. 14.00")
 *      pegaba la unidad con el descuento → "LT.14.00".
 * Lo único seguro: pegar cuando el separador viene después de un DÍGITO y antes
 * de un dígito — o sea, partes de un mismo número. Los espacios entre letras
 * ("AJ O") se quedan: para comparar nombres está `clave()`, que los ignora.
 */
export const pegarNumeros = (s: string) =>
  String(s ?? '')
    .replace(/(\d[.,\-/]) (?=\d)/g, '$1')
    .replace(/(\d) (?=[.,]\d)/g, '$1')
    .trim();

/** Para comparar texto mugriento: sin espacios, sin acentos, mayúsculas. */
export const clave = (s: string) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .toUpperCase();

/**
 * "87, 731. 41" → 87731.41 · "10,00" → 10 · "1.596.319,64" → 1596319.64
 *
 * El formato cambia hasta dentro de la misma factura (Tango imprime los importes
 * al estilo US y la bonificación con coma decimal), así que no se asume uno:
 * si hay punto y coma, el que aparece ÚLTIMO es el decimal.
 */
export function numeroDe(txt: string | null | undefined): number | null {
  const t = String(txt ?? '').replace(/\s+/g, '').replace(/[^\d.,-]/g, '');
  if (!/\d/.test(t)) return null;
  const punto = t.lastIndexOf('.');
  const coma = t.lastIndexOf(',');
  let limpio: string;
  if (punto >= 0 && coma >= 0) {
    limpio = punto > coma ? t.replace(/,/g, '') : t.replace(/\./g, '').replace(',', '.');
  } else if (coma >= 0) {
    // Solo coma: decimal si le siguen 1 o 2 dígitos; si no, es de miles.
    limpio = t.length - coma - 1 <= 2 ? t.replace(',', '.') : t.replace(/,/g, '');
  } else {
    limpio = t;
  }
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}
