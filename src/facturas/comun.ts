/**
 * LO COMÚN DE LAS FACTURAS DE COMPRA: la bandeja, la lectura con IA (0153) y
 * los comprobantes lo comparten. Sin dependencias: cualquiera lo importa.
 */

/** Para comparar texto mugriento: sin espacios, sin acentos, mayúsculas. */
export const clave = (s: string) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .toUpperCase();

export const soloDigitos = (v: any) => String(v ?? '').replace(/\D/g, '');

export const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Códigos de comprobante de ARCA → (tipo, letra) del sistema.
 *
 * Solo están los que emite un PROVEEDOR de mercadería. Los códigos 20x son la
 * **Factura de Crédito Electrónica MiPyME**, que muchos proveedores ya emiten
 * por defecto: sin mapearlas, una buena parte de las facturas reales caería en
 * "tipo desconocido".
 *
 * La letra **M** (51/52/53) no existe en el sistema: se mapea a A porque
 * discrimina IVA igual que una A, y queda anotado en las observaciones.
 */
export const TIPOS_ARCA: Record<number, { tipo: 'factura' | 'nota_credito' | 'nota_debito'; letra: 'A' | 'B' | 'C'; nota?: string }> = {
  1: { tipo: 'factura', letra: 'A' },
  2: { tipo: 'nota_debito', letra: 'A' },
  3: { tipo: 'nota_credito', letra: 'A' },
  6: { tipo: 'factura', letra: 'B' },
  7: { tipo: 'nota_debito', letra: 'B' },
  8: { tipo: 'nota_credito', letra: 'B' },
  11: { tipo: 'factura', letra: 'C' },
  12: { tipo: 'nota_debito', letra: 'C' },
  13: { tipo: 'nota_credito', letra: 'C' },
  51: { tipo: 'factura', letra: 'A', nota: 'Factura M (se cargó como A: discrimina IVA igual).' },
  52: { tipo: 'nota_debito', letra: 'A', nota: 'Nota de débito M (se cargó como A).' },
  53: { tipo: 'nota_credito', letra: 'A', nota: 'Nota de crédito M (se cargó como A).' },
  81: { tipo: 'factura', letra: 'A', nota: 'Tique factura A.' },
  82: { tipo: 'factura', letra: 'B', nota: 'Tique factura B.' },
  83: { tipo: 'factura', letra: 'B', nota: 'Tique.' },
  201: { tipo: 'factura', letra: 'A', nota: 'Factura de Crédito Electrónica MiPyME.' },
  202: { tipo: 'nota_debito', letra: 'A', nota: 'ND de Crédito Electrónica MiPyME.' },
  203: { tipo: 'nota_credito', letra: 'A', nota: 'NC de Crédito Electrónica MiPyME.' },
  206: { tipo: 'factura', letra: 'B', nota: 'Factura de Crédito Electrónica MiPyME.' },
  207: { tipo: 'nota_debito', letra: 'B', nota: 'ND de Crédito Electrónica MiPyME.' },
  208: { tipo: 'nota_credito', letra: 'B', nota: 'NC de Crédito Electrónica MiPyME.' },
  211: { tipo: 'factura', letra: 'C', nota: 'Factura de Crédito Electrónica MiPyME.' },
  212: { tipo: 'nota_debito', letra: 'C', nota: 'ND de Crédito Electrónica MiPyME.' },
  213: { tipo: 'nota_credito', letra: 'C', nota: 'NC de Crédito Electrónica MiPyME.' },
};

/**
 * PUNTO DE VENTA, SIEMPRE IGUAL — cuatro dígitos.
 *
 * No es cosmético: el índice único de comprobantes compara `punto_venta` como
 * TEXTO. El papel imprime cinco dígitos ("00115"), el sistema usa cuatro
 * ("0001") y el QR trae el número pelado (115). Sin normalizar, la misma factura
 * cargada a mano desde el papel y la que entra por la bandeja quedaban como dos
 * puntos de venta distintos — y el control de duplicados no las cruzaba.
 */
export const normalizarPuntoVenta = (v: any) => {
  const d = soloDigitos(v).replace(/^0+/, '');
  return (d || '1').padStart(4, '0');
};

/** 'AAAA-MM-DD' → Date local. Sin la hora, la fecha se corre un día para atrás. */
export const fechaDeTexto = (f?: string | null) => {
  const t = String(f || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? new Date(`${t}T00:00:00`) : null;
};
