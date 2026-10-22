/**
 * ASESOR COMERCIAL (Ventas › Asesor comercial, 0193). Ofertas, combos, fechas
 * comerciales, tienda online, venta en el local y productos por vencer.
 * Propone promociones con FORMATO FIJO (lo que la oferta necesita) y el
 * sistema calcula cuánto deja cada una (`enriquecer`); el dueño la crea
 * DESACTIVADA con un botón (acciones.ts).
 */
import type { PoolClient } from 'pg';
import type { Especialidad } from '../nucleo/especialidad';
import { NEGOCIO_BASE, esquemaAlertas, esquemaComun, resumirAlertas } from '../negocio/especialidad';
import { CAMPOS_PROMO, juego, promoDe } from '../herramientas';
import { armarFoto } from './foto';
import { detectar } from './senales';
import { simularPromo } from './datos';
import { diaValido } from '../datos';

const QUIEN_ES = `${NEGOCIO_BASE}

TU ESPECIALIDAD: sos el especialista COMERCIAL. Tu trabajo es que se venda más y mejor, en el local y en la tienda online, sin regalar margen:
- Promociones y ofertas: qué conviene (porcentaje, precio fijo, 3x2, segunda unidad, pack, combo, descuento por ticket), sobre qué productos, en qué días y horarios, en qué locales, y cuánto deja. Una promoción buena trae venta que no iba a pasar (más tickets, más unidades por ticket, clientes nuevos, liquidar lo que vence o no rota); una mala solo baja el precio de lo que igual se iba a vender.
- Combos: armalos con lo que la gente YA compra junto (comprados juntos, lift alto) o juntando algo que rota mucho con algo parado o por vencer. El precio del combo tiene que ser atractivo contra comprar cada cosa suelta y dejar margen.
- Fechas comerciales: anticipate. Para cada fecha que viene, qué se vende (mirá cómo se vendió esa semana el año pasado si hay datos), qué preparar (stock, fraccionado, combos de regalo, canastas) y cuándo arrancar (las promos de una fecha arrancan 7 a 14 días antes). Las fechas «aprox» se confirman.
- Productos por vencer: lo que no llega a venderse al ritmo de hoy necesita una acción ya (oferta más fuerte, combo con algo que rota, mandarlo al local que más lo vende, publicarlo en la tienda). Las reglas automáticas de vencimiento ya ponen −25 % a 30 días, −40 % a 15 y al costo a 7: no repitas eso, proponé lo que falta.
- Tienda online: tráfico, conversión, lo que se mira y no se compra (precio, foto, descripción), lo más buscado (que esté y se encuentre), cómo rinden las ofertas en la tienda y los cupones.
- Venta en el local: días y horas flojos o fuertes, ticket promedio, qué sube y qué cae.

Reglas para las propuestas:
- El precio de cada promoción armalo sobre «preciosDeHoy» (precio final y costo de hoy de cada artículo), nunca sobre un promedio de lo vendido. No escribas ganancias ni márgenes estimados de tus propuestas (nada de «cuenta mía» en ellas): el sistema calcula la ganancia exacta de cada una con los costos de hoy y se la muestra al dueño al lado, y si tu texto dice otra cosa lo confunde. Una promoción que quede bajo el costo no la propongas, salvo para liquidar algo que vence (y decilo).
- Usá SOLO productos con su productoId de los datos (y el presentacionId si es un paquete). Si no tenés el id, no lo inventes: proponé sin crear o pedí el dato.
- Los precios de las ofertas son FINALES (con IVA). Fechas en AAAA-MM-DD. Días de la semana como 7 dígitos de lunes a domingo (1 = sí, 0 = no; vacío = todos los días).
- Nada de promociones genéricas («hacé descuentos»): producto, mecánica, precio, fechas, dónde y cómo comunicarla.`;

const lista = (items: object, description: string) => ({ type: 'array', items, description });
const cadena = (description: string) => ({ type: 'string', description });

