/**
 * ARCA — los códigos y el armado del comprobante
 * ============================================================================
 * Traduce el vocabulario del sistema (`factura_a`, `consumidor_final`, IVA
 * 21%) al de ARCA (números). Es puro: no toca base ni red, así que se puede
 * probar entero sin certificado — y por eso vive separado de `wsfe.ts`.
 *
 * ACÁ ESTÁ LA DIFERENCIA GRANDE CON LA GUÍA DE LA CAFETERÍA. Aquella emitía
 * **Factura C** de Monotributo: sin IVA, `ImpIVA = 0`, sin desglose. Sabor y
 * Aroma es **Responsable Inscripto**, así que emite **A y B con el IVA
 * discriminado**: el comprobante lleva un renglón por alícuota, cada uno con
 * su base imponible y su importe, y las sumas tienen que cerrar AL CENTAVO
 * contra `ImpNeto` e `ImpIVA`. Ver `armarAlicuotas()`.
 */

/* ------------------------------ Códigos ------------------------------ */

/**
 * Tipo de comprobante (tabla FEParamGetTiposCbte). Cada tipo lleva su propia
 * numeración correlativa dentro del punto de venta.
 */
export const CBTE_TIPO: Record<string, number> = {
  factura_a: 1,
  factura_b: 6,
  factura_c: 11,
  nota_debito_a: 2,
  nota_debito_b: 7,
  nota_debito_c: 12,
  nota_credito_a: 3,
  nota_credito_b: 8,
  nota_credito_c: 13,
};

/** Tipo de documento del receptor (FEParamGetTiposDoc). */
export const DOC_TIPO = {
  CUIT: 80,
  CUIL: 86,
  DNI: 96,
  /** Consumidor final sin identificar: va con número 0. */
  SIN_IDENTIFICAR: 99,
} as const;

/**
 * Condición de IVA del RECEPTOR (RG 5616). Es **obligatoria** desde 2024 y ARCA
 * rechaza el comprobante si falta o si no condice con la letra.
 */
export const COND_IVA_RECEPTOR: Record<string, number> = {
  responsable_inscripto: 1,
  exento: 4,
  consumidor_final: 5,
  monotributo: 6,
  no_categorizado: 7,
};

/**
 * Id de alícuota (FEParamGetTiposIva). Las claves son las alícuotas de
 * `common/iva.ts` — si alguna vez se agrega una allá, tiene que entrar acá o
 * el comprobante se arma sin ese renglón y la suma no cierra.
 */
export const ALICUOTA_ID: Record<string, number> = {
  '0': 3,
  '10.5': 4,
  '21': 5,
  '27': 6,
  '5': 8,
  '2.5': 9,
};

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/* --------------------------- El desglose --------------------------- */

export interface RenglonFiscal {
  /** Neto del renglón, ya con descuentos y ofertas aplicados. */
  neto: number;
  /** Alícuota en porcentaje: 21, 10.5, 0… */
  iva: number;
}

export interface AlicuotaArca {
  id: number;
  baseImp: number;
  importe: number;
}

/**
 * AGRUPA LOS RENGLONES POR ALÍCUOTA Y CUADRA LAS SUMAS.
 *
 * ARCA valida que `sum(baseImp) === ImpNeto` y `sum(importe) === ImpIVA`, **al
 * centavo**, y rechaza el comprobante entero por un centavo de diferencia.
 *
 * El problema es real y no teórico: el sistema redondea RENGLÓN POR RENGLÓN al
 * calcular la venta (para que el ticket impreso cierre consigo mismo), así que
 * la suma de los netos redondeados puede diferir en centavos del `subtotalNeto`
 * guardado en la cabecera. Si mandáramos las dos cosas calculadas por caminos
 * distintos, tarde o temprano no coinciden.
 *
 * La solución es la del vuelto: se reparte normal y **la diferencia se le
 * carga al renglón más grande** (el que menos se distorsiona en términos
 * relativos). Así las sumas cierran exactas contra los totales que ya están
 * escritos en la venta, que son los que el cliente vio y pagó.
 */
