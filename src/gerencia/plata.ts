/**
 * «¿DÓNDE ESTÁ MI PLATA?» — las reglas puras (26/11/2026, pedido del dueño:
 * «siento que me falta dinero… todo lo que me ingresa menos todo lo que pago…
 * que no me mienta»). El servicio (plata.module.ts) junta los números; acá se
 * decide qué es cada cosa, para que haya UNA sola regla y se pueda probar.
 *
 * LA REGLA DE ORO: cada peso se cuenta UNA vez y en su lugar.
 *   · ENTRÓ  = plata que llegó al negocio desde afuera (lo cobrado: ventas y
 *              cobranzas por medio, y los ingresos cargados a mano).
 *   · SALIÓ  = plata que se fue del negocio (proveedores, gastos, sueldos,
 *              retiros del dueño, comisiones de Mercado Pago, devoluciones).
 *   · NO CUENTA (pasa de un bolsillo a otro, o nunca pasó por tus manos):
 *              los sobres de los locales a la caja central, el depósito del
 *              efectivo en el banco, el «cambio a mi cuenta», y lo que un
 *              cliente le transfirió DIRECTO a un proveedor (entra y sale en el
 *              mismo acto: se muestra aparte, sin sumar).
 *   · FUGAS  = las diferencias de efectivo que ya se midieron: cierres de caja,
 *              sobres contados distinto y ajustes al contar la caja central.
 *              «Entró − salió» supone que la plata estaba; las fugas dicen
 *              cuánta no estaba.
 */

export const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** Lo que es un concepto del Cash Flow o de la caja, por su NOMBRE (igual que `cashflow/conceptos.ts`). */
export type ClaseConcepto = 'interno' | 'retiro' | 'sueldos' | 'otro';
const sinTildes = (s: string) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export function claseConcepto(nombre: string): ClaseConcepto {
  const n = sinTildes(nombre);
  if (n.includes('deposito') || n.includes('efectivo por transferencia') || n.includes('cambio a mi cuenta')) return 'interno';
  if (n.includes('retiro')) return 'retiro';
  if (n.includes('adelanto') || n.includes('sueldo')) return 'sueldos';
  return 'otro';
}

/** Los medios de cobro, agrupados como los mira el dueño. `null` = no es plata tuya (no entra en «Entró»). */
export type GrupoCobro = 'efectivo' | 'mercadopago' | 'transferencia' | 'otros';
export function grupoCobro(medio: string): GrupoCobro | null {
  switch (medio) {
    case 'efectivo': return 'efectivo';
    case 'qr': case 'tarjeta_debito': case 'tarjeta_credito': return 'mercadopago';
    case 'transferencia': return 'transferencia';
    case 'transferencia_proveedor': case 'nota_credito': case 'pago_coffit': return null;
    default: return 'otros';
  }
}

export const TEXTO_MEDIO: Record<string, string> = {
  efectivo: 'Efectivo', qr: 'QR', tarjeta_debito: 'Débito', tarjeta_credito: 'Crédito', transferencia: 'Transferencia',
  cheque: 'Cheque', otro: 'Otro', deposito: 'Depósito', echeq: 'Echeq',
};

/**
 * DE DÓNDE SALIÓ un pago (una parte, si fue mixto): es lo que dice en qué
 * bolsillo se notó. El efectivo de la caja de un local, el de la caja central
 * (Cash Flow), el efectivo que otro transfirió, una cuenta propia, un echeq.
 */
export function deDondeSalio(p: { medio: string; cajaSesionId?: number | null; deCf?: boolean; cambioPor?: string | null; cuenta?: string | null }): string {
  if (p.medio === 'efectivo') return p.cajaSesionId ? 'Efectivo de la caja de un local' : p.deCf ? 'Efectivo de la caja central' : 'Efectivo que no salió de ninguna caja';
  if (p.medio === 'deposito') return p.deCf ? 'Efectivo depositado (de la caja central)' : 'Depósito que no salió de ninguna caja';
  if (p.medio === 'transferencia') {
    if (p.cambioPor) return 'Efectivo por transferencia';
    return p.cuenta ? `Transferencia desde ${p.cuenta}` : 'Transferencia (sin cuenta)';
  }
  if (p.medio === 'echeq') return 'Echeq debitado';
  return TEXTO_MEDIO[p.medio] ?? p.medio;
}

/**
 * EN QUÉ SE FUE un pago: mercadería, o el rubro del gasto según cómo lo lee
 * Resultados (`gasto_categorias.resultado`). Los sueldos van con los adelantos.
 */
export type GrupoSalida = 'mercaderia' | 'gastos' | 'sueldos' | 'impuestos' | 'financiero' | 'fuera' | 'retiros' | 'comisiones_mp' | 'devoluciones' | 'otros';
export function grupoDelPago(destino: string, resultado: string | null): GrupoSalida {
  if (destino !== 'gastos') return 'mercaderia';
  switch (resultado) {
    case 'sueldos': return 'sueldos';
    case 'iibb': case 'municipalidad': case 'ganancias': return 'impuestos';
    case 'financiero': case 'comisiones': return 'financiero';
    case 'fuera': return 'fuera';
    default: return 'gastos';
  }
}

