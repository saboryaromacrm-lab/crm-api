/**
 * RECETAS DE LECTURA — una por proveedor
 * ============================================================================
 * Una receta sabe leer el LAYOUT de la factura de UN proveedor: dónde están los
 * renglones, cómo viene el pie, qué mugre trae el texto. Acá está la diferencia
 * con un parser genérico de banco: los proveedores son siempre los mismos y su
 * formato se repite — la receta se arma UNA vez mirando una factura real y se
 * amortiza en semanas.
 *
 * La primera es la de Bavosi, que además es formato **Tango** (el ERP más común
 * del país), así que va a servir de base para otros proveedores.
 *
 * El contrato: la receta NO adivina. Lo que no matchea un patrón no se inventa;
 * queda afuera y el control de suma lo delata (Σ renglones tiene que dar el
 * subtotal del papel). La validación final es el checksum de siempre: el total
 * reconstruido contra el total de la lectura (QR o tipeado).
 */
import { LineaPdf, clave, numeroDe, pegarNumeros } from './extraccion';

export type RenglonLeido = {
  codigo: string;
  descripcion: string;
  cantidad: number;
  /** Precio unitario impreso (por KG/LT/unidad), informativo. */
  precioUnit: number | null;
  unidad: string;
  /** Descuento del renglón en %, como lo imprime el papel. */
  dto: number;
  /** El importe del renglón CON su descuento aplicado. Este número manda. */
  importe: number;
};

export type PercepcionLeida = { nombre: string; alicuota: number | null; importe: number };

export type PieLeido = {
  bruto: number | null;
  bonifPct: number | null;
  bonifImporte: number | null;
  neto: number | null;
  ivaAlicuota: number | null;
  ivaImporte: number | null;
  percepciones: PercepcionLeida[];
  total: number | null;
};

export type EncabezadoLeido = {
  /** Código de comprobante de ARCA (1 = Factura A…), para mapear tipo y letra. */
  tipoArca: number | null;
  puntoVenta: string | null;
  numero: number | null;
  /** 'AAAA-MM-DD'. */
  fecha: string | null;
  cae: string | null;
  /** Vencimiento del PAGO ("30 DÍAS F.F. Vto: …"), no el del CAE. */
  vencimiento: string | null;
};

export type FacturaLeida = {
  encabezado: EncabezadoLeido;
  renglones: RenglonLeido[];
  pie: PieLeido;
  avisos: string[];
};

export type Receta = { nombre: string; leer: (lineas: LineaPdf[]) => FacturaLeida };

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Todos los números de una línea, ya normalizados. */
const nums = (t: string) =>
  (t.match(/\d[\d.,]*/g) ?? []).map(numeroDe).filter((n): n is number => n != null);

/**
 * El renglón de Tango, después de pegar los números partidos:
 *   codigo  descripcion [serie]  cantidad  precio+unidad  dto%  importe
 *   `10206 AJO GRANULADO x25 KGS. 1.00 9005.320KG 14.00 193,614.38`
 *
 * La cantidad tiene 2 decimales y el precio 3: esa diferencia es la que evita
 * que un "2.840 KG" dentro de la descripción se confunda con la cantidad.
 */
const RE_RENGLON = /^(\d{4,6}) (.+?) (\d+\.\d{2}) (\d+\.\d{3})([A-Z]{2,4}\.?) (\d+\.\d{2}) ([\d,]+\.\d{2})$/;

/** Serie/lote de Bavosi al final de la descripción ("01IC04059757E"): fuera.
 * Tolera los espacios que el PDF mete adentro del código ("01I C04059757E"). */
const RE_SERIE = /\s+\d{0,2}\s?I\s?C\s?\d[\d\s]{5,}[A-Z]?$/;

