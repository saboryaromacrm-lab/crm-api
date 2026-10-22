/**
 * LOS ASESORES · LAS HERRAMIENTAS (0193)
 * ============================================================================
 * Cuando el dueño pregunta algo que la foto no tiene, la IA llama a estas
 * herramientas: TODAS de solo lectura y sobre las mismas cuentas del sistema.
 * Nunca escriben nada, nunca devuelven datos de clientes. Un solo registro:
 * cada especialista elige las suyas (`juego`).
 *
 * Esquemas `strict` (la API garantiza la forma). Lo opcional NO va como «o
 * null»: la API admite pocos campos así en total, y la suma de todas las
 * herramientas los pasaba. Va con un valor que significa «por defecto» (texto
 * vacío, 0), y los topes numéricos se aplican acá, porque el esquema estricto
 * no admite mínimos ni máximos.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { Fuentes, Orden } from './datos';
import {
  caja, comparar, costosQueSubieron, fraccionado, gastos, granelYEnteros, mismosDiasMesAnterior, ofertas, paquetes, periodo, producto,
  rentabilidad, resultados, stock, ventas,
} from './datos';
import { compradosJuntos, cupones, fechas, ofertasArmadas, simularPromo, tiendaOnline, vencimientos } from './comercial/datos';
import type { ItemPromo, Promo } from './comercial/simular';
import { periodoAnterior, LENTES, type Lente } from '../metricas/consultas';
import { hoyAr } from '../cafeteria/cuenta';

type Tool = Anthropic.Beta.BetaTool;
type Correr = (f: Fuentes, i: any) => Promise<unknown>;

const fecha = (d: string) => ({ type: 'string', description: d });
const sucursal = { type: 'integer', description: 'Id de la sucursal (ver la lista del contexto). 0 = todas.' };
const texto = (d: string) => ({ type: 'string', description: d });
const entero = (d: string) => ({ type: 'integer', description: d });
const numero = (d: string) => ({ type: 'number', description: d });
const obj = (properties: Record<string, unknown>): Tool['input_schema'] => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
const PERIODO = {
  desde: fecha('Primer día (AAAA-MM-DD). Vacío = el 1° del mes en curso.'),
  hasta: fecha('Último día (AAAA-MM-DD). Vacío = hoy.'),
};
const COMPARAR = {
  comparar_con: {
    type: 'string', enum: ['periodo_anterior', 'mismos_dias_mes_anterior', 'mismo_periodo_anio_anterior'],
    description: 'Contra qué se compara: el período inmediatamente anterior del mismo largo, los mismos días del mes anterior, o las mismas fechas del año pasado.',
  },
};
export const TIPOS_PROMO = ['porcentaje', 'precio_fijo', 'nxm', 'segunda_unidad', 'pack', 'combo', 'ticket'] as const;
/** Los campos de una promoción: los mismos en «simular_promocion» y en las propuestas del informe. */
export const CAMPOS_PROMO = {
  tipo: { type: 'string', enum: [...TIPOS_PROMO], description: 'porcentaje: % por unidad · precio_fijo: cada unidad a precioFinal · nxm: lleva N paga M · segunda_unidad: % en una de cada dos · pack: N unidades a precioFinal · combo: el conjunto de productos (cada uno con su cantidad) a precioFinal · ticket: % sobre todo el ticket desde montoMinimo.' },
  productos: {
    type: 'array', description: 'Los artículos (con su productoId de los datos; presentacionId = el paquete, 0 = el producto suelto o entero; cantidad solo cuenta en combo). Vacío solo en «ticket».',
    items: obj({ productoId: entero('Id del producto.'), presentacionId: entero('Id del paquete; 0 = sin paquete.'), cantidad: entero('Unidades en el combo; 1 en los demás.') }),
  },
  porcentaje: numero('Para porcentaje, segunda_unidad y ticket (0 a 100). 0 si no aplica.'),
  precioFinal: numero('Precio FINAL con IVA, para precio_fijo, pack y combo. 0 si no aplica.'),
  lleva: entero('Para nxm y pack. 0 si no aplica.'),
  paga: entero('Para nxm. 0 si no aplica.'),
  montoMinimo: numero('Para ticket (con IVA). 0 si no aplica.'),
};