export const TEXTO_SALIDA: Record<GrupoSalida, string> = {
  mercaderia: 'Proveedores de mercadería',
  gastos: 'Gastos del negocio',
  sueldos: 'Sueldos y adelantos',
  impuestos: 'Impuestos',
  financiero: 'Gastos financieros y comisiones cargadas',
  fuera: 'Fuera del resultado',
  retiros: 'Retiros del dueño',
  comisiones_mp: 'Comisiones y retenciones de Mercado Pago',
  devoluciones: 'Devoluciones en efectivo a clientes',
  otros: 'Otros egresos',
};
export const ORDEN_SALIDA: GrupoSalida[] = ['mercaderia', 'gastos', 'sueldos', 'impuestos', 'financiero', 'comisiones_mp', 'devoluciones', 'otros', 'fuera', 'retiros'];

export const TEXTO_ENTRADA: Record<string, string> = {
  efectivo: 'Cobrado en efectivo',
  mercadopago: 'Cobrado con QR y tarjetas (Mercado Pago)',
  transferencia: 'Transferencias de clientes',
  otros: 'Cheques y otros medios',
  cobranzas: 'Cobranzas de cuentas corrientes',
  ingresos: 'Ingresos cargados a mano',
};
export const ORDEN_ENTRADA = ['efectivo', 'mercadopago', 'transferencia', 'otros', 'cobranzas', 'ingresos'];

export type Renglon = { texto: string; importe: number };
export type Grupo = { clave: string; texto: string; importe: number; detalle: Renglon[] };

/** Suma renglones en grupos ordenados, con su detalle de mayor a menor; deja afuera lo que da $0. */
export function agrupar(filas: { grupo: string; texto: string; importe: number }[], textos: Record<string, string>, orden: string[]): Grupo[] {
  const m = new Map<string, Map<string, number>>();
  for (const f of filas) {
    const v = Number(f.importe) || 0;
    if (Math.abs(v) < 0.005) continue;
    if (!m.has(f.grupo)) m.set(f.grupo, new Map());
    const d = m.get(f.grupo)!;
    d.set(f.texto, (d.get(f.texto) ?? 0) + v);
  }
  const claves = [...m.keys()].sort((a, b) => (orden.indexOf(a) + 1 || 99) - (orden.indexOf(b) + 1 || 99));
  return claves.map((clave) => {
    const detalle = [...m.get(clave)!.entries()].map(([texto, importe]) => ({ texto, importe: r2(importe) }))
      .filter((x) => Math.abs(x.importe) >= 0.005)
      .sort((a, b) => Math.abs(b.importe) - Math.abs(a.importe));
    return { clave, texto: textos[clave] ?? clave, importe: r2(detalle.reduce((a, x) => a + x.importe, 0)), detalle };
  }).filter((g) => Math.abs(g.importe) >= 0.005 || g.detalle.length);
}

export const suma = (gs: { importe: number }[]) => r2(gs.reduce((a, g) => a + (Number(g.importe) || 0), 0));

/**
 * EL SALDO ESTIMADO de una cuenta: el último que cargó el dueño, más lo que
 * el ERP sabe que entró desde entonces, menos lo que se pagó desde ahí. Sin
 * saldo cargado no hay estimado: el ERP no inventa el punto de partida.
 */
export function estimarSaldo(saldo: number | null | undefined, entro: number, salio: number): number | null {
  if (saldo == null || !Number.isFinite(Number(saldo))) return null;
  return r2(Number(saldo) + (Number(entro) || 0) - (Number(salio) || 0));
}

/** Las fugas de efectivo del período: faltantes (negativos), sobrantes (positivos) y el neto. */
export function sumarFugas(partes: { faltantes: number; sobrantes: number }[]) {
  const faltantes = r2(partes.reduce((a, p) => a + (Number(p.faltantes) || 0), 0));
  const sobrantes = r2(partes.reduce((a, p) => a + (Number(p.sobrantes) || 0), 0));
  return { faltantes, sobrantes, neto: r2(faltantes + sobrantes) };
}

/** ¿Este pago es efectivo? (efectivo, depósito de efectivo, o efectivo que otro transfirió). */
export const esPagoEnEfectivo = (medio: string, cambio: boolean) => medio === 'efectivo' || medio === 'deposito' || (medio === 'transferencia' && cambio);

/**
 * EL CUADRE DEL EFECTIVO: todo el efectivo pasa por el sistema (las cajas de
 * los locales, los sobres, la caja central), así que lo que había al empezar
 * + lo que entró − lo que salió − lo que se depositó en una cuenta + las
 * diferencias ya medidas TIENE que dar lo que hay al terminar. Lo que no da
 * es «sin explicar»: un error de carga o plata que se movió sin registrar.
 */
export function cuadrarEfectivo(c: { inicio: number; fin: number; entro: number; salio: number; aCuentas: number; fugas: number }) {
  const esperado = r2(c.entro - c.salio - c.aCuentas + c.fugas);
  const real = r2(c.fin - c.inicio);
  return { esperado, real, sinExplicar: r2(real - esperado) };
}

/** Un día 'AAAA-MM-DD' válido. */
export const esDia = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