export function armarAlicuotas(
  renglones: RenglonFiscal[],
  totales: { neto: number; iva: number },
): AlicuotaArca[] {
  const porAlicuota = new Map<number, { base: number; importe: number }>();
  for (const r of renglones) {
    const alic = Number(r.iva) || 0;
    const acc = porAlicuota.get(alic) ?? { base: 0, importe: 0 };
    acc.base += Number(r.neto) || 0;
    acc.importe += (Number(r.neto) || 0) * alic / 100;
    porAlicuota.set(alic, acc);
  }

  const filas = [...porAlicuota.entries()]
    .map(([alic, v]) => {
      const id = ALICUOTA_ID[String(alic)];
      if (!id) throw new Error(`No hay código de ARCA para la alícuota de IVA ${alic}%.`);
      return { id, baseImp: r2(v.base), importe: r2(v.importe) };
    })
    .sort((a, b) => b.baseImp - a.baseImp);

  if (!filas.length) return [];

  /* El ajuste del centavo, sobre el renglón de base más grande (está primero). */
  const difBase = r2(r2(totales.neto) - r2(filas.reduce((a, f) => a + f.baseImp, 0)));
  const difIva = r2(r2(totales.iva) - r2(filas.reduce((a, f) => a + f.importe, 0)));
  filas[0].baseImp = r2(filas[0].baseImp + difBase);
  filas[0].importe = r2(filas[0].importe + difIva);

  return filas;
}

/* ------------------------- El receptor ------------------------- */

export interface Receptor {
  tipoDoc: string;          // 'cuit' | 'cuil' | 'dni' | 'sin_identificar'
  numeroDoc: string;
  condicionIva: string;     // enum condicion_iva
  esConsumidorFinal: boolean;
}

export interface ReceptorArca {
  docTipo: number;
  docNro: string;
  condIvaReceptorId: number;
}

/**
 * El documento del receptor tal como lo quiere ARCA.
 *
 * DOS REGLAS QUE ARCA IMPONE Y CONVIENE FRENAR ACÁ, con un mensaje que se
 * entienda, en vez de comerse un rechazo con código:
 *
 *  · **Una Factura A EXIGE CUIT.** Se le emite a un responsable inscripto, y
 *    sin CUIT no hay factura A posible.
 *  · **Una Factura B a consumidor final** puede ir sin identificar (99/0)
 *    mientras no supere el tope que fija ARCA; arriba de ese monto exige
 *    documento. El tope lo mueven por resolución, así que vive en la
 *    configuración y no clavado acá.
 */
export function armarReceptor(
  letra: 'A' | 'B' | 'C',
  receptor: Receptor,
  total: number,
  topeSinIdentificar: number,
): ReceptorArca {
  const digitos = String(receptor.numeroDoc ?? '').replace(/\D/g, '');
  const condIva = COND_IVA_RECEPTOR[receptor.condicionIva] ?? COND_IVA_RECEPTOR.consumidor_final;

  if (letra === 'A') {
    if (receptor.tipoDoc !== 'cuit' || digitos.length !== 11) {
      throw new Error(
        'Una Factura A necesita el CUIT del cliente (11 dígitos). '
        + 'Cargáselo en su ficha o emitile Factura B.',
      );
    }
    return { docTipo: DOC_TIPO.CUIT, docNro: digitos, condIvaReceptorId: condIva };
  }

  const identificado = digitos.length > 0 && receptor.tipoDoc !== 'sin_identificar';
  if (!identificado) {
    if (topeSinIdentificar > 0 && total > topeSinIdentificar) {
      throw new Error(
        `Una venta de $${total.toFixed(2)} supera el tope para facturar sin identificar `
        + `($${topeSinIdentificar.toFixed(2)}): pedile el DNI o el CUIT al cliente y cargalo en su ficha.`,
      );
    }
    return { docTipo: DOC_TIPO.SIN_IDENTIFICAR, docNro: '0', condIvaReceptorId: condIva };
  }

  const tipo = receptor.tipoDoc === 'cuit' ? DOC_TIPO.CUIT
    : receptor.tipoDoc === 'cuil' ? DOC_TIPO.CUIL
      : DOC_TIPO.DNI;
  return { docTipo: tipo, docNro: digitos, condIvaReceptorId: condIva };
}

/** La letra de un tipo de venta del sistema. */
export function letraDe(tipo: string): 'A' | 'B' | 'C' | null {
  if (tipo.endsWith('_a')) return 'A';
  if (tipo.endsWith('_b')) return 'B';
  if (tipo.endsWith('_c')) return 'C';
  return null;
}

/** ¿Este tipo de venta es un comprobante FISCAL (va a ARCA)? */
export const esFiscal = (tipo: string) => !!CBTE_TIPO[tipo];