const recetaBavosi: Receta = {
  nombre: 'bavosi (Tango)',
  leer(lineas) {
    const avisos: string[] = [];
    const enc: EncabezadoLeido = {
      tipoArca: null, puntoVenta: null, numero: null, fecha: null, cae: null, vencimiento: null,
    };
    const pie: PieLeido = {
      bruto: null, bonifPct: null, bonifImporte: null, neto: null,
      ivaAlicuota: null, ivaImporte: null, percepciones: [], total: null,
    };
    const renglones: RenglonLeido[] = [];
    const ultima = lineas.reduce((a, l) => Math.max(a, l.pagina), 1);

    for (const l of lineas) {
      const t = pegarNumeros(l.texto);
      const k = clave(t);

      /* ---- Encabezado: está en todas las páginas, se toma la primera vez ---- */
      if (enc.numero == null && k.includes('CODIGO')) {
        const m = t.match(/(\d{1,3}) (\d{4,5})-(\d{7,8})(?: |$)/);
        if (m) {
          enc.tipoArca = Number(m[1]);
          enc.puntoVenta = m[2];
          enc.numero = Number(m[3]);
        }
      }
      if (!enc.fecha) {
        const m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (m) enc.fecha = `${m[3]}-${m[2]}-${m[1]}`;
      }
      if (!enc.cae) {
        const m = t.match(/CAE:?\s*(\d{14})/);
        if (m) enc.cae = m[1];
      }
      if (!enc.vencimiento && k.includes('DIAS')) {
        const m = t.match(/(\d{2})\/(\d{2})\/(\d{4})/);
        if (m) enc.vencimiento = `${m[3]}-${m[2]}-${m[1]}`;
      }

      /* ---- Renglones: en cualquier página ---- */
      const r = t.match(RE_RENGLON);
      if (r) {
        renglones.push({
          codigo: r[1],
          descripcion: r[2].replace(RE_SERIE, '').trim(),
          cantidad: numeroDe(r[3]) ?? 0,
          precioUnit: numeroDe(r[4]),
          unidad: r[5].replace(/\.$/, ''),
          dto: numeroDe(r[6]) ?? 0,
          importe: numeroDe(r[7]) ?? 0,
        });
        continue;
      }

      /* ---- El pie: SOLO la última página. La primera imprime las etiquetas
       * sin importes y un subtotal PARCIAL de esa página — tomarlo sería
       * quedarse con la suma incompleta. ---- */
      if (l.pagina !== ultima) continue;

      if (/^SUBTOTAL\s*:/i.test(t)) {
        pie.neto = nums(t).pop() ?? null;
      } else if (/^SUBTOTAL/i.test(t)) {
        pie.bruto = nums(t).pop() ?? null;
      } else if (k.startsWith('BONIF')) {
        const n = nums(t);
        pie.bonifPct = n[0] ?? null;
        pie.bonifImporte = n.length > 1 ? n[n.length - 1] : null;
      } else if (k.startsWith('PERC')) {
        const imp = nums(t).pop();
        const ali = t.match(/(\d+(?:[.,]\d+)?)\s*%/);
        if (imp != null) {
          pie.percepciones.push({
            nombre: t.replace(/\s*\d+(?:[.,]\d+)?\s*%.*$/, '').trim(),
            alicuota: ali ? numeroDe(ali[1]) : null,
            importe: imp,
          });
        }
      } else if (k.startsWith('IVA') && t.includes('%')) {
        const n = nums(t);
        pie.ivaAlicuota = n[0] ?? null;
        pie.ivaImporte = n.length > 1 ? n[n.length - 1] : null;
      } else if (/^TOTAL\s*:/i.test(t)) {
        pie.total = nums(t).pop() ?? null;
      }
    }

    /* ---- Controles internos: el parse se delata solo ---- */
    if (!renglones.length) {
      avisos.push('No se reconoció ningún renglón con el patrón de Bavosi.');
    } else if (pie.bruto != null) {
      const suma = r2(renglones.reduce((a, x) => a + x.importe, 0));
      // Tolerancia de un centavo por renglón: el proveedor redondea por línea.
      if (Math.abs(suma - pie.bruto) > 0.011 * renglones.length + 0.01) {
        avisos.push(
          `Los renglones leídos suman ${suma.toFixed(2)} y el subtotal del papel dice ${pie.bruto.toFixed(2)}: falta algún renglón o alguno se leyó mal.`,
        );
      }
    }
    if (pie.bruto != null && pie.bonifImporte != null && pie.neto != null
      && Math.abs(pie.bruto - pie.bonifImporte - pie.neto) > 0.02) {
      avisos.push('El neto del papel no cierra con subtotal − bonificación: revisá el pie.');
    }
    if (pie.neto != null && pie.ivaImporte != null && pie.total != null) {
      const perc = pie.percepciones.reduce((a, p) => a + p.importe, 0);
      if (Math.abs(pie.neto + pie.ivaImporte + perc - pie.total) > 0.02) {
        avisos.push('El total del papel no cierra con neto + IVA + percepciones: revisá el pie.');
      }
    }

    return { encabezado: enc, renglones, pie, avisos };
  },
};

/**
 * El registro, por CUIT del EMISOR (solo dígitos). El CUIT es la identidad
 * exacta — el nombre del proveedor se tipea de mil formas, el CUIT no.
 */
export const RECETAS: Record<string, Receta> = {
  '30629646708': recetaBavosi,
};
