/**
 * GERENCIA › ASESOR · LAS HERRAMIENTAS DE LAS PREGUNTAS (0193)
 * ============================================================================
 * Cuando el dueño pregunta algo que la foto no tiene, la IA llama a estas
 * herramientas: TODAS de solo lectura y sobre las mismas cuentas del sistema
 * (datos.ts). Nunca escriben nada, nunca devuelven datos de clientes.
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
import { periodoAnterior, LENTES, type Lente } from '../metricas/consultas';
import { hoyAr } from '../cafeteria/cuenta';

type Tool = Anthropic.Beta.BetaTool;

const fecha = (d: string) => ({ type: 'string', description: d });
const sucursal = { type: 'integer', description: 'Id de la sucursal (ver la lista del contexto). 0 = todas.' };
const texto = (d: string) => ({ type: 'string', description: d });
const entero = (d: string) => ({ type: 'integer', description: d });
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

export const HERRAMIENTAS: Tool[] = [
  {
    name: 'consultar_ventas', strict: true,
    description: 'Ventas netas (sin IVA) de un período comparadas con otro: total, tickets, ticket promedio, por sucursal, por día de la semana, por hora, por medio de pago y por cajero.',
    input_schema: obj({ ...PERIODO, sucursal_id: sucursal, ...COMPARAR }),
  },
  {
    name: 'consultar_rentabilidad', strict: true,
    description: 'Margen (venta neta − costo de lo vendido) de un período, agrupado por producto, categoría, marca, proveedor, lista de precios, modalidad o sucursal, comparado con otro período. Sirve para «qué deja más», «qué deja menos», «qué se vende a pérdida» y «dónde cayó el margen».',
    input_schema: obj({
      ...PERIODO, sucursal_id: sucursal, ...COMPARAR,
      ver_por: { type: 'string', enum: [...LENTES] },
      orden: { type: 'string', enum: ['venta', 'margen', 'margen_pct_menor', 'margen_pct_mayor', 'caida_margen', 'perdida'], description: 'venta = lo que más vende; margen = lo que más plata deja; margen_pct_menor/mayor = peor/mejor margen %; caida_margen = lo que más bajó de margen; perdida = vendido bajo el costo.' },
      tipo: { type: 'string', enum: ['todos', 'granel', 'entero'] },
      buscar: texto('Filtra por nombre (parte del texto). Vacío = sin filtro.'),
      limite: entero('Cuántas filas (hasta 60). 0 = 15.'),
    }),
  },
  {
    name: 'comparar_periodos', strict: true,
    description: 'Qué cambió entre dos períodos: venta y margen totales, categorías, y los productos que más subieron y más bajaron.',
    input_schema: obj({
      a_desde: fecha('AAAA-MM-DD'), a_hasta: fecha('AAAA-MM-DD'), b_desde: fecha('AAAA-MM-DD'), b_hasta: fecha('AAAA-MM-DD'), sucursal_id: sucursal,
    }),
  },
  {
    name: 'buscar_producto', strict: true,
    description: 'Todo de hasta 5 productos que coinciden con el texto: proveedores y costo, stock por sucursal y tamaño, ventas y margen de los últimos 30 días y los 30 anteriores (por tamaño), últimos cambios de costo y último precio por lista.',
    input_schema: obj({ texto: { type: 'string', description: 'Parte del nombre del producto.' } }),
  },
  {
    name: 'analizar_granel', strict: true,
    description: 'Granel y su fraccionado: venta en paquetes y suelto, kg fraccionados, por colaborador y tamaño, correcciones y faltantes; y por producto y tamaño de paquete el precio por kg real, el margen, los días que alcanza el stock, qué fraccionar, qué está sobrefraccionado y los precios por kg incoherentes entre tamaños.',
    input_schema: obj({ ...PERIODO, sucursal_id: sucursal, producto: texto('Parte del nombre de un granel. Vacío = todos.') }),
  },
  {
    name: 'consultar_stock', strict: true,
    description: 'Stock valorizado a costo con la venta de los últimos 30 días: lo que se termina, lo parado (sin ventas) y el sobrestock.',
    input_schema: obj({ sucursal_id: sucursal, estado: { type: 'string', enum: ['todos', 'por_agotarse', 'parado', 'sobrestock'] }, limite: entero('Hasta 50. 0 = 15.') }),
  },
  {
    name: 'consultar_resultados', strict: true,
    description: 'Estado de resultados por mes (neto): ventas, margen bruto, gastos variables, contribución, gastos fijos, resultado operativo y neto, punto de equilibrio y objetivo.',
    input_schema: obj({
      desde_mes: { type: 'string', description: 'AAAA-MM' }, hasta_mes: { type: 'string', description: 'AAAA-MM (no futuro). Hasta 12 meses.' },
    }),
  },
  {
    name: 'consultar_caja', strict: true,
    description: 'Cierres de caja de un período: diferencias por cajero y por sucursal (faltantes y sobrantes) y los egresos de caja por concepto.',
    input_schema: obj({ ...PERIODO, sucursal_id: sucursal }),
  },
  {
    name: 'consultar_gastos', strict: true,
    description: 'Gastos de un período (con IVA): total, fijos, variables, lo que falta pagar y por rubro.',
    input_schema: obj({ ...PERIODO, sucursal_id: sucursal }),
  },
  {
    name: 'costos_que_subieron', strict: true,
    description: 'Costos de proveedor que subieron en los últimos días, y cuáles tienen precio fijo que no se actualizó después de la suba.',
    input_schema: obj({ dias: entero('Últimos días a mirar (hasta 365). 0 = 30.') }),
  },
  {
    name: 'consultar_ofertas', strict: true,
    description: 'Las ofertas del período con lo que vendieron, el descuento dado, la ganancia y el veredicto (rentable, al costo, pierde, sin ventas).',
    input_schema: obj({ ...PERIODO, sucursal_id: sucursal }),
  },
];

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

/** Corre una herramienta. Devuelve JSON (texto) o lanza con un motivo que la IA puede leer y corregir. */
export async function ejecutar(fuentes: Fuentes, nombre: string, i: any): Promise<unknown> {
  const m = fuentes.metricas;
  switch (nombre) {
    case 'consultar_ventas': {
      const f = periodo(i.desde, i.hasta, suc(i.sucursal_id));
      return m.leer((c) => ventas(c, f, contra(f, i.comparar_con)));
    }
    case 'consultar_rentabilidad': {
      const f = periodo(i.desde, i.hasta, suc(i.sucursal_id));
      const lente: Lente = (LENTES as readonly string[]).includes(i.ver_por) ? i.ver_por : 'producto';
      return m.leer((c) => rentabilidad(c, f, contra(f, i.comparar_con), lente, {
        orden: i.orden as Orden, limite: num(i.limite, 15, 60), buscar: i.buscar, tipo: i.tipo === 'granel' || i.tipo === 'entero' ? i.tipo : null,
      }));
    }
    case 'comparar_periodos': {
      const a = periodo(i.a_desde, i.a_hasta, suc(i.sucursal_id)); const b = periodo(i.b_desde, i.b_hasta, suc(i.sucursal_id));
      return m.leer((c) => comparar(c, a, b));
    }
    case 'buscar_producto':
      return m.leer((c) => producto(c, i.texto));
    case 'analizar_granel': {
      const f = periodo(i.desde, i.hasta, suc(i.sucursal_id));
      const dias = Math.max(7, Math.min(180, Math.round((Date.parse(f.hasta) - Date.parse(f.desde)) / 86_400_000) + 1));
      return m.leer(async (c) => ({
        ...(String(i.producto ?? '').trim() ? {} : { ventas: await granelYEnteros(c, f) }),
        fraccionado: await fraccionado(c, f, i.producto),
        paquetes: await paquetes(c, dias, f.sucursalId, i.producto),
      }));
    }
    case 'consultar_stock':
      return stock(fuentes, suc(i.sucursal_id), i.estado === 'todos' ? null : i.estado, num(i.limite, 15, 50));
    case 'consultar_resultados': {
      const hasta = mesValido(i.hasta_mes) && i.hasta_mes <= hoyAr().slice(0, 7) ? i.hasta_mes : hoyAr().slice(0, 7);
      const desde = mesValido(i.desde_mes) && i.desde_mes <= hasta ? i.desde_mes : hasta;
      const [yd, md] = desde.split('-').map(Number); const [yh, mh] = hasta.split('-').map(Number);
      if ((yh - yd) * 12 + (mh - md) > 11) throw new Error('Pedí hasta 12 meses por vez.');
      return resultados(fuentes, desde, hasta);
    }
    case 'consultar_caja': {
      const f = periodo(i.desde, i.hasta, suc(i.sucursal_id));
      return m.leer((c) => caja(c, f));
    }
    case 'consultar_gastos': {
      const f = periodo(i.desde, i.hasta, suc(i.sucursal_id));
      return gastos(fuentes, f.desde, f.hasta, f.sucursalId);
    }
    case 'costos_que_subieron':
      return m.leer((c) => costosQueSubieron(c, num(i.dias, 30, 365)));
    case 'consultar_ofertas': {
      const f = periodo(i.desde, i.hasta, suc(i.sucursal_id));
      return m.leer((c) => ofertas(c, f));
    }
    default:
      throw new Error(`No existe la herramienta «${nombre}».`);
  }
}