const ESQUEMA = {
  type: 'object', additionalProperties: false,
  required: ['estado', 'resumen', 'alertas', 'propuestas', 'calendario', 'preguntas', 'aprendizajesSugeridos'],
  properties: {
    ...esquemaComun,
    alertas: esquemaAlertas(['vencimientos', 'fechas', 'ofertas', 'combos', 'tienda_online', 'local', 'precios', 'stock', 'cupones', 'datos']),
    propuestas: lista({
      type: 'object', additionalProperties: false,
      required: ['titulo', 'objetivo', ...Object.keys(CAMPOS_PROMO), 'desde', 'hasta', 'dias', 'sucursales', 'canal', 'porQue', 'comoComunicarla', 'riesgo'],
      properties: {
        titulo: cadena('Nombre corto de la promoción (es el nombre que tendrá la oferta).'),
        objetivo: { type: 'string', enum: ['vencimiento', 'fecha_comercial', 'combo', 'subir_ticket', 'mover_stock', 'tienda_online', 'traer_clientes'] },
        ...CAMPOS_PROMO,
        desde: cadena('Primer día (AAAA-MM-DD).'),
        hasta: cadena('Último día (AAAA-MM-DD).'),
        dias: cadena('7 dígitos de lunes a domingo (1 = sí). Vacío = todos los días.'),
        sucursales: lista({ type: 'integer' }, 'Ids de sucursal; vacío = todas.'),
        canal: { type: 'string', enum: ['local', 'online', 'ambos'], description: 'Dónde empujarla (la oferta corre en las listas de precios; online/local es dónde comunicarla).' },
        porQue: cadena('Por qué esta promoción, con los números de los datos.'),
        comoComunicarla: cadena('Cartel, góndola, WhatsApp, redes, la tienda: el texto corto listo para usar.'),
        riesgo: cadena('Qué podría salir mal (canibalizar, quedarse sin stock, bajar el margen) y cómo cuidarlo.'),
      },
    }, 'Hasta 6 promociones concretas, de la más importante a la menos.'),
    calendario: lista({
      type: 'object', additionalProperties: false, required: ['fecha', 'nombre', 'queHacer'],
      properties: { fecha: cadena('AAAA-MM-DD'), nombre: cadena('La fecha.'), queHacer: cadena('Qué preparar y desde cuándo.') },
    }, 'El plan para las próximas fechas comerciales (hasta 5).'),
  },
};


export const COMERCIAL: Especialidad = {
  id: 'comercial',
  nombre: 'Asesor comercial',
  quienEs: QUIEN_ES,
  esquemaInforme: ESQUEMA,
  pedidoInforme: 'Escribí el informe con el formato pedido. Las propuestas, concretas y con productos de los datos (con su id). Revisá antes de terminar que cada número que citás esté en los datos.',
  enPreguntas: 'Antes de proponer una promoción con números, probala con «simular_promocion».',
  armarFoto,
  detectar,
  ...juego([
    'consultar_ventas', 'consultar_rentabilidad', 'comparar_periodos', 'buscar_producto', 'consultar_stock', 'consultar_ofertas',
    'consultar_vencimientos', 'consultar_fechas', 'comprados_juntos', 'consultar_tienda_online', 'consultar_cupones', 'simular_promocion',
  ]),
  resumirInforme: (inf: any) => (inf ? `${resumirAlertas(inf)}\nPropuestas: ${(inf.propuestas ?? []).map((p: any) => p.titulo).join(' · ')}` : ''),
  /**
   * El sistema calcula cada propuesta (precio con la promoción, costo, margen)
   * con los precios y costos de hoy, y marca lo que no se puede crear tal cual.
   */
  async enriquecer(informe: any, f) {
    if (!informe?.propuestas?.length) return informe;
    /* Una detrás de otra: comparten la conexión. */
    const propuestas = await f.metricas.leer(async (c) => {
      const out: any[] = [];
      for (const p of informe.propuestas) out.push(await calcular(c, p));
      return out;
    });
    return { ...informe, propuestas };

    async function calcular(c: PoolClient, p: any) {
      const avisos: string[] = [];
      if (!diaValido(p.desde) || !diaValido(p.hasta) || p.hasta < p.desde) avisos.push('Las fechas no son válidas: revisalas al crearla.');
      if (p.dias && !/^[01]{7}$/.test(p.dias)) avisos.push('Los días de la semana no son válidos: se crea para todos los días.');
      let simulacion: any = null;
      try { simulacion = await simularPromo(f, c, promoDe(p)); } catch (e) { avisos.push(`No se pudo calcular: ${String((e as Error)?.message ?? e).slice(0, 120)}`); }
      return { ...p, simulacion, avisos: [...avisos, ...(simulacion?.avisos ?? [])] };
    }
  },
};