/** El período con el que se compara, según lo que pidió la IA. */
function contra(f: ReturnType<typeof periodo>, modo: string) {
  if (modo === 'mismos_dias_mes_anterior') return mismosDiasMesAnterior(f);
  if (modo === 'mismo_periodo_anio_anterior') {
    const menos = (d: string) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`.replace(/-02-29$/, '-02-28');
    return { ...f, desde: menos(f.desde), hasta: menos(f.hasta) };
  }
  return periodoAnterior(f);
}
const mesValido = (m: unknown) => typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const num = (v: unknown, def: number, max: number) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def; };
const suc = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : null);
const pos = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

/** Lo que llega de la IA, limpio: la misma forma para la simulación y para crear la oferta. */
export function promoDe(i: any): Promo {
  return {
    tipo: (TIPOS_PROMO as readonly string[]).includes(i?.tipo) ? i.tipo : 'porcentaje',
    productos: (Array.isArray(i?.productos) ? i.productos : []).slice(0, 12)
      .map((x: any): ItemPromo => ({ productoId: Math.trunc(Number(x?.productoId)) || 0, presentacionId: Math.trunc(Number(x?.presentacionId)) || 0, cantidad: Math.max(1, Math.trunc(Number(x?.cantidad)) || 1) }))
      .filter((x: ItemPromo) => x.productoId > 0),
    porcentaje: Math.min(pos(i?.porcentaje), 100), precioFinal: pos(i?.precioFinal),
    lleva: Math.trunc(pos(i?.lleva)), paga: Math.trunc(pos(i?.paga)), montoMinimo: pos(i?.montoMinimo),
  };
}

const REGISTRO: Record<string, { def: Tool; correr: Correr }> = {
  consultar_ventas: {
    def: {
      name: 'consultar_ventas', strict: true,
      description: 'Ventas netas (sin IVA) de un período comparadas con otro: total, tickets, ticket promedio, por sucursal, por día de la semana, por hora, por medio de pago y por cajero.',
      input_schema: obj({ ...PERIODO, sucursal_id: sucursal, ...COMPARAR }),
    },
    correr: (f, i) => { const p = periodo(i.desde, i.hasta, suc(i.sucursal_id)); return f.metricas.leer((c) => ventas(c, p, contra(p, i.comparar_con))); },
  },
  consultar_rentabilidad: {
    def: {
      name: 'consultar_rentabilidad', strict: true,
      description: 'Margen (venta neta − costo de lo vendido) de un período, agrupado por producto, categoría, marca, proveedor, lista de precios, modalidad o sucursal, comparado con otro período. Sirve para «qué deja más», «qué deja menos», «qué se vende a pérdida» y «dónde cayó el margen». Por producto trae el productoId.',
      input_schema: obj({
        ...PERIODO, sucursal_id: sucursal, ...COMPARAR,
        ver_por: { type: 'string', enum: [...LENTES] },
        orden: { type: 'string', enum: ['venta', 'margen', 'margen_pct_menor', 'margen_pct_mayor', 'caida_margen', 'perdida'], description: 'venta = lo que más vende; margen = lo que más plata deja; margen_pct_menor/mayor = peor/mejor margen %; caida_margen = lo que más bajó de margen; perdida = vendido bajo el costo.' },
        tipo: { type: 'string', enum: ['todos', 'granel', 'entero'] },
        buscar: texto('Filtra por nombre (parte del texto). Vacío = sin filtro.'),
        limite: entero('Cuántas filas (hasta 60). 0 = 15.'),
      }),
    },
    correr: (f, i) => {
      const p = periodo(i.desde, i.hasta, suc(i.sucursal_id));
      const lente: Lente = (LENTES as readonly string[]).includes(i.ver_por) ? i.ver_por : 'producto';
      return f.metricas.leer((c) => rentabilidad(c, p, contra(p, i.comparar_con), lente, {
        orden: i.orden as Orden, limite: num(i.limite, 15, 60), buscar: i.buscar, tipo: i.tipo === 'granel' || i.tipo === 'entero' ? i.tipo : null,
      }));
    },
  },
  comparar_periodos: {
    def: {
      name: 'comparar_periodos', strict: true,
      description: 'Qué cambió entre dos períodos: venta y margen totales, categorías, y los productos que más subieron y más bajaron.',
      input_schema: obj({ a_desde: fecha('AAAA-MM-DD'), a_hasta: fecha('AAAA-MM-DD'), b_desde: fecha('AAAA-MM-DD'), b_hasta: fecha('AAAA-MM-DD'), sucursal_id: sucursal }),
    },
    correr: (f, i) => {
      const a = periodo(i.a_desde, i.a_hasta, suc(i.sucursal_id)); const b = periodo(i.b_desde, i.b_hasta, suc(i.sucursal_id));
      return f.metricas.leer((c) => comparar(c, a, b));
    },
  },
  buscar_producto: {
    def: {
      name: 'buscar_producto', strict: true,
      description: 'Todo de hasta 5 productos que coinciden con el texto: proveedores y costo, stock por sucursal y tamaño, ventas y margen de los últimos 30 días y los 30 anteriores (por tamaño), últimos cambios de costo, último precio por lista y las listas con precio fijo.',
      input_schema: obj({ texto: { type: 'string', description: 'Parte del nombre del producto.' } }),
    },
    correr: (f, i) => f.metricas.leer((c) => producto(c, i.texto)),
  },
  analizar_granel: {
    def: {
      name: 'analizar_granel', strict: true,
      description: 'Granel y su fraccionado: venta en paquetes y suelto, kg fraccionados, por colaborador y tamaño, correcciones y faltantes; y por producto y tamaño de paquete el precio por kg real, el margen, los días que alcanza el stock, qué fraccionar, qué está sobrefraccionado y los precios por kg incoherentes entre tamaños.',
      input_schema: obj({ ...PERIODO, sucursal_id: sucursal, producto: texto('Parte del nombre de un granel. Vacío = todos.') }),
    },
    correr: (f, i) => {
      const p = periodo(i.desde, i.hasta, suc(i.sucursal_id));
      const dias = Math.max(7, Math.min(180, Math.round((Date.parse(p.hasta) - Date.parse(p.desde)) / 86_400_000) + 1));
      return f.metricas.leer(async (c) => ({
        ...(String(i.producto ?? '').trim() ? {} : { ventas: await granelYEnteros(c, p) }),
        fraccionado: await fraccionado(c, p, i.producto),
        paquetes: await paquetes(c, dias, p.sucursalId, i.producto),
      }));
    },
  },
  consultar_stock: {
    def: {
      name: 'consultar_stock', strict: true,
      description: 'Stock valorizado a costo con la venta de los últimos 30 días: lo que se termina, lo parado (sin ventas) y el sobrestock.',
      input_schema: obj({ sucursal_id: sucursal, estado: { type: 'string', enum: ['todos', 'por_agotarse', 'parado', 'sobrestock'] }, limite: entero('Hasta 50. 0 = 15.') }),
    },
    correr: (f, i) => stock(f, suc(i.sucursal_id), i.estado === 'todos' ? null : i.estado, num(i.limite, 15, 50)),
  },
  consultar_resultados: {
    def: {
      name: 'consultar_resultados', strict: true,
      description: 'Estado de resultados por mes (neto): ventas, margen bruto, gastos variables, contribución, gastos fijos, resultado operativo y neto, punto de equilibrio y objetivo.',
      input_schema: obj({ desde_mes: { type: 'string', description: 'AAAA-MM' }, hasta_mes: { type: 'string', description: 'AAAA-MM (no futuro). Hasta 12 meses.' } }),
    },
    correr: (f, i) => {
      const hasta = mesValido(i.hasta_mes) && i.hasta_mes <= hoyAr().slice(0, 7) ? i.hasta_mes : hoyAr().slice(0, 7);
      const desde = mesValido(i.desde_mes) && i.desde_mes <= hasta ? i.desde_mes : hasta;
      const [yd, md] = desde.split('-').map(Number); const [yh, mh] = hasta.split('-').map(Number);
      if ((yh - yd) * 12 + (mh - md) > 11) throw new Error('Pedí hasta 12 meses por vez.');
      return resultados(f, desde, hasta);
    },
  },
  consultar_caja: {
    def: {
      name: 'consultar_caja', strict: true,
      description: 'Cierres de caja de un período: diferencias por cajero y por sucursal (faltantes y sobrantes) y los egresos de caja por concepto.',
      input_schema: obj({ ...PERIODO, sucursal_id: sucursal }),
    },
    correr: (f, i) => { const p = periodo(i.desde, i.hasta, suc(i.sucursal_id)); return f.metricas.leer((c) => caja(c, p)); },
  },
  consultar_gastos: {
    def: {
      name: 'consultar_gastos', strict: true,
      description: 'Gastos de un período (con IVA): total, fijos, variables, lo que falta pagar y por rubro.',
      input_schema: obj({ ...PERIODO, sucursal_id: sucursal }),
    },
    correr: (f, i) => { const p = periodo(i.desde, i.hasta, suc(i.sucursal_id)); return gastos(f, p.desde, p.hasta, p.sucursalId); },
  },
  costos_que_subieron: {
    def: {
      name: 'costos_que_subieron', strict: true,
      description: 'Costos de proveedor que subieron en los últimos días, y cuáles tienen precio fijo que no se actualizó después de la suba.',
      input_schema: obj({ dias: entero('Últimos días a mirar (hasta 365). 0 = 30.') }),
    },
    correr: (f, i) => f.metricas.leer((c) => costosQueSubieron(c, num(i.dias, 30, 365))),
  },
  consultar_ofertas: {
    def: {
      name: 'consultar_ofertas', strict: true,
      description: 'Las ofertas de un período con lo que vendieron, el descuento dado, la ganancia y el veredicto (rentable, al costo, pierde, sin ventas); y las que hoy están activas (vigentes o programadas).',
      input_schema: obj({ ...PERIODO, sucursal_id: sucursal }),
    },
    correr: (f, i) => {
      const p = periodo(i.desde, i.hasta, suc(i.sucursal_id));
      return f.metricas.leer(async (c) => ({ resultados: await ofertas(c, p), activasHoy: await ofertasArmadas(c) }));
    },
  },
  /* ------------------------------ las del comercial ------------------------------ */
  consultar_vencimientos: {
    def: {
      name: 'consultar_vencimientos', strict: true,
      description: 'Los lotes por vencer (cargados en Vencimientos y sin procesar): días que faltan, stock de hoy, lo que se vende por día, si llega a venderse antes de vencer, el valor a costo en riesgo y la oferta que ya tienen. Trae productoId y presentacionId.',
      input_schema: obj({ dias: entero('Hasta cuántos días adelante (hasta 120). 0 = 45.'), sucursal_id: sucursal }),
    },
    correr: (f, i) => f.metricas.leer((c) => vencimientos(c, num(i.dias, 45, 120), suc(i.sucursal_id))),
  },
  consultar_fechas: {
    def: {
      name: 'consultar_fechas', strict: true,
      description: 'Lo que viene: fechas comerciales (Día de la Madre, del Padre, Navidad, Hot Sale…, algunas aproximadas), feriados y fechas propias del dueño, con los días que faltan; y cómo se vendió la misma semana el año pasado (y qué categorías subieron).',
      input_schema: obj({ dias: entero('Hasta cuántos días adelante (hasta 365). 0 = 75.') }),
    },
    correr: (f, i) => f.metricas.leer((c) => fechas(c, num(i.dias, 75, 365))),
  },
  comprados_juntos: {
    def: {
      name: 'comprados_juntos', strict: true,
      description: 'Los pares de productos que más se compran en el mismo ticket (la base de un combo), con cuántas veces, qué % de los tickets de A también llevan B y el lift (cuántas veces más de lo que tocaría por azar). Trae los productoId.',
      input_schema: obj({ dias: entero('Últimos días (hasta 180). 0 = 60.'), sucursal_id: sucursal, limite: entero('Hasta 60. 0 = 25.') }),
    },
    correr: (f, i) => f.metricas.leer((c) => compradosJuntos(c, num(i.dias, 60, 180), suc(i.sucursal_id), num(i.limite, 25, 60))),
  },
  consultar_tienda_online: {
    def: {
      name: 'consultar_tienda_online', strict: true,
      description: 'La tienda online minorista y la mayorista: visitas, conversión, embudo (miró, carrito, pedido), lo más visto, lo que se mira y no se compra, lo más buscado y cómo rinden las ofertas en la tienda, contra el período anterior.',
      input_schema: obj({ dias: entero('Últimos días (hasta 180). 0 = 30.') }),
    },
    correr: (f, i) => tiendaOnline(f, num(i.dias, 30, 180)),
  },
  consultar_cupones: {
    def: {
      name: 'consultar_cupones', strict: true,
      description: 'Los cupones de la tienda minorista: usos, clientes nuevos, venta, descuento y ganancia final de cada uno, y el ticket promedio sin cupón.',
      input_schema: obj({ ...PERIODO }),
    },
    correr: (f, i) => { const p = periodo(i.desde, i.hasta); return cupones(f, p.desde, p.hasta); },
  },
  simular_promocion: {
    def: {
      name: 'simular_promocion', strict: true,
      description: 'Calcula, con el precio de la lista base y el costo real de hoy, el precio que queda con una promoción y cuánto deja (o si queda bajo el costo). Usala SIEMPRE antes de proponer una promoción con números.',
      input_schema: obj(CAMPOS_PROMO),
    },
    correr: (f, i) => f.metricas.leer((c) => simularPromo(f, c, promoDe(i))),
  },
};

/** Las herramientas de un especialista y cómo correrlas (solo las suyas). */
export function juego(nombres: string[]) {
  const propias = nombres.map((n) => { const h = REGISTRO[n]; if (!h) throw new Error(`Herramienta desconocida: ${n}`); return h; });
  const permitidas = new Set(nombres);
  return {
    herramientas: propias.map((h) => h.def),
    ejecutar: (f: Fuentes, nombre: string, input: any) => {
      if (!permitidas.has(nombre)) throw new Error(`No existe la herramienta «${nombre}».`);
      return REGISTRO[nombre].correr(f, input);
    },
  };
}
