/**
 * MODIFICAR UN PAGO A PROVEEDOR (19/11/2026, pedido del dueño desde el estado
 * de cuenta: «permitime poder modificar estos registros»).
 *
 * Antes solo se podía ANULAR (y solo sin nada aplicado) o completar el papel
 * (referencia y concepto). Ahora se corrige en el lugar: fecha, importe, medio
 * (o las partes de un pago mixto, con su cuenta), efectivo por transferencia,
 * referencia, concepto y observaciones. Cada campo que cambia queda en la
 * auditoría del proveedor (antes → después, quién y cuándo).
 *
 * Lo que NO se deja cambiar, y por qué (esta función lo decide; la pantalla lo
 * muestra antes de que alguien lo intente):
 *   · nace de una CUENTA DISPONIBLE (la transferencia de un cliente, o el pago
 *     propio a esa cuenta): la plata la define el cobro, se corrige ahí;
 *   · se cargó desde el CASH FLOW: el egreso del libro del dueño tiene el mismo
 *     importe y día, y cambiar solo el pago los descuadraría (se anula allá y
 *     se vuelve a cargar). El papel sí se completa;
 *   · LO PAGÓ COFFIT: entra a la cuenta con Coffit, que cierra por mes;
 *   · lo pagó un ECHEQ: el importe es el del echeq;
 *   · cerró un COMPROMISO MANUAL: el compromiso se cerró por ese importe;
 *   · salió de un TURNO DE CAJA YA CERRADO: el arqueo se firmó con ese egreso
 *     (la fecha y el papel sí; la plata no).
 * Con el turno todavía abierto, el egreso del cajón se ajusta junto.
 */
export type InfoEdicion = {
  estado: string;
  medio: string;
  cuentaDisponible: boolean;
  desdeCashflow: boolean;
  conEcheq: boolean;
  cierraCompromisoManual: boolean;
  cajaMovimientoId: number | null;
  turnoAbierto: boolean | null;
};

export type Bloqueos = { plata: string | null; fecha: string | null };

export function bloqueosEdicion(p: InfoEdicion): Bloqueos {
  if (p.estado !== 'activo') return { plata: 'El pago está anulado.', fecha: 'El pago está anulado.' };
  if (p.cuentaDisponible) {
    const m = 'Nace de una cuenta disponible del proveedor: se corrige desde Proveedores › Cuentas disponibles.';
    return { plata: m, fecha: m };
  }
  if (p.desdeCashflow) {
    const m = 'Se cargó desde Gerencia › Cash Flow: para cambiar el importe, el medio o la fecha, anulalo ahí y cargalo de nuevo (así la caja del dueño queda igual).';
    return { plata: m, fecha: m };
  }
  if (p.medio === 'pago_coffit') {
    const m = 'Lo pagó Coffit: entra en su cuenta corriente, que se cierra por mes. Anulalo y registralo de nuevo.';
    return { plata: m, fecha: m };
  }
  if (p.conEcheq) return { plata: 'Lo pagó un echeq: el importe y el medio son los del echeq.', fecha: null };
  if (p.cierraCompromisoManual) return { plata: 'Cerró un compromiso de pago por ese importe: anulalo y registralo de nuevo.', fecha: null };
  if (p.cajaMovimientoId && p.turnoAbierto === false) {
    return { plata: 'Salió de un turno de caja ya cerrado: el arqueo se firmó con ese egreso. La fecha y el papel sí se corrigen.', fecha: null };
  }
  return { plata: null, fecha: null };
}

const NOMBRE_MEDIO: Record<string, string> = {
  efectivo: 'Efectivo', transferencia: 'Transferencia', tarjeta_debito: 'Tarjeta de débito', tarjeta_credito: 'Tarjeta de crédito',
  cheque: 'Cheque', qr: 'QR', otro: 'Otro', deposito: 'Depósito', echeq: 'Echeq', pago_coffit: 'Lo pagó Coffit',
};
const pesos = (n: number) => `$ ${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dia = (f: Date | string | null | undefined) => {
  if (!f) return '';
  const d = new Date(f);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
};

/** Cómo salió la plata, en una línea, para la auditoría: «Transferencia desde Galicia» o «Efectivo $ 100,00 + Transferencia $ 50,00». */
export function textoForma(p: {
  medio: string; cambioPor?: string | null; cuenta?: string | null;
  formas?: Array<{ medio: string; importe: number; cuenta?: string | null; fecha?: Date | string | null }>;
}): string {
  if (p.formas && p.formas.length) {
    return p.formas.map((f) => `${NOMBRE_MEDIO[f.medio] ?? f.medio}${f.cuenta ? ` desde ${f.cuenta}` : ''} ${pesos(f.importe)}${f.fecha ? ` (${dia(f.fecha)})` : ''}`).join(' + ');
  }
  if (p.cambioPor) return `Efectivo por transferencia (${p.cambioPor})`;
  return `${NOMBRE_MEDIO[p.medio] ?? p.medio}${p.cuenta ? ` desde ${p.cuenta}` : ''}`;
}

export { pesos as pesosAuditoria, dia as diaAuditoria };
